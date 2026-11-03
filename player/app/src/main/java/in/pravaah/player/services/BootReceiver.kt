package in.pravaah.player.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import in.pravaah.player.SetupActivity
import in.pravaah.player.storage.PrefsManager

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON") return

        Log.d("BootReceiver", "Device booted — starting Pravaah Player")

        val prefs = PrefsManager(context)
        val launchIntent = Intent(context, SetupActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launchIntent)

        // Start sync service regardless of registration status
        context.startService(Intent(context, SyncService::class.java))
    }
}
