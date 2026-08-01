package com.flowstate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Minimal, reliable foreground service for on-device analysis.
 *
 * WHY THIS EXISTS: react-native-background-actions started its foreground
 * service from JS and its startForeground() call raced Android 14/15's "must
 * call startForeground() within 5s of startForegroundService()" rule whenever
 * the JS/bridge was busy (which it always is right as analysis kicks off) --
 * intermittently crashing the whole app with
 * ForegroundServiceDidNotStartInTimeException. This service instead calls
 * startForeground() SYNCHRONOUSLY inside onStartCommand (pure native, no JS
 * timing), so the window can never be missed. The analysis loop itself still
 * runs in JS (analyzer.ts); this service only keeps the process foregrounded
 * so Android doesn't suspend/kill it while the app is backgrounded.
 *
 * Controlled via startService intents with an ACTION extra: START (with a
 * title/text), UPDATE (new text), STOP.
 */
class AnalysisForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.getStringExtra(EXTRA_ACTION)) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Analyzing your music"
                val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
                // MUST be called synchronously here (within 5s of the
                // startForegroundService that triggered this) -- this is the
                // whole point of the native service.
                startForegroundCompat(buildNotification(this, title, text))
            }
        }
        return START_STICKY
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        const val CHANNEL_ID = "flowstate_analysis"
        const val NOTIF_ID = 4021
        const val EXTRA_ACTION = "action"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val ACTION_START = "START"
        const val ACTION_STOP = "STOP"

        fun start(context: Context, title: String, text: String) {
            val i = Intent(context, AnalysisForegroundService::class.java)
                .putExtra(EXTRA_ACTION, ACTION_START)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        /** Update the notification text WITHOUT touching the service (avoids
         * background-service-start restrictions for per-song progress ticks). */
        fun update(context: Context, title: String, text: String) {
            val mgr = context.getSystemService(NotificationManager::class.java) ?: return
            mgr.notify(NOTIF_ID, buildNotification(context, title, text))
        }

        fun stop(context: Context) {
            val i = Intent(context, AnalysisForegroundService::class.java)
                .putExtra(EXTRA_ACTION, ACTION_STOP)
            context.startService(i)
        }

        fun buildNotification(context: Context, title: String, text: String): Notification {
            ensureChannel(context)
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pending = launch?.let {
                PendingIntent.getActivity(
                    context,
                    0,
                    it,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            }
            return Notification.Builder(context, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setContentIntent(pending)
                .build()
        }

        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val mgr = context.getSystemService(NotificationManager::class.java) ?: return
                if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
                    mgr.createNotificationChannel(
                        NotificationChannel(
                            CHANNEL_ID,
                            "Music analysis",
                            NotificationManager.IMPORTANCE_LOW,
                        ).apply { setShowBadge(false) },
                    )
                }
            }
        }
    }
}
