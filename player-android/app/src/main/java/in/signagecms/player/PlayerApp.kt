package `in`.signagecms.player

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import `in`.signagecms.player.utils.scheduleRestart
import `in`.signagecms.player.worker.WatchdogWorker
import java.util.concurrent.TimeUnit

class PlayerApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        installCrashRecovery()
        scheduleWatchdog()
    }

    /**
     * If the app crashes, schedule a restart 2 seconds later via AlarmManager,
     * then let the process die normally. The OS fires the alarm and relaunches the app.
     */
    private fun installCrashRecovery() {
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                android.util.Log.e("PlayerApp", "Crash detected — scheduling restart", throwable)
                scheduleRestart(applicationContext, delayMs = 3_000L)
            } catch (e: Exception) {
                // If even scheduling fails, let default handler take over
            }
            defaultHandler?.uncaughtException(thread, throwable)
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    /**
     * WorkManager periodic watchdog — fires every 15 minutes.
     * If the player activity is dead, it relaunches it.
     * KEEP_EXISTING means the schedule is not reset on each app start.
     */
    private fun scheduleWatchdog() {
        val request = PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "player_watchdog",
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                getString(R.string.notification_channel_id),
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "SignageCMS Player foreground service"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }
}
