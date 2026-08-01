package com.flowstate

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge for AnalysisForegroundService -- exposed as
 * `NativeModules.AnalysisService`. The analysis loop (analyzer.ts) calls
 * start() when a batch begins, update() per song for the notification, and
 * stop() when the batch ends. Kept dead-simple: the reliability win is that
 * the service's own onStartCommand calls startForeground() synchronously, so
 * none of this depends on JS timing (unlike react-native-background-actions).
 */
class AnalysisServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

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

    // Required no-op listener hooks so RN doesn't warn about the module
    // lacking an event emitter interface when addListener/removeListeners
    // are (never) called from JS.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}
