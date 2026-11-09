package `in`.signagecms.player.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import `in`.signagecms.player.PlayerActivity
import `in`.signagecms.player.R
import `in`.signagecms.player.SetupActivity
import `in`.signagecms.player.utils.scheduleRestart

class PlayerService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())

        // Delay check by 2s: PlayerActivity sets isVisible=true in onResume(),
        // which runs after onCreate() where startForegroundService() is called.
        // Without delay, service would always see isVisible=false on initial start
        // and incorrectly redirect to SetupActivity, closing the player.
        Handler(Looper.getMainLooper()).postDelayed({
            if (!PlayerActivity.isVisible) {
                val launch = Intent(this, SetupActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                try { startActivity(launch) } catch (e: Exception) { /* ignore */ }
            }
        }, 5000L)

        return START_STICKY
    }

    /**
     * Fired when the user swipes the app away from the Recents screen.
     * We schedule a restart so the player comes back automatically.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        scheduleRestart(this, delayMs = 1_500L)
    }

    private fun buildNotification(): Notification {
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, PlayerActivity::class.java),
            pendingFlags
        )
        return NotificationCompat.Builder(this, getString(R.string.notification_channel_id))
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val NOTIF_ID = 1001
    }
}
