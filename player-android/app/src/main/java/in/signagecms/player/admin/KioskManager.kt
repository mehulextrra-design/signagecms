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
     * Reboot the device. Requires Device Owner + Android 7+.
     * Called from PlayerActivity when CMS sends a reboot command via heartbeat.
     */
    fun reboot(context: Context) {
        if (!isDeviceOwner(context)) {
            Log.w(TAG, "Reboot requested but not Device Owner")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            Log.w(TAG, "Reboot API requires Android 7+")
            return
        }
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            Log.d(TAG, "Rebooting device via DevicePolicyManager")
            dpm.rebootDevice(adminComponent(context))
        } catch (e: Exception) {
            Log.e(TAG, "Reboot failed: ${e.message}")
        }
    }
}
