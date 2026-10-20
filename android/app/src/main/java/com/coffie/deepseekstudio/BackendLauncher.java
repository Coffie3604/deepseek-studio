package com.coffie.deepseekstudio;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

/**
 * Everything that knows how to bring the Termux backend up, kept out of the
 * activity so {@link BootReceiver} can reuse it without instantiating a
 * WebView.
 *
 * Termux exposes a "run command in background" service. Calling it requires
 * the user to add this app to Termux's allow-external-apps allow-list
 * (~/.termux/termux.properties); every method here reports failure instead of
 * throwing so the UI can always fall back to "open Termux and type it".
 */
final class BackendLauncher {

    static final String TERMUX_PKG = "com.termux";
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";
    private static final String ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND";

    private static final String PREFS = "deepseek";
    private static final String KEY_AUTOSTART = "backend_autostart";

    /** Production checkout first, sandbox second — same order as the probe. */
    static final String START_CMD =
            "cd ~/projects/deepseek-editor 2>/dev/null || cd ~/projects/deepseek-editor-sandbox; "
            + "(node server.js >/dev/null 2>&1 &)";

    private static final String WORKDIR =
            "/data/data/com.termux/files/home/projects/deepseek-editor";
    private static final String BASH = "/data/data/com.termux/files/usr/bin/bash";

    private BackendLauncher() { }

    static boolean isTermuxInstalled(Context context) {
        return launchIntent(context, TERMUX_PKG) != null;
    }

    static boolean hasAutostart(Context context) {
        return prefs(context).getBoolean(KEY_AUTOSTART, false);
    }

    static void setAutostart(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_AUTOSTART, enabled).apply();
    }

    /** Result of a start attempt, so the caller can show the right hint. */
    enum StartResult {
        /** RUN_COMMAND accepted — backend should be up in ~2s. */
        STARTED,
        /** Termux is missing entirely. */
        NO_TERMUX,
        /** Termux is installed but refused the intent (allow-external-apps off). */
        DENIED
    }

    /**
     * Ask Termux to run the backend detached from any session.
     *
     * On Android 8+ a background service start from a non-foreground app is
     * restricted, so we try startForegroundService first and degrade to
     * startService. Both are wrapped because a SecurityException here is the
     * normal "allow-external-apps is off" signal.
     */
    static StartResult start(Context context) {
        if (!isTermuxInstalled(context)) return StartResult.NO_TERMUX;

        Intent run = new Intent();
        run.setClassName(TERMUX_PKG, TERMUX_SERVICE);
        run.setAction(ACTION_RUN_COMMAND);
        run.putExtra("com.termux.RUN_COMMAND_PATH", BASH);
        run.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-lc", START_CMD});
        run.putExtra("com.termux.RUN_COMMAND_WORKDIR", WORKDIR);
        run.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        run.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(run);
            } else {
                context.startService(run);
            }
            return StartResult.STARTED;
        } catch (Exception first) {
            try {
                context.startService(run);
                return StartResult.STARTED;
            } catch (Exception second) {
                return StartResult.DENIED;
            }
        }
    }

    /**
     * Best-effort deep link into Termux's own UI. Termux has no stable
     * "open and type this" API, but launching its home screen at least puts
     * the interpreter one tap away.
     */
    static boolean openTermux(Context context) {
        Intent i = launchIntent(context, TERMUX_PKG);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Last resort: send the user to the Termux F-Droid page. */
    static void openTermuxDownload(Activity activity) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://f-droid.org/packages/com.termux/")));
        } catch (Exception ignored) { }
    }

    /** Convenience for the F-Droid link from a non-activity context. */
    static void openTermuxDownload(Context context) {
        Intent i = new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://f-droid.org/packages/com.termux/"));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(i);
        } catch (Exception ignored) { }
    }

    private static Intent launchIntent(Context context, String pkg) {
        PackageManager pm = context.getPackageManager();
        if (pm == null) return null;
        try {
            return pm.getLaunchIntentForPackage(pkg);
        } catch (Exception e) {
            return null;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
