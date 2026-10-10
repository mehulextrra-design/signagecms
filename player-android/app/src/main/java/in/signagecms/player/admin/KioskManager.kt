package `in`.signagecms.player.admin

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import `in`.signagecms.player.admin.DeviceAdminReceiver

object KioskManager {

    private const val TAG = "KioskManager"

    private fun adminComponent(context: Context) =
        ComponentName(context, DeviceAdminReceiver::class.java)

    fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(context.packageName)
    }

    /**
     * Start Lock Task Mode — pins the app fullscreen.
     * Back / Home / Recents are fully blocked by the OS.
     * Only works when this app is Device Owner.
     */
    fun startLockTask(activity: Activity) {
        if (!isDeviceOwner(activity)) {
            Log.d(TAG, "Not Device Owner — skipping Lock Task")
            return
        }
        try {
            val dpm = activity.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            dpm.setLockTaskPackages(adminComponent(activity), arrayOf(activity.packageName))
            activity.startLockTask()
            Log.d(TAG, "Lock Task Mode started")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Lock Task: ${e.message}")
        }
    }

    /**
     * Set STAY_ON_WHILE_PLUGGED_IN = 3 (AC + USB) so the display never sleeps
     * while the TV box is plugged in. Requires Device Owner.
     * This is a system-level override — survives activity pauses and screen savers.
     */
    fun setDisplayAlwaysOn(context: Context) {
        if (!isDeviceOwner(context)) {
            Log.d(TAG, "Not Device Owner — skipping STAY_ON_WHILE_PLUGGED_IN")
            return
        }
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            // 3 = BATTERY_PLUGGED_AC (1) | BATTERY_PLUGGED_USB (2)
            dpm.setGlobalSetting(adminComponent(context), android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "3")
            Log.d(TAG, "STAY_ON_WHILE_PLUGGED_IN set to 3")
        } catch (e: Exception) {
            Log.w(TAG, "Could not set STAY_ON_WHILE_PLUGGED_IN: ${e.message}")
        }
    }

    /**
     * Reboot the device. Requires Device Owner + Android 7+.
     * Called from PlayerActivity when CMS sends a reboot command via heartbeat.
     * Uses reflection to call DevicePolicyManager.rebootDevice() to avoid
     * "Unresolved reference" on certain CI SDK builds.
     */
    fun reboot(context: Context) {
        if (!isDeviceOwner(context)) {
            Log.w(TAG, "Reboot requested but not Device Owner")
            return
        }
        Log.d(TAG, "Rebooting device")
        // Strategy 1: DevicePolicyManager.rebootDevice() via reflection (API 24+, Device Owner)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                val method = dpm.javaClass.getMethod("rebootDevice", ComponentName::class.java)
                method.invoke(dpm, adminComponent(context))
                return
            } catch (e: Exception) {
                Log.w(TAG, "DPM reboot failed: ${e.message}")
            }
        }
        // Strategy 2: shell reboot (works on rooted TV boxes)
        try {
            Runtime.getRuntime().exec("reboot")
        } catch (e: Exception) {
            Log.e(TAG, "Shell reboot failed: ${e.message}")
        }
    }
}
