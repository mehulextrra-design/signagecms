package `in`.signagecms.player.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import `in`.signagecms.player.BuildConfig
import `in`.signagecms.player.api.RetrofitClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

object AppUpdater {

    private const val TAG = "AppUpdater"
    private const val APK_FILENAME = "signagecms_update.apk" // always saved as .apk regardless of URL extension

    private val downloadClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(300, TimeUnit.SECONDS) // 5 min for large APK
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    suspend fun checkAndUpdate(context: Context) {
        if (!isNetworkAvailable(context)) return
        try {
            val response = withContext(Dispatchers.IO) {
                RetrofitClient.apiService.getAppVersion()
            }
            if (!response.isSuccessful) return
            val info = response.body() ?: return
            if (info.versionCode <= BuildConfig.VERSION_CODE) return
            val apkUrl = info.apkUrl ?: run {
                Log.w(TAG, "New version ${info.versionCode} available but no apk_url set on server")
                return
            }
            Log.i(TAG, "Updating: ${BuildConfig.VERSION_CODE} → ${info.versionCode}")
            downloadAndInstall(context, apkUrl)
        } catch (e: Exception) {
            Log.e(TAG, "Update check failed: ${e.message}")
        }
    }

    private suspend fun downloadAndInstall(context: Context, url: String) = withContext(Dispatchers.IO) {
        val apkFile = File(context.filesDir, APK_FILENAME)
        try {
            val request = Request.Builder().url(url).build()
            val response = downloadClient.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e(TAG, "Download failed: HTTP ${response.code}")
                return@withContext
            }
            response.body?.byteStream()?.use { input ->
                apkFile.outputStream().use { output -> input.copyTo(output) }
            }
            Log.i(TAG, "APK downloaded: ${apkFile.length()} bytes → installing")
            installApk(context, apkFile)
        } catch (e: Exception) {
            Log.e(TAG, "Download error: ${e.message}")
            apkFile.delete()
        }
    }

    private fun installApk(context: Context, apkFile: File) {
        try {
            val packageInstaller = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(context.packageName)

            val sessionId = packageInstaller.createSession(params)
            val session = packageInstaller.openSession(sessionId)

            apkFile.inputStream().use { input ->
                session.openWrite("package", 0, apkFile.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }

            // BroadcastReceiver action for install result
            val intent = Intent("in.signagecms.player.INSTALL_COMPLETE").apply {
                setPackage(context.packageName)
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            else
                PendingIntent.FLAG_UPDATE_CURRENT
            val pendingIntent = PendingIntent.getBroadcast(context, sessionId, intent, flags)

            session.commit(pendingIntent.intentSender)
            session.close()
            Log.i(TAG, "Install session committed (sessionId=$sessionId)")
        } catch (e: Exception) {
            Log.e(TAG, "Install failed: ${e.message}")
        }
    }

    private fun isNetworkAvailable(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as android.net.ConnectivityManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            cm.activeNetwork != null
        } else {
            @Suppress("DEPRECATION")
            cm.activeNetworkInfo?.isConnected == true
        }
    }
}
