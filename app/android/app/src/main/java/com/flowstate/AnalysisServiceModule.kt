package com.flowstate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
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

    override fun getName(): String = "AnalysisService"

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
