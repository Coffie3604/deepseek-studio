package com.coffie.deepseekstudio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Optional boot hook.
 *
 * Termux runs its own boot receiver (if termux-boot is installed), so this is
 * deliberately conservative: it never forks a process or touches the network
 * itself. It only *nudges* Termux to start the backend when the user has
 * already made that choice once (BackendLauncher.hasAutostart()), which keeps
 * launch latency and battery cost at zero for everyone else.
 *
 * Registered with android:exported="false" in the manifest so no other app can
 * trigger it.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        if (!BackendLauncher.hasAutostart(context)) return;
        // Fail silently: at boot Termux may not have finished initialising.
        BackendLauncher.start(context);
    }
}
