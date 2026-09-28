package `in`.signagecms.player.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import `in`.signagecms.player.SetupActivity
import `in`.signagecms.player.utils.Prefs

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in listOf(
                Intent.ACTION_BOOT_COMPLETED,
                "android.intent.action.QUICKBOOT_POWERON",
                "com.htc.intent.action.QUICKBOOT_POWERON"
            )
        ) return

        val prefs = Prefs.getInstance(context)
        val launchIntent = Intent(context, SetupActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        context.startActivity(launchIntent)
    }
}
