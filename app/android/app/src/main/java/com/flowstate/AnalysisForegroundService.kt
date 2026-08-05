package com.flowstate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import android.os.PowerManager

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
class AnalysisForegroundService : HeadlessJsTaskService() {
    // Runs the JS analysis loop as a HEADLESS JS TASK (not the normal app JS
    // instance). RN keeps the JS runtime alive for a headless task while its
    // promise is pending -- which is what lets the loop keep issuing work when
    // the app is backgrounded / the screen is off (the normal app JS gets
    // starved there, so the loop stalled after 1-2 songs). The heavy work
    // (decode/mel/TFLite) was already fine in the background; only the JS loop
    // driving it needed to stay awake.
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        if (intent?.getStringExtra(EXTRA_ACTION) == ACTION_STOP) return null
        // timeout 0 = run until the task's own promise resolves (batch done /
        // paused / cancelled); allowedInForeground = true so it also runs while
        // the app is open.
        return HeadlessJsTaskConfig("flowstateAnalysis", Arguments.createMap(), 0, true)
    }

    // Partial wake lock held for the service's lifetime. A foreground service
    // stops Android from KILLING the process, but it does NOT keep the CPU
    // awake once the screen is off -- and analysis is pure CPU work (audio
    // decode + TFLite). Without this, a locked screen dozes the CPU and the JS
    // analysis loop stalls until unlock. This keeps the CPU running.
    private var wakeLock: PowerManager.WakeLock? = null
    // Wi-Fi lock held for the service's lifetime. When the screen turns off,
    // Android puts Wi-Fi into power-save (and some OEMs drop the connection),
    // which makes the "Wi-Fi only" analysis guard PAUSE the batch -- so analysis
    // barely moves while locked. This keeps the Wi-Fi radio active so downloads
    // keep flowing.
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.getStringExtra(EXTRA_ACTION) == ACTION_STOP) {
            releaseWakeLock()
            releaseWifiLock()
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Analyzing your music"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
        // MUST be called synchronously here (within 5s of the
        // startForegroundService that triggered this).
        startForegroundCompat(buildNotification(this, title, text))
        acquireWakeLock()
        acquireWifiLock()
        // Kick the headless JS task (getTaskConfig above provides its config).
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        releaseWifiLock()
        super.onDestroy()
    }

    private fun acquireWifiLock() {
        if (wifiLock?.isHeld == true) return
        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE)
                as? android.net.wifi.WifiManager ?: return
            val mode =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                else
                    @Suppress("DEPRECATION") android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
            val wl = wm.createWifiLock(mode, "flowstate:analysis-wifi")
            wl.setReferenceCounted(false)
            wl.acquire()
            wifiLock = wl
        } catch (_: Exception) {
            // Wi-Fi lock is best-effort; never crash the service over it.
        }
    }

    private fun releaseWifiLock() {
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flowstate:analysis")
        wl.setReferenceCounted(false)
        // Safety timeout so a missed STOP (crash) can never hold the CPU forever;
        // a real batch re-acquires on each START/UPDATE well within this.
        wl.acquire(6 * 60 * 60 * 1000L)
        wakeLock = wl
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
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
