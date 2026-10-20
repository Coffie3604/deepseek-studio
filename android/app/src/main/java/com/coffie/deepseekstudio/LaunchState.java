package com.coffie.deepseekstudio;

/**
 * Mutable hand-off between a {@link SplashScreen} and its host
 * {@link MainActivity}.
 *
 * A WebView takes 200-600ms to inflate + start its renderer on a mid-range
 * phone, and the app may additionally wait up to ~1.6s probing for a backend.
 * Showing the splash as its own window during that time removes the black
 * flash on cold start. Because MainActivity can be recreated (rotation, theme
 * change) while the splash is still visible, the splash writes its state onto
 * this object rather than into the (possibly replaced) activity.
 */
final class LaunchState {

    /** Outcome of the boot sequence. */
    enum Phase {
        /** Still probing / starting the backend. */
        BOOTING,
        /** A backend answered /api/health; the live UI is loading. */
        ONLINE,
        /** No backend; the bundled offline UI is loading. */
        OFFLINE,
        /** Even the bundled UI failed — this needs a human. */
        FAILED
    }

    Phase phase = Phase.BOOTING;
    /** Which URL the probe settled on (or the one we are about to try). */
    String baseUrl;
    /** Human-readable status line for the splash. */
    String detail = "";
    /** 0..100 overall progress, driven by the probe and the WebView. */
    int progress = 0;
    /** Set once the splash has been dismissed; prevents a late redraw. */
    boolean dismissed = false;

    void set(Phase next, String detailText, int progressPercent) {
        phase = next;
        if (detailText != null) detail = detailText;
        if (progressPercent >= 0) progress = Math.max(0, Math.min(100, progressPercent));
    }
}
