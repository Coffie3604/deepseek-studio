package com.coffie.deepseekstudio;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * DeepSeek Studio — Android shell.
 *
 * The real application is the local-first Node backend (server.js) running in
 * Termux on 127.0.0.1:3001. This activity is a thin, full-screen WebView that
 * hosts that UI, plus a friendly "backend not running" screen with a one-tap
 * way to start it.
 */
public class MainActivity extends Activity {

    /** Default backend. Override at runtime with: adb shell am start -e url http://... */
    private static final String DEFAULT_URL = "http://127.0.0.1:3001/";
    private static final String PREFS = "deepseek";
    private static final String KEY_URL = "backend_url";
    /** Termux package + the RUN_COMMAND service used to boot the backend. */
    private static final String TERMUX_PKG = "com.termux";
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";
    private static final String ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND";
    private static final String START_CMD =
            "cd ~/projects/deepseek-editor && (node server.js >/dev/null 2>&1 &)";

    private WebView webView;
    private ProgressBar progress;
    private LinearLayout errorView;
    private TextView errorDetail;
    private String startUrl;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        startUrl = DEFAULT_URL;

        // Allow an explicit URL override (handy for a LAN backend).
        Intent intent = getIntent();
        if (intent != null && intent.getStringExtra("url") != null) {
            startUrl = intent.getStringExtra("url");
            prefs.edit().putString(KEY_URL, startUrl).apply();
        } else if (prefs.getString(KEY_URL, null) != null) {
            startUrl = prefs.getString(KEY_URL, DEFAULT_URL);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d1117"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0d1117"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        root.addView(progress, plp);

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();
        webView.loadUrl(startUrl);
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Keep the WebView's own storage (localStorage, IndexedDB) persistent.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
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
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                errorView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only react to the main document failing, not a stray asset.
                if (request.isForMainFrame()) {
                    showError(String.valueOf(error.getDescription()));
                }
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showError(description);
            }
        });
    }

    /** External links open in the browser; local backend links stay in the WebView. */
    private boolean handleUrl(String url) {
        if (url == null) return false;
        boolean local = url.startsWith("http://127.0.0.1")
                || url.startsWith("http://localhost")
                || url.startsWith("file://");
        if (local) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // No browser installed — swallow rather than crash.
        }
        return true;
    }

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(android.view.Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#0d1117"));
        int pad = dp(28);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Backend not reachable");
        title.setTextColor(Color.parseColor("#e6edf3"));
        title.setTextSize(22f);
        title.setGravity(android.view.Gravity.CENTER);

        TextView hint = new TextView(this);
        hint.setText("DeepSeek Studio runs on Termux.\nStart it, then tap Retry.");
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
        retry.setText("Retry");
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(startUrl);
        });

        Button startBackend = new Button(this);
        startBackend.setText("Start backend");
        startBackend.setOnClickListener(v -> startBackend());

        Button openTermux = new Button(this);
        openTermux.setText("Open Termux");
        openTermux.setOnClickListener(v -> {
            Intent i = getPackageManager().getLaunchIntentForPackage("com.termux");
            if (i != null) {
                startActivity(i);
            } else {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse("https://f-droid.org/packages/com.termux/")));
                } catch (Exception ignored) { }
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
     * Boot the Node backend through Termux's RUN_COMMAND service. Requires
     * "allow-external-apps=true" in ~/.termux/termux.properties; when that is
     * not set we fall back to just opening Termux so the user can type it.
     */
    private void startBackend() {
        Intent run = new Intent();
        run.setClassName(TERMUX_PKG, TERMUX_SERVICE);
        run.setAction(ACTION_RUN_COMMAND);
        run.putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash");
        run.putExtra("com.termux.RUN_COMMAND_ARGUMENTS",
                new String[]{"-lc", START_CMD});
        run.putExtra("com.termux.RUN_COMMAND_WORKDIR",
                "/data/data/com.termux/files/home/projects/deepseek-editor");
        run.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        run.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
        try {
            startService(run);
            errorDetail.setText("Starting backend…");
            // Give node a moment to bind the port, then retry automatically.
            webView.postDelayed(() -> {
                errorView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                webView.loadUrl(startUrl);
            }, 2500);
        } catch (Exception e) {
            // RUN_COMMAND not permitted — open Termux instead.
            Intent i = getPackageManager().getLaunchIntentForPackage(TERMUX_PKG);
            if (i != null) {
                try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
            }
            errorDetail.setText("Enable allow-external-apps in ~/.termux/termux.properties");
        }
    }

    private void showError(String detail) {
        progress.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        errorDetail.setText(detail == null ? "" : detail);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
