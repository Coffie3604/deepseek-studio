package com.coffie.deepseekstudio;

import android.app.Activity;
import android.content.SharedPreferences;

/**
 * Single source of truth for "which backend URL are we showing".
 *
 * The activity used to read the URL override out of the launch Intent inline,
 * which meant a second instance (or a re-launch after the process was killed)
 * could disagree with the persisted value. Every read/write now goes here.
 */
final class BackendConfig {

    /**
     * Probed in order on first launch.
     *
     * 3001 = production (deepseek-editor), 3002 = sandbox
     * (deepseek-editor-sandbox). Probing makes one APK work against either
     * checkout instead of hardcoding one port.
     */
    static final String[] CANDIDATE_URLS = {
            "http://127.0.0.1:3001/",
            "http://127.0.0.1:3002/",
    };

    /** Ports only, for the "try these ports" copy in the UI. */
    static final String PORTS = "3001 / 3002";

    private static final String PREFS = "deepseek";
    private static final String KEY_URL = "backend_url";

    private BackendConfig() { }

    private static SharedPreferences prefs(Activity activity) {
        return activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    /** The URL to try first: an explicit override, else the last good one. */
    static String resolveStartUrl(Activity activity, String intentUrl) {
        if (intentUrl != null && intentUrl.trim().length() > 0) {
            String normalized = normalize(intentUrl.trim());
            prefs(activity).edit().putString(KEY_URL, normalized).apply();
            return normalized;
        }
        String saved = prefs(activity).getString(KEY_URL, null);
        if (saved != null && saved.trim().length() > 0) return normalize(saved.trim());
        return CANDIDATE_URLS[0];
    }

    static void remember(Activity activity, String url) {
        prefs(activity).edit().putString(KEY_URL, normalize(url)).apply();
    }

    /** Guarantees a scheme and a trailing slash so `base + "api/health"` works. */
    static String normalize(String url) {
        String out = url;
        if (!out.startsWith("http://") && !out.startsWith("https://")) {
            out = "http://" + out;
        }
        if (!out.endsWith("/")) out = out + "/";
        return out;
    }
}
