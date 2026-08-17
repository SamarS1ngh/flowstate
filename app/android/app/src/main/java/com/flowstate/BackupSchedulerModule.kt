package com.flowstate

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Calendar

/**
 * Schedules a daily ~2 AM alarm that fires BackupAlarmReceiver, which kicks the
 * 'flowstateBackup' HeadlessJS task (BackupTaskService) to upload vibes.db to the
 * user's Google Drive -- the WhatsApp-style nightly backup. Exact alarms are
 * one-shot on Android, so the receiver reschedules the next night after each
 * fire; a persisted "enabled" flag lets BackupBootReceiver re-arm it after a
 * reboot (alarms are cleared on reboot).
 *
 * Exposed to JS as NativeModules.BackupScheduler (schedule/cancel/isScheduled).
 */
class BackupSchedulerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BackupScheduler"

    @ReactMethod
    fun schedule(promise: Promise) {
        try {
            setAlarm(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("schedule_failed", e.message, e)
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        try {
            cancelAlarm(reactContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("cancel_failed", e.message, e)
        }
    }

    @ReactMethod
    fun isScheduled(promise: Promise) {
        promise.resolve(isEnabled(reactContext))
    }

    companion object {
        private const val PREFS = "flowstate_backup"
        private const val KEY_ENABLED = "nightly_enabled"
        private const val REQUEST_CODE = 71010
        private const val BACKUP_HOUR = 2 // 2 AM local time

        private fun pendingIntent(ctx: Context): PendingIntent {
            val intent = Intent(ctx, BackupAlarmReceiver::class.java)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags = flags or PendingIntent.FLAG_IMMUTABLE
            }
            return PendingIntent.getBroadcast(ctx.applicationContext, REQUEST_CODE, intent, flags)
        }

        private fun next2am(): Long {
            val cal = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, BACKUP_HOUR)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            if (cal.timeInMillis <= System.currentTimeMillis()) {
                cal.add(Calendar.DAY_OF_YEAR, 1)
            }
            return cal.timeInMillis
        }

        /** (Re)arm the daily 2 AM alarm and persist that nightly backup is on. */
        fun setAlarm(ctx: Context) {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val at = next2am()
            val pi = pendingIntent(ctx)
            // setExactAndAllowWhileIdle fires even in Doze; fall back to inexact
            // if exact alarms aren't permitted (avoids a SecurityException).
            val canExact =
                Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
            try {
                if (canExact) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
                }
            } catch (_: SecurityException) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            }
            setEnabled(ctx, true)
        }

        fun cancelAlarm(ctx: Context) {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.cancel(pendingIntent(ctx))
            setEnabled(ctx, false)
        }

        fun setEnabled(ctx: Context, enabled: Boolean) {
            ctx.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_ENABLED, enabled)
                .apply()
        }

        fun isEnabled(ctx: Context): Boolean =
            ctx.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false)
    }
}
