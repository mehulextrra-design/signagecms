package in.pravaah.player.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.google.gson.Gson
import in.pravaah.player.BuildConfig
import in.pravaah.player.R
import in.pravaah.player.api.ApiClient
import in.pravaah.player.models.HeartbeatRequest
import in.pravaah.player.models.PlayLog
import in.pravaah.player.models.PlayLogsRequest
import in.pravaah.player.storage.ContentCache
import in.pravaah.player.storage.PrefsManager
import kotlinx.coroutines.*
import java.time.Instant

class SyncService : Service() {

    companion object {
        private const val TAG = "SyncService"
        private const val CHANNEL_ID = "pravaah_sync"
        const val ACTION_SCHEDULE_UPDATED = "in.pravaah.player.SCHEDULE_UPDATED"
        const val EXTRA_CAMPAIGNS_JSON = "campaigns_json"

        fun uploadPlayLogs(context: Context, logs: List<PlayLog>) {
            val intent = Intent(context, SyncService::class.java).apply {
                action = "UPLOAD_PLAY_LOGS"
                putExtra("logs_json", Gson().toJson(logs))
            }
            context.startService(intent)
        }
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var prefs: PrefsManager
    private lateinit var cache: ContentCache
    private var heartbeatJob: Job? = null
    private var syncJob: Job? = null
    private var offlineFrom: Instant? = null

    override fun onCreate() {
        super.onCreate()
        prefs = PrefsManager(this)
        cache = ContentCache(this)
        startForeground(1, buildNotification())
        startHeartbeatLoop()
        startSyncLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "UPLOAD_PLAY_LOGS") {
            val json = intent.getStringExtra("logs_json")
            if (json != null) {
                val logs: List<PlayLog> = Gson().fromJson(json, object : com.google.gson.reflect.TypeToken<List<PlayLog>>() {}.type)
                serviceScope.launch { uploadLogs(logs) }
            }
        }
        return START_STICKY  // restart if killed
    }

    // ── Heartbeat loop ────────────────────────────────────────────────────
    private fun startHeartbeatLoop() {
        heartbeatJob = serviceScope.launch {
            while (isActive) {
                sendHeartbeat()
                delay(prefs.heartbeatIntervalSec * 1000L)
            }
        }
    }

    private suspend fun sendHeartbeat() {
        if (!isNetworkAvailable()) {
            if (offlineFrom == null) offlineFrom = Instant.now()
            Log.w(TAG, "Heartbeat skipped — no network")
            return
        }

        // If we were offline, report recovery
        offlineFrom?.let { from ->
            try {
                ApiClient.getInstance(this).reportOffline(
                    in.pravaah.player.models.OfflineLogRequest(
                        offlineFrom = from.toString(),
                        offlineUntil = Instant.now().toString(),
                        reason = "Network unavailable"
                    )
                )
            } catch (_: Exception) {}
            offlineFrom = null
        }

        try {
            val api = ApiClient.getInstance(this)
            val response = api.heartbeat(
                HeartbeatRequest(
                    ipAddress = null,
                    appVersion = BuildConfig.VERSION_NAME,
                    androidVersion = Build.VERSION.RELEASE,
                    uptimeSec = SystemClock.elapsedRealtime() / 1000,
                    isPlaying = true,
                    currentCampaignId = null
                )
            )
            if (response.isSuccessful) {
                val body = response.body()
                body?.commands?.forEach { cmd ->
                    handleCommand(cmd.command, cmd.payload)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Heartbeat failed: ${e.message}")
        }
    }

    // ── Schedule sync loop ────────────────────────────────────────────────
    private fun startSyncLoop() {
        syncJob = serviceScope.launch {
            while (isActive) {
                syncSchedule()
                delay(prefs.syncIntervalSec * 1000L)
            }
        }
    }

    private suspend fun syncSchedule() {
        if (!isNetworkAvailable()) return
        try {
            val response = ApiClient.getInstance(this).getSchedule()
            if (response.isSuccessful) {
                val scheduleResponse = response.body() ?: return
                val campaigns = scheduleResponse.campaigns

                // Pre-download content for all active campaigns
                campaigns.forEach { slot ->
                    launch {
                        cache.downloadIfNeeded(slot)
                    }
                }

                // Evict unused cache
                cache.evictExpired(campaigns.map { it.campaignId }.toSet())

                // Broadcast to PlayerActivity
                val json = Gson().toJson(campaigns)
                sendBroadcast(Intent(ACTION_SCHEDULE_UPDATED).apply {
                    putExtra(EXTRA_CAMPAIGNS_JSON, json)
                })

                Log.d(TAG, "Schedule synced: ${campaigns.size} campaigns")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Sync failed: ${e.message}")
        }
    }

    private suspend fun uploadLogs(logs: List<PlayLog>) {
        if (!isNetworkAvailable() || logs.isEmpty()) return
        try {
            ApiClient.getInstance(this).uploadProofOfPlay(PlayLogsRequest(logs))
            Log.d(TAG, "Uploaded ${logs.size} play logs")
        } catch (e: Exception) {
            Log.e(TAG, "Log upload failed: ${e.message}")
        }
    }

    private fun handleCommand(command: String, payload: Map<String, Any>?) {
        Log.d(TAG, "Remote command: $command")
        when (command) {
            "refresh" -> serviceScope.launch { syncSchedule() }
            "restart" -> {
                val intent = packageManager.getLaunchIntentForPackage(packageName)
                startActivity(intent?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
            }
            "clear_cache" -> {
                cache.evictExpired(emptySet())
                serviceScope.launch { syncSchedule() }
            }
        }
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cap = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun buildNotification(): Notification {
        val channel = NotificationChannel(CHANNEL_ID, "Pravaah Player", NotificationManager.IMPORTANCE_LOW)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Pravaah Signage Player")
            .setContentText("Running")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }
}
