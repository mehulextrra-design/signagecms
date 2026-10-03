package `in`.signagecms.player.worker

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters
import `in`.signagecms.player.PlayerActivity
import `in`.signagecms.player.SetupActivity
import `in`.signagecms.player.utils.Prefs

/**
 * Runs every 15 minutes via WorkManager.
 * If the screen is registered but PlayerActivity is not visible (was killed, crashed,
 * or never started), this brings the player back to the foreground.
 *
 * WorkManager survives reboots and most kill scenarios except force-stop.
 * On Android 10+ background-activity starts are restricted, but on most Android TV
 * boxes (Android 7–9) this works without restriction.
 */
class WatchdogWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val prefs = Prefs.getInstance(applicationContext)
        if (!prefs.isRegistered) return Result.success()

        if (!PlayerActivity.isVisible) {
            val intent = Intent(applicationContext, SetupActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            try {
                applicationContext.startActivity(intent)
            } catch (e: Exception) {
                android.util.Log.w("WatchdogWorker", "Could not restart player: ${e.message}")
            }
        }
        return Result.success()
    }
}
