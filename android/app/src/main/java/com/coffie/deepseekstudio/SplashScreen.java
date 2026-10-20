package com.coffie.deepseekstudio;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * Cold-start splash.
 *
 * Rendered as the activity's content view while the WebView boots behind it,
 * then cross-faded out. It is intentionally built from plain views (no
 * layouts, no AndroidX) because the whole APK is compiled with `javac` +
 * `d8` on Termux — see scripts/build-apk.sh.
 *
 * The splash is also the *only* place a user waits, so it carries the boot
 * status: "starting backend…", "using offline UI", and the retry hint.
 */
final class SplashScreen {

    private static final int BG = Color.parseColor("#0d1117");
    private static final int FG = Color.parseColor("#e6edf3");
    private static final int MUTED = Color.parseColor("#8b949e");
    private static final int ACCENT = Color.parseColor("#58a6ff");

    private final Activity activity;
    private final LaunchState state;
    private final FrameLayout wrapper;

    private final TextView status;
    private final ProgressBar bar;
    private ObjectAnimator pulse;
    private boolean removed = false;

    SplashScreen(Activity activity, LaunchState state) {
        this.activity = activity;
        this.state = state;

        wrapper = new FrameLayout(activity);
        wrapper.setBackgroundColor(BG);
        wrapper.setClickable(true); // swallow taps while booting

        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(32);
        column.setPadding(pad, 0, pad, 0);

        ImageView logo = new ImageView(activity);
        logo.setImageResource(R.mipmap.ic_launcher);
        int logoSize = dp(96);
        LinearLayout.LayoutParams logoLp = new LinearLayout.LayoutParams(logoSize, logoSize);
        logoLp.bottomMargin = dp(20);
        column.addView(logo, logoLp);

        TextView title = new TextView(activity);
        title.setText(R.string.app_name);
        title.setTextColor(FG);
        title.setTextSize(24f);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        column.addView(title);

        TextView tagline = new TextView(activity);
        tagline.setText(R.string.splash_tagline);
        tagline.setTextColor(MUTED);
        tagline.setTextSize(13f);
        tagline.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tagLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tagLp.topMargin = dp(6);
        tagLp.bottomMargin = dp(28);
        column.addView(tagline, tagLp);

        bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(0);
        GradientDrawable track = new GradientDrawable();
        track.setColor(Color.parseColor("#21262d"));
        track.setCornerRadius(dp(3));
        bar.setProgressDrawable(track);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(dp(180), dp(5));
        barLp.bottomMargin = dp(18);
        column.addView(bar, barLp);

        status = new TextView(activity);
        status.setTextColor(ACCENT);
        status.setTextSize(12.5f);
        status.setGravity(Gravity.CENTER);
        status.setText(R.string.splash_booting);
        column.addView(status);

        wrapper.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));

        // Subtle breathing animation so a slow probe never looks hung.
        pulse = ObjectAnimator.ofFloat(bar, View.ALPHA, 1f, 0.45f);
        pulse.setDuration(900);
        pulse.setRepeatMode(ValueAnimator.REVERSE);
        pulse.setRepeatCount(ValueAnimator.INFINITE);
        pulse.setInterpolator(new DecelerateInterpolator());
        pulse.start();

        // Honour a state that was already progressed before we were attached.
        apply(state);
    }

    View view() {
        return wrapper;
    }

    /** Push the current {@link LaunchState} into the views. UI thread only. */
    void apply(LaunchState snapshot) {
        if (removed) return;
        bar.setProgress(snapshot.progress);
        switch (snapshot.phase) {
            case BOOTING:
                status.setTextColor(ACCENT);
                status.setText(snapshot.detail.isEmpty()
                        ? activity.getString(R.string.splash_booting)
                        : snapshot.detail);
                break;
            case ONLINE:
                status.setTextColor(ACCENT);
                status.setText(snapshot.detail.isEmpty()
                        ? activity.getString(R.string.splash_online)
                        : snapshot.detail);
                break;
            case OFFLINE:
                status.setTextColor(Color.parseColor("#d29922"));
                status.setText(snapshot.detail.isEmpty()
                        ? activity.getString(R.string.splash_offline)
                        : snapshot.detail);
                break;
            case FAILED:
            default:
                status.setTextColor(Color.parseColor("#f85149"));
                status.setText(snapshot.detail.isEmpty()
                        ? activity.getString(R.string.error_detail_default)
                        : snapshot.detail);
                break;
        }
    }

    /** Stop animating and detach. Safe to call twice. */
    void dismiss(ViewGroup parent, Runnable onDone) {
        if (removed) {
            if (onDone != null) onDone.run();
            return;
        }
        removed = true;
        state.dismissed = true;
        if (pulse != null) {
            pulse.cancel();
            pulse = null;
        }
        if (parent == null) {
            wrapper.setVisibility(View.GONE);
            if (onDone != null) onDone.run();
            return;
        }
        wrapper.animate()
                .alpha(0f)
                .setDuration(220)
                .setInterpolator(new DecelerateInterpolator())
                .withEndAction(() -> {
                    parent.removeView(wrapper);
                    if (onDone != null) onDone.run();
                })
                .start();
        // Belt and braces: if the animation is interrupted (activity paused),
        // make sure the splash still goes away.
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (wrapper.getParent() != null) {
                parent.removeView(wrapper);
                if (onDone != null) onDone.run();
            }
        }, 900);
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
