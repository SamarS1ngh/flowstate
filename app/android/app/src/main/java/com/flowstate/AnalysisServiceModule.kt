package com.flowstate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * JS bridge for AnalysisForegroundService -- exposed as
 * `NativeModules.AnalysisService`. The analysis loop (analyzer.ts) calls
 * start() when a batch begins, update() per song for the notification, and
 * stop() when the batch ends. Kept dead-simple: the reliability win is that
 * the service's own onStartCommand calls startForeground() synchronously, so
 * none of this depends on JS timing (unlike react-native-background-actions).
 *
 * Also exposes battery status (level + charging) so the analyzer can pause a
 * background batch when the phone is low and unplugged -- same pause/resume
 * shape as the Wi-Fi guard. A runtime BroadcastReceiver (ACTION_BATTERY_CHANGED
 * can't be declared in the manifest on modern Android) emits "flowstateBattery"
 * events on every change so JS can react without polling.
 */
class AnalysisServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var batteryReceiver: BroadcastReceiver? = null
    private var playbackWifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var playbackWakeLock: PowerManager.WakeLock? = null

    override fun getName(): String = "AnalysisService"

    // --- playback network locks ---------------------------------------
    // When the screen turns off / the app backgrounds, Android puts Wi-Fi into
    // power-save and throttles the app's CPU. That STALLS the network resolve
    // that every skip needs -- the request just hangs (measured 45s+), so
    // notification skips die after the pre-buffered songs run out. Holding a
    // Wi-Fi lock (radio stays active) + a partial wake lock (CPU stays awake for
    // the JS resolve) while music is playing keeps those background resolves
    // flowing, so skipping works indefinitely -- the same fix that made
    // background ANALYSIS reliable.
    @ReactMethod
    fun holdPlaybackLocks() {
        try {
            if (playbackWifiLock?.isHeld != true) {
                val wm = reactContext.applicationContext
                    .getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
                val mode =
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q)
                        android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    else @Suppress("DEPRECATION") android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                playbackWifiLock = wm?.createWifiLock(mode, "flowstate:playback-wifi")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
            if (playbackWakeLock?.isHeld != true) {
                val pm = reactContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
                playbackWakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flowstate:playback")
                    ?.apply {
                        setReferenceCounted(false)
                        acquire(6 * 60 * 60 * 1000L) // safety timeout; re-acquired on next play
                    }
            }
        } catch (_: Exception) {
        }
    }

    @ReactMethod
    fun releasePlaybackLocks() {
        try {
            playbackWifiLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        playbackWifiLock = null
        try {
            playbackWakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        playbackWakeLock = null
    }

    @ReactMethod
    fun start(title: String, text: String) {
        try {
            AnalysisForegroundService.start(reactContext, title, text)
        } catch (_: Exception) {
            // Starting can be disallowed if the app raced into the background;
            // analysis still proceeds (bare) in that case. Never crash JS.
        }
    }

    @ReactMethod
    fun update(title: String, text: String) {
        try {
            AnalysisForegroundService.update(reactContext, title, text)
        } catch (_: Exception) {
        }
    }

    @ReactMethod
    fun stop() {
        try {
            AnalysisForegroundService.stop(reactContext)
        } catch (_: Exception) {
        }
    }

    // --- battery-optimization exemption -------------------------------
    // Even with a foreground service + wake lock, a battery-OPTIMIZED app gets
    // its background threads throttled (App Standby), so on-device analysis
    // crawls when the screen is off. Exempting the app lets the OS run the
    // service at close to foreground speed while locked.

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            val pm = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            promise.resolve(pm.isIgnoringBatteryOptimizations(reactContext.packageName))
        } catch (_: Exception) {
            promise.resolve(true) // don't nag if we can't tell
        }
    }

    /** Opens the system prompt to exempt this app from battery optimization. */
    @ReactMethod
    fun requestIgnoreBatteryOptimizations() {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + reactContext.packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
        } catch (_: Exception) {
            // Fall back to the general battery-optimization settings list.
            try {
                reactContext.startActivity(
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: Exception) {
            }
        }
    }

    // --- battery ------------------------------------------------------

    private fun readBattery(intent: Intent?): WritableMap {
        val map = Arguments.createMap()
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging =
            status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) level.toDouble() / scale.toDouble() else 1.0
        map.putDouble("level", pct)
        map.putBoolean("charging", charging)
        return map
    }

    /** One-shot current battery state -- sticky ACTION_BATTERY_CHANGED intent. */
    @ReactMethod
    fun getBatteryStatus(promise: Promise) {
        try {
            val intent =
                reactContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            promise.resolve(readBattery(intent))
        } catch (e: Exception) {
            // Default optimistic (assume plugged & full) so a read failure never
            // wedges analysis off.
            val map = Arguments.createMap()
            map.putDouble("level", 1.0)
            map.putBoolean("charging", true)
            promise.resolve(map)
        }
    }

    private fun emitBattery(intent: Intent?) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("flowstateBattery", readBattery(intent))
        } catch (_: Exception) {
        }
    }

    /** Begin emitting "flowstateBattery" on every battery change. Idempotent. */
    @ReactMethod
    fun startBatteryUpdates() {
        if (batteryReceiver != null) return
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) = emitBattery(intent)
            }
        batteryReceiver = receiver
        try {
            reactContext.registerReceiver(
                receiver,
                IntentFilter(Intent.ACTION_BATTERY_CHANGED),
            )
        } catch (_: Exception) {
            batteryReceiver = null
        }
    }

    override fun invalidate() {
        releasePlaybackLocks()
        batteryReceiver?.let {
            try {
                reactContext.unregisterReceiver(it)
            } catch (_: Exception) {
            }
        }
        batteryReceiver = null
        super.invalidate()
    }

    // Required no-op listener hooks so RN doesn't warn about the module
    // lacking an event emitter interface when addListener/removeListeners
    // are (never) called from JS.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
