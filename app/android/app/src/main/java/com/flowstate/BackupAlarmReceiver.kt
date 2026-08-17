package com.flowstate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService

/**
 * Fired by the daily 2 AM AlarmManager alarm (BackupSchedulerModule). Grabs a
 * wake lock, starts the backup HeadlessJS service, and re-arms tomorrow's alarm
 * (exact alarms are one-shot).
 */
class BackupAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        try {
            // Keep the CPU up long enough for the headless task to spin up.
            HeadlessJsTaskService.acquireWakeLockNow(context)
            ContextCompat.startForegroundService(
                context,
                Intent(context, BackupTaskService::class.java),
            )
        } catch (_: Exception) {
            // If the service can't start (rare background-start restriction),
            // the rescheduled alarm below still tries again tomorrow.
        }
        // Reschedule for the next 2 AM.
        BackupSchedulerModule.setAlarm(context)
    }
}
