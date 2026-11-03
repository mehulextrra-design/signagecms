package in.pravaah.player.services

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class DeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.d("DeviceAdmin", "Device admin enabled — kiosk mode available")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.d("DeviceAdmin", "Device admin disabled")
    }

    companion object {
        /**
         * Call from SetupActivity after registration to lock the task.
         * Requires this app to be set as device owner:
         *   adb shell dpm set-device-owner in.pravaah.player/.services.DeviceAdminReceiver
         */
        fun startKioskMode(context: Context) {
            try {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE)
                    as android.app.admin.DevicePolicyManager
                val component = android.content.ComponentName(context, DeviceAdminReceiver::class.java)
                if (dpm.isDeviceOwnerApp(context.packageName)) {
                    // Lock task / kiosk mode — only this app visible
                    dpm.setLockTaskPackages(component, arrayOf(context.packageName))
                    Log.d("DeviceAdmin", "Lock task packages set")
                } else {
                    Log.w("DeviceAdmin", "Not device owner — kiosk mode unavailable. Run: adb shell dpm set-device-owner in.pravaah.player/.services.DeviceAdminReceiver")
                }
            } catch (e: Exception) {
                Log.e("DeviceAdmin", "Kiosk setup failed: ${e.message}")
            }
        }
    }
}
