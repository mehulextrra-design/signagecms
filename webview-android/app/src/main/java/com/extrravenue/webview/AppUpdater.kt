package com.extrravenue.webview

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.URL

class AppUpdater(private val activity: Activity) {

    fun checkForUpdate() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val json = URL("https://www.extrravenue.com/api/webview-app-version")
                    .readText(Charsets.UTF_8)
                val obj = JSONObject(json)
                val flavor = BuildConfig.FLAVOR
                if (!obj.has(flavor)) return@launch
                val info = obj.getJSONObject(flavor)
                val serverVersion = info.optInt("versionCode", 0)
                val currentVersion = BuildConfig.VERSION_CODE
                val downloadUrl = info.optString("downloadUrl", "")
                if (serverVersion > currentVersion && downloadUrl.isNotEmpty()) {
                    withContext(Dispatchers.Main) {
                        showUpdateDialog(serverVersion, downloadUrl)
                    }
                }
            } catch (_: Exception) {}
        }
    }

    private fun showUpdateDialog(newVersion: Int, downloadUrl: String) {
        AlertDialog.Builder(activity)
            .setTitle("Update Available")
            .setMessage("Naya version v1.$newVersion available hai. Abhi update karo?")
            .setPositiveButton("Update Karo") { _, _ ->
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl)))
            }
            .setNegativeButton("Baad Mein", null)
            .show()
    }
}
