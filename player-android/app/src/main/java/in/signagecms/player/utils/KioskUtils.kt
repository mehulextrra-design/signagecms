package `in`.signagecms.player.utils

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import `in`.signagecms.player.SetupActivity

/**
 * Schedule a self-restart 2 seconds from now via AlarmManager.
 * Used after crash and after recents-swipe so the player relaunches automatically.
 * Does NOT work after a force-stop (Android cancels all alarms on force-stop).
 */
fun scheduleRestart(context: Context, delayMs: Long = 2_000L) {
    val intent = Intent(context, SetupActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT
    } else {
        PendingIntent.FLAG_ONE_SHOT
    }
    val pending = PendingIntent.getActivity(context, 9001, intent, flags)
    val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val triggerAt = System.currentTimeMillis() + delayMs
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending)
    } else {
        alarm.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pending)
    }
}
