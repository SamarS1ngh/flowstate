package com.flowstate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the 'flowstateBackup' HeadlessJS task (drive.ts runNightlyBackup) that
 * uploads vibes.db to Google Drive. Started by BackupAlarmReceiver at ~2 AM. A
 * brief foreground notification satisfies Android's background-start rules and
 * keeps the short upload from being killed. RN keeps the JS runtime alive while
 * the task's promise is pending (same mechanism as background analysis), which
 * is also what lets its network calls run with the app closed.
 */
class BackupTaskService : HeadlessJsTaskService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        super.onStartCommand(intent, flags, startId)
        return START_NOT_STICKY
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        // 2-minute cap: a few-MB upload is quick; if it hangs, don't linger.
        // allowedInForeground=false: this path is the background alarm only.
        HeadlessJsTaskConfig("flowstateBackup", Arguments.createMap(), 120_000, false)

    private fun startForegroundCompat() {
        val channelId = "flowstate_backup"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(channelId, "Backup", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val notification: Notification =
            NotificationCompat.Builder(this, channelId)
                .setContentTitle("flowstate")
                .setContentText("Backing up your analysis data…")
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    companion object {
        private const val NOTIF_ID = 71011
    }
}
