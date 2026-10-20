package com.coffie.deepseekstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DeepSeek Studio — Android shell.
 *
 * The real application is the local-first Node backend (server.js) running in
 * Termux on 127.0.0.1:3001. This activity is a thin, full-screen WebView that
 * hosts that UI, plus:
 *
 *  - a branded splash while the backend probe runs (no black flash),
 *  - a friendly "backend not running" screen with a one-tap way to start it,
 *  - graceful degradation to the UI bundled inside the APK,
 *  - hardware back mapped onto the web UI's own navigation stack.
 */
public class MainActivity extends Activity {

    /**
     * The web UI bundled inside the APK (public/ copied by
     * scripts/sync-android-assets.sh). Used when the Termux backend is not
     * running so the app still opens instead of showing a dead end.
     */
    private static final String OFFLINE_URL = "file:///android_asset/www/index.html";

    /**
     * How long the bundled UI may take before the hard-error screen appears.
     * Without this, a corrupt asset bundle would leave the splash spinning
     * forever — Android still kills the app with an ANR, but the user gets a
     * readable explanation first.
     */
    private static final int OFFLINE_GRACE_MS = 6000;

    /** Saved-instance keys for surviving rotation / process death. */
    private static final String STATE_WEBVIEW_URL = "webview_url";
    private static final String STATE_OFFLINE = "offline_mode";

    /** Runtime permissions worth asking for up front, never blocking boot. */
    private static final int REQ_PERMS = 0x0D5;
    private static final String[] STARTUP_PERMISSIONS = {
            android.Manifest.permission.POST_NOTIFICATIONS,
    };

    private WebView webView;
    /** Native replacement for Termux:API - exposed to JS as window.AndroidDevice. */
    private DeviceBridge deviceBridge;
    private FrameLayout root;
    private LinearLayout errorView;
    private TextView errorDetail;
    private SplashScreen splash;
    private LaunchState launchState;
    private String startUrl;
    /** True while the WebView is showing the bundled offline UI. */
    private boolean offlineMode = false;
    /** Guards against a double back press racing the async JS reply. */
    private final AtomicBoolean backPending = new AtomicBoolean(false);
    /** Set once any page — live backend or bundled asset — has painted. */
    private boolean hasLoadedSomething = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        askForRuntimePermissions();

        launchState = new LaunchState();
        Intent intent = getIntent();
        String override = intent == null ? null : intent.getStringExtra("url");

        // Restore what the user was looking at after a rotation or a
        // low-memory process restart. Without this the activity re-ran the
        // whole probe and yanked the WebView back to the start page, losing
        // editor scroll position, unsaved tabs and the current file.
        if (savedInstanceState != null) {
            String restored = savedInstanceState.getString(STATE_WEBVIEW_URL);
            int restoredOffline = savedInstanceState.getInt(STATE_OFFLINE, 0);
            if (restored != null && restored.length() > 0) {
                offlineMode = restoredOffline == 1;
                hasLoadedSomething = true;
                startUrl = restored;
            }
        }
        // Also covers a saved bundle that carried no URL: always have a target.
        if (startUrl == null) {
            startUrl = BackendConfig.resolveStartUrl(this, override);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0d1117);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0d1117);
        // Hidden until a page paints behind the splash — an empty WebView
        // renders white for one frame otherwise.
        webView.setVisibility(View.INVISIBLE);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();

        // Splash sits on top while the backend probe (up to ~1.6s) and the
        // first page load happen, so the app never shows a blank window.
        splash = new SplashScreen(this, launchState);
        root.addView(splash.view(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // A restored session goes straight back to the page it was on; only a
        // cold start pays for the probe.
        if (savedInstanceState != null && hasLoadedSomething && startUrl != null) {
            launchState.set(LaunchState.Phase.BOOTING,
                    getString(R.string.splash_connecting, startUrl), 50);
            pushLaunchState();
            webView.loadUrl(startUrl);
        } else if (override != null) {
            launchState.set(LaunchState.Phase.BOOTING,
                    getString(R.string.splash_connecting, startUrl), 20);
            pushLaunchState();
            webView.loadUrl(startUrl);
        } else {
            probeAndLoad();
        }
    }

    /**
     * Probe the candidate backends in order and load the first one that
     * answers /api/health. Falls through to the bundled offline UI if none do,
     * so the app always opens to something usable.
     */
    private void probeAndLoad() {
        launchState.set(LaunchState.Phase.BOOTING,
                getString(R.string.splash_probing, BackendConfig.PORTS), 12);
        pushLaunchState();
        probeNext(0);
    }

    private void probeNext(final int index) {
        if (index >= BackendConfig.CANDIDATE_URLS.length) {
            // Nothing listening — show the bundled UI, which offers Retry /
            // Start backend in its banner.
            startUrl = BackendConfig.CANDIDATE_URLS[0];
            loadOffline(getString(R.string.splash_no_backend, BackendConfig.PORTS));
            return;
        }
        final String base = BackendConfig.CANDIDATE_URLS[index];
        launchState.set(LaunchState.Phase.BOOTING,
                getString(R.string.splash_connecting, base), 15 + index * 20);
        pushLaunchState();

        final String health = base + "api/health";
        new Thread(() -> {
            boolean reachable = false;
            java.net.HttpURLConnection conn = null;
            try {
                conn = (java.net.HttpURLConnection) new java.net.URL(health).openConnection();
                conn.setConnectTimeout(700);
                conn.setReadTimeout(900);
                conn.setRequestMethod("GET");
                reachable = conn.getResponseCode() == 200;
            } catch (Exception ignored) {
                reachable = false;
            } finally {
                if (conn != null) conn.disconnect();
            }
            final boolean ok = reachable;
            runOnUiThread(() -> {
                if (isFinishing() || webView == null) return;
                if (ok) {
                    startUrl = base;
                    BackendConfig.remember(MainActivity.this, base);
                    launchState.set(LaunchState.Phase.ONLINE,
                            getString(R.string.splash_online), 60);
                    pushLaunchState();
                    webView.loadUrl(startUrl);
                } else {
                    probeNext(index + 1);
                }
            });
        }, "ds-probe-" + index).start();
    }

    /**
     * Load the UI bundled in the APK. The app stays usable (read-only, no
     * backend features) and its banner offers Retry / Start backend.
     */
    private void loadOffline(String reason) {
        offlineMode = true;
        launchState.set(LaunchState.Phase.OFFLINE, reason, 65);
        pushLaunchState();
        webView.loadUrl(OFFLINE_URL);
        // A corrupt asset bundle would otherwise spin forever: give the
        // offline shell a deadline, then show the recovery screen.
        root.postDelayed(() -> {
            if (!hasLoadedSomething && webView != null && !isFinishing()
                    && errorView.getVisibility() != View.VISIBLE) {
                showFatalError(getString(R.string.error_offline_failed));
            }
        }, OFFLINE_GRACE_MS);
    }

    @SuppressWarnings("deprecation")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // The bundled shell is loaded over file:// and pulls its own ES
        // modules; without this those fetches can fail silently.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Persist cookies (session tokens, "keep me signed in") across restarts.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        // Native Android bridge: replaces the Termux:API app entirely.
        // JS calls window.AndroidDevice.<method>(json) -> JSON string.
        deviceBridge = new DeviceBridge(this, webView);
        // Deny-by-default: only flipped true once a trusted page starts
        // loading, so nothing can reach the device API during boot.
        deviceBridge.setTrustedOrigin(false);
        webView.addJavascriptInterface(deviceBridge, "AndroidDevice");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                // Keep the WebView's own storage (localStorage, IndexedDB)
                // persistent while driving the splash progress bar.
                if (launchState.dismissed || splash == null) return;
                int mapped = Math.max(launchState.progress,
                        60 + Math.round(newProgress * 0.4f));
                launchState.progress = Math.min(100, mapped);
                pushLaunchState();
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage msg) {
                if (msg != null) {
                    android.util.Log.d("DeepSeekUI", msg.message()
                            + " @" + msg.sourceId() + ":" + msg.lineNumber());
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // Gate the device bridge on the page that is actually loading,
                // before its scripts run. A remote page reached by a redirect
                // must not keep clipboard/torch/volume access.
                if (deviceBridge != null) {
                    deviceBridge.setTrustedOrigin(DeviceBridge.isTrustedOrigin(url));
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hasLoadedSomething = true;
                errorView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                backPending.set(false);
                offlineMode = url != null && url.startsWith("file://");
                if (!offlineMode && url != null) BackendConfig.remember(MainActivity.this, url);
                launchState.set(offlineMode ? LaunchState.Phase.OFFLINE
                        : LaunchState.Phase.ONLINE,
                        offlineMode ? getString(R.string.splash_offline) : null, 100);
                pushLaunchState();
                dismissSplash();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only react to the main document failing, not a stray asset.
                if (request == null || !request.isForMainFrame()) return;
                onMainFrameFailure(String.valueOf(error.getDescription()));
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                onMainFrameFailure(description);
            }
        });
    }

    private void onMainFrameFailure(String detail) {
        if (isFinishing() || webView == null) return;
        if (offlineMode) {
            // The bundled UI itself failed — nothing left to fall back to.
            showFatalError(detail);
        } else {
            // Live backend died mid-session. Offer the offline shell rather
            // than a blank screen.
            loadOffline(getString(R.string.splash_no_backend, BackendConfig.PORTS));
        }
    }

    /**
     * External links (docs, GitHub, F-Droid) open in the browser; anything
     * pointing at the local backend or the APK assets stays inside the app.
     */
    private boolean handleUrl(String url) {
        if (url == null) return false;
        boolean local = url.startsWith("http://127.0.0.1")
                || url.startsWith("http://localhost")
                || url.startsWith("file://")
                || url.startsWith("about:")
                || url.startsWith("blob:")
                || url.startsWith("data:");
        if (local) return false;
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(view);
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.no_browser));
        } catch (Exception ignored) {
            // Never crash the shell because of a malformed link.
        }
        return true;
    }

    /* ------------------------------------------------------------------ */
    /*  Splash plumbing                                                    */
    /* ------------------------------------------------------------------ */

    /** Copy the shared LaunchState into the splash views (UI thread). */
    private void pushLaunchState() {
        if (splash != null) splash.apply(launchState);
    }

    /** Fade the splash away and focus the WebView. Idempotent. */
    private void dismissSplash() {
        if (splash == null) return;
        final SplashScreen target = splash;
        splash = null; // later calls become no-ops
        target.dismiss(root, () -> {
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
                webView.requestFocus();
            }
        });
    }

    /**
     * Hard failure: neither the backend nor the bundled UI could be shown.
     * Leaves the recovery buttons on screen instead of a blank window.
     */
    private void showFatalError(String detail) {
        if (splash != null) {
            launchState.set(LaunchState.Phase.FAILED, detail, 100);
            pushLaunchState();
            dismissSplash();
        }
        if (webView != null) webView.setVisibility(View.GONE);
        if (errorDetail != null) errorDetail.setText(detail == null ? "" : detail);
        errorView.setVisibility(View.VISIBLE);
    }

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(android.view.Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0d1117"));
        int pad = dp(28);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.error_title);
        title.setTextColor(Color.parseColor("#e6edf3"));
        title.setTextSize(22f);
        title.setGravity(android.view.Gravity.CENTER);

        TextView hint = new TextView(this);
        hint.setText(R.string.error_hint);
        hint.setTextColor(Color.parseColor("#8b949e"));
        hint.setTextSize(14f);
        hint.setGravity(android.view.Gravity.CENTER);
        hint.setPadding(0, dp(12), 0, dp(20));

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.parseColor("#f85149"));
        errorDetail.setTextSize(12f);
        errorDetail.setGravity(android.view.Gravity.CENTER);
        errorDetail.setPadding(0, 0, 0, dp(20));

        Button retry = new Button(this);
        retry.setText(R.string.action_retry);
        retry.setOnClickListener(v -> retryBoot());

        Button startBackend = new Button(this);
        startBackend.setText(R.string.action_start_backend);
        startBackend.setOnClickListener(v -> startBackend());

        Button openTermux = new Button(this);
        openTermux.setText(R.string.action_open_termux);
        openTermux.setOnClickListener(v -> {
            if (!BackendLauncher.openTermux(this)) {
                BackendLauncher.openTermuxDownload(this);
            }
        });

        box.addView(title);
        box.addView(hint);
        box.addView(errorDetail);
        box.addView(retry);
        box.addView(startBackend);
        box.addView(openTermux);
        return box;
    }

    /**
     * Full re-boot: re-probe both known ports before falling back, so tapping
     * Retry after starting the backend actually reconnects.
     */
    private void retryBoot() {
        errorView.setVisibility(View.GONE);
        offlineMode = false;
        hasLoadedSomething = false;
        if (webView != null) webView.setVisibility(View.INVISIBLE);
        launchState = new LaunchState();
        pushLaunchState();
        probeAndLoad();
    }

    /**
     * Boot the Node backend through Termux's RUN_COMMAND service. Requires
     * "allow-external-apps=true" in ~/.termux/termux.properties; when that is
     * not set we fall back to just opening Termux so the user can type it.
     */
    private void startBackend() {
        switch (BackendLauncher.start(this)) {
            case STARTED:
                errorDetail.setText(R.string.starting_backend);
                // Give node a moment to bind the port, then re-probe silently.
                root.postDelayed(this::retryBoot, 2500);
                break;
            case NO_TERMUX:
                errorDetail.setText(R.string.termux_missing);
                BackendLauncher.openTermuxDownload(this);
                break;
            case DENIED:
            default:
                if (!BackendLauncher.openTermux(this)) {
                    errorDetail.setText(R.string.termux_missing);
                } else {
                    errorDetail.setText(R.string.termux_allow_external);
                }
                break;
        }
    }

    /**
     * Ask for the runtime permissions the native bridge needs.
     *
     * Done fire-and-forget after the UI is up: a denied notification prompt
     * must never stop the editor from opening, and every bridge method already
     * degrades to a JSON error when a grant is missing.
     */
    private void askForRuntimePermissions() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
            // POST_NOTIFICATIONS only exists from Android 13; below that it is
            // granted at install time.
            return;
        }
        java.util.List<String> missing = new java.util.ArrayList<>();
        for (String p : STARTUP_PERMISSIONS) {
            if (checkSelfPermission(p) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                missing.add(p);
            }
        }
        if (missing.isEmpty()) return;
        try {
            requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
        } catch (Exception ignored) {
            // Some OEMs throw here if the activity is not yet resumed.
        }
    }

    /**
     * Persist the page so a recreate does not restart the whole boot flow.
     * The WebView restores its own history; we only need the current URL and
     * which mode we were in.
     */
    @Override
    protected void onResume() {
        super.onResume();
        // Re-assert the bridge gate against whatever page is actually loaded.
        // Returning from the browser or a share sheet must not leave the
        // device API enabled for an unexpected document.
        if (deviceBridge != null && webView != null) {
            deviceBridge.setTrustedOrigin(DeviceBridge.isTrustedOrigin(webView.getUrl()));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        try {
            if (webView != null && webView.getUrl() != null) {
                outState.putString(STATE_WEBVIEW_URL, webView.getUrl());
            } else if (startUrl != null) {
                outState.putString(STATE_WEBVIEW_URL, startUrl);
            }
            outState.putInt(STATE_OFFLINE, offlineMode ? 1 : 0);
        } catch (Exception ignored) {
            // Never let bookkeeping take the app down.
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /**
     * Hardware/gesture back.
     *
     * The web UI keeps its own navigation stack (modal -> drawer -> side panel
     * -> primary tab -> file) and exposes window.DS.navBack(). We ask the page
     * first so back behaves exactly like the browser/PWA build; only when the
     * page says "nothing left to close" do we fall back to WebView history and
     * finally to leaving the activity.
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (!backPending.compareAndSet(false, true)) return; // reply already in flight
        webView.evaluateJavascript(
                "(function(){try{return (window.DS&&window.DS.navBack)?window.DS.navBack():'none';}"
                        + "catch(e){return 'none';}})()",
                value -> {
                    backPending.set(false);
                    String v = value == null ? "none" : value.replace("\"", "").trim();
                    if ("handled".equals(v)) return;
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                        return;
                    }
                    // Splash still up? first back press just clears it.
                    if (splash != null) {
                        dismissSplash();
                        return;
                    }
                    finish();
                });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask activity: an `am start -e url ...` while running should
        // retarget the WebView instead of being silently dropped.
        if (intent != null && intent.getStringExtra("url") != null && webView != null) {
            String target = BackendConfig.resolveStartUrl(this, intent.getStringExtra("url"));
            startUrl = target;
            offlineMode = false;
            errorView.setVisibility(View.GONE);
            webView.loadUrl(target);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            onBackPressed();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (deviceBridge != null) {
            deviceBridge.release();
            deviceBridge = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidDevice");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
