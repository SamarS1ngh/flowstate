package com.flowstate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Alarms are cleared on reboot, so re-arm the nightly backup alarm on boot if the
 * user had it enabled.
 */
class BackupBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED &&
            BackupSchedulerModule.isEnabled(context)
        ) {
            BackupSchedulerModule.setAlarm(context)
        }
    }
}
