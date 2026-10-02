package `in`.signagecms.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.bumptech.glide.Glide
import `in`.signagecms.player.api.RetrofitClient
import `in`.signagecms.player.api.models.HeartbeatRequest
import `in`.signagecms.player.api.models.PlayEntry
import `in`.signagecms.player.api.models.ProofOfPlayRequest
import `in`.signagecms.player.databinding.ActivityPlayerBinding
import `in`.signagecms.player.db.AppDatabase
import `in`.signagecms.player.db.entities.CampaignEntity
import `in`.signagecms.player.db.entities.PlayLogEntity
import `in`.signagecms.player.utils.ContentDownloader
import `in`.signagecms.player.utils.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class PlayerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPlayerBinding
    private lateinit var prefs: Prefs
    private lateinit var db: AppDatabase

    private var exoPlayer: ExoPlayer? = null
    private var playlist: List<CampaignEntity> = emptyList()
    private var currentIndex = 0
    private var currentCampaignId: String? = null
    private var currentContentTier: String? = null
    private var playStartTime: Long = 0L
    private var lastSyncedContentVersion: String? = null

    // Separate image timer so releasePlayer() doesn't accidentally cancel it
    private var imageTimerRunnable: Runnable? = null

    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendHeartbeat()
            handler.postDelayed(this, prefs.heartbeatIntervalSec * 1000L)
        }
    }

    private val syncRunnable = object : Runnable {
        override fun run() {
            syncSchedule()
            handler.postDelayed(this, prefs.syncIntervalSec * 1000L)
        }
    }

    private val networkReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (isNetworkAvailable()) {
                syncSchedule()
                syncPlayLogs()
            }
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        prefs = Prefs.getInstance(this)
        db = AppDatabase.getInstance(this)

        if (!prefs.isRegistered) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        binding = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        acquireWakeLock()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setFullscreen()

        binding.tvScreenCode.text = prefs.screenCode ?: ""

        // Load cached content first (offline-first)
        loadFromDatabase(forceRestart = true)

        // Sync from server, then start heartbeat + periodic sync
        syncSchedule()
        handler.post(heartbeatRunnable)
        handler.postDelayed(syncRunnable, prefs.syncIntervalSec * 1000L)

        @Suppress("DEPRECATION")
        registerReceiver(networkReceiver, IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION))
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
        cancelImageTimer()
        releasePlayer()
        wakeLock?.release()
        try { unregisterReceiver(networkReceiver) } catch (e: Exception) { }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) setFullscreen()
    }

    // ── FULLSCREEN ────────────────────────────────────────────────────────

    private fun setFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            )
        }
    }

    // ── WAKE LOCK ─────────────────────────────────────────────────────────

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        wakeLock = pm.newWakeLock(
            PowerManager.FULL_WAKE_LOCK
                or PowerManager.ACQUIRE_CAUSES_WAKEUP
                or PowerManager.ON_AFTER_RELEASE,
            "SignageCMS:PlayerWakeLock"
        )
        wakeLock?.acquire(24 * 60 * 60 * 1000L)
    }

    // ── SCHEDULE SYNC ─────────────────────────────────────────────────────

    private fun syncSchedule() {
        val token = prefs.playerToken ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val response = RetrofitClient.apiService.getSchedule("Bearer $token")
                if (response.isSuccessful) {
                    val body = response.body() ?: return@launch
                    val newVersion = body.contentVersion

                    val entities = body.campaigns.map { c ->
                        // Derive filename from URL if server didn't send stored_name
                        val fileName = c.storedName?.takeIf { it.isNotBlank() }
                            ?: c.fileUrl.substringAfterLast('/').substringBefore('?')
                        CampaignEntity(
                            campaignId   = c.campaignId,
                            campaignCode = c.campaignCode ?: c.contentTier ?: "filler",
                            title        = c.title ?: "",
                            startDate    = c.startDate ?: "",
                            endDate      = c.endDate ?: "",
                            startTime    = c.startTime ?: "00:00",
                            endTime      = c.endTime ?: "23:59",
                            status       = c.status ?: "live",
                            contentId    = c.contentId,
                            fileUrl      = c.fileUrl,
                            storedName   = fileName,
                            contentType  = c.contentType,
                            durationSec  = c.durationSec ?: 10.0,
                            contentTier  = c.contentTier ?: "paid"
                        )
                    }

                    db.campaignDao().insertAll(entities)
                    if (entities.isNotEmpty()) {
                        db.campaignDao().deleteNotIn(entities.map { it.campaignId })
                    }

                    downloadContent(entities)

                    val versionChanged = newVersion != null && newVersion != lastSyncedContentVersion
                    if (versionChanged) lastSyncedContentVersion = newVersion

                    withContext(Dispatchers.Main) {
                        // Only force-restart playlist if content version changed or we have nothing playing
                        loadFromDatabase(forceRestart = versionChanged || playlist.isEmpty())
                    }
                }
            } catch (e: Exception) {
                // Network error — continue playing from cache
            }
        }
    }

    private suspend fun downloadContent(campaigns: List<CampaignEntity>) {
        campaigns.forEach { campaign ->
            val existing = db.campaignDao().getById(campaign.campaignId)
            if (existing?.isDownloaded == true) return@forEach
            val file = ContentDownloader.download(this, campaign.fileUrl, campaign.storedName)
            if (file != null) {
                db.campaignDao().markDownloaded(campaign.campaignId, file.absolutePath)
            }
        }
        val activeNames = campaigns.map { it.storedName }.toSet()
        ContentDownloader.pruneOldFiles(this, activeNames)
    }

    // ── LOAD FROM DB ──────────────────────────────────────────────────────

    // forceRestart=true → interrupt current media and restart from index 0
    // forceRestart=false → just update playlist reference; current index keeps playing
    private fun loadFromDatabase(forceRestart: Boolean = false) {
        lifecycleScope.launch(Dispatchers.IO) {
            val campaigns = db.campaignDao().getAll()
            withContext(Dispatchers.Main) {
                val wasEmpty = playlist.isEmpty()
                playlist = campaigns
                when {
                    playlist.isEmpty() -> showIdle("No active campaign scheduled")
                    wasEmpty || forceRestart -> {
                        currentIndex = 0
                        cancelImageTimer()
                        releasePlayer()
                        playNext()
                    }
                    // else: playlist updated silently, current playback continues to end naturally
                }
            }
        }
    }

    // ── PLAYBACK ──────────────────────────────────────────────────────────

    private fun playNext() {
        if (playlist.isEmpty()) {
            showIdle("No active campaigns")
            return
        }
        currentIndex = currentIndex % playlist.size
        val campaign = playlist[currentIndex]
        currentIndex = (currentIndex + 1) % playlist.size
        playCampaign(campaign)
    }

    private fun playCampaign(campaign: CampaignEntity) {
        currentCampaignId   = campaign.campaignId
        currentContentTier  = campaign.contentTier
        playStartTime       = System.currentTimeMillis()
        updateStatusBar(campaign.title)

        when (campaign.contentType) {
            "video" -> playVideo(campaign)
            "image" -> showImage(campaign)
            else    -> showImage(campaign)
        }
    }

    private fun playVideo(campaign: CampaignEntity) {
        // Cancel any pending image timer before starting video
        cancelImageTimer()

        binding.layoutIdle.visibility  = View.GONE
        binding.ivImage.visibility     = View.GONE
        binding.playerView.visibility  = View.VISIBLE

        releasePlayer()
        val player = ExoPlayer.Builder(this).build()
        exoPlayer = player
        binding.playerView.player = player
        binding.playerView.useController = false

        val uri = getContentUri(campaign)
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    logPlay(campaign)
                    handler.post { playNext() }
                }
            }
        })

        player.setMediaItem(MediaItem.fromUri(uri))
        player.prepare()
        player.play()
    }

    private fun showImage(campaign: CampaignEntity) {
        // Cancel any existing image timer before setting a new one
        cancelImageTimer()

        binding.playerView.visibility  = View.GONE
        binding.layoutIdle.visibility  = View.GONE
        binding.ivImage.visibility     = View.VISIBLE

        releasePlayer()

        val uri = getContentUri(campaign)
        Glide.with(this).load(uri).into(binding.ivImage)

        val durationMs = (campaign.durationSec * 1000).toLong().coerceAtLeast(3000L)
        val runnable = Runnable {
            imageTimerRunnable = null
            logPlay(campaign)
            playNext()
        }
        imageTimerRunnable = runnable
        handler.postDelayed(runnable, durationMs)
    }

    private fun cancelImageTimer() {
        imageTimerRunnable?.let { handler.removeCallbacks(it) }
        imageTimerRunnable = null
    }

    private fun getContentUri(campaign: CampaignEntity): android.net.Uri {
        val localFile = campaign.localFilePath?.let { File(it) }
        return if (localFile != null && localFile.exists() && localFile.length() > 0) {
            android.net.Uri.fromFile(localFile)
        } else {
            android.net.Uri.parse(campaign.fileUrl)
        }
    }

    private fun showIdle(message: String) {
        cancelImageTimer()
        releasePlayer()
        binding.playerView.visibility  = View.GONE
        binding.ivImage.visibility     = View.GONE
        binding.layoutIdle.visibility  = View.VISIBLE
        binding.tvIdleMessage.text     = message
        binding.tvNextCheck.text       = "Next check in ${prefs.syncIntervalSec / 60} min"
        binding.layoutStatus.visibility = View.GONE
    }

    // Only release ExoPlayer — do NOT touch handler callbacks here
    private fun releasePlayer() {
        exoPlayer?.stop()
        exoPlayer?.release()
        exoPlayer = null
    }

    private fun updateStatusBar(title: String) {
        binding.layoutStatus.visibility = View.VISIBLE
        binding.tvStatus.text = "${prefs.screenCode} · $title"
    }

    // ── LOGGING ───────────────────────────────────────────────────────────

    private fun logPlay(campaign: CampaignEntity) {
        val durationSec = (System.currentTimeMillis() - playStartTime) / 1000.0
        val isoTime = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .also { it.timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(playStartTime))

        lifecycleScope.launch(Dispatchers.IO) {
            db.playLogDao().insert(
                PlayLogEntity(
                    campaignId  = campaign.campaignId,
                    contentId   = campaign.contentId,
                    playedAt    = isoTime,
                    durationSec = durationSec,
                    contentTier = campaign.contentTier ?: "paid"
                )
            )
        }
    }

    // ── HEARTBEAT ─────────────────────────────────────────────────────────

    private fun sendHeartbeat() {
        val token = prefs.playerToken ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val response = RetrofitClient.apiService.heartbeat(
                    "Bearer $token",
                    HeartbeatRequest(
                        ipAddress       = null,
                        appVersion      = BuildConfig.VERSION_NAME,
                        androidVersion  = Build.VERSION.RELEASE,
                        uptimeSec       = android.os.SystemClock.elapsedRealtime() / 1000,
                        isPlaying       = currentCampaignId != null,
                        currentCampaignId = currentCampaignId,
                        contentVersion  = lastSyncedContentVersion
                    )
                )
                if (response.isSuccessful) {
                    val body = response.body()
                    body?.commands?.forEach { cmd ->
                        withContext(Dispatchers.Main) {
                            handleCommand(cmd.command, cmd.payload)
                        }
                    }
                    // If server says content changed and we haven't reloaded yet, sync now
                    val serverVer = body?.contentVersion
                    if (serverVer != null && serverVer != lastSyncedContentVersion) {
                        syncSchedule()
                    }
                    syncPlayLogs()
                }
            } catch (e: Exception) {
                // Offline — ignore
            }
        }
    }

    private fun handleCommand(command: String, payload: String?) {
        when (command) {
            "reload" -> {
                // Force full restart: clear current playback state so loadFromDatabase restarts
                cancelImageTimer()
                releasePlayer()
                currentIndex = 0
                playlist = emptyList()
                lastSyncedContentVersion = null
                syncSchedule()
            }
            "reboot" -> {
                finish()
                startActivity(Intent(this, PlayerActivity::class.java))
            }
            "clear_cache" -> {
                ContentDownloader.clearAll(this)
                cancelImageTimer()
                releasePlayer()
                currentIndex = 0
                playlist = emptyList()
                lastSyncedContentVersion = null
                syncSchedule()
            }
        }
    }

    // ── PROOF OF PLAY SYNC ────────────────────────────────────────────────

    private fun syncPlayLogs() {
        val token = prefs.playerToken ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val unsynced = db.playLogDao().getUnsynced()
                if (unsynced.isEmpty()) return@launch

                val plays = unsynced.map {
                    PlayEntry(
                        campaignId  = it.campaignId,
                        contentId   = it.contentId,
                        playedAt    = it.playedAt,
                        durationSec = it.durationSec,
                        playCount   = it.playCount,
                        contentTier = it.contentTier
                    )
                }
                val response = RetrofitClient.apiService.submitProofOfPlay(
                    "Bearer $token",
                    ProofOfPlayRequest(plays)
                )
                if (response.isSuccessful) {
                    db.playLogDao().markSynced(unsynced.map { it.id })
                    val weekAgo = System.currentTimeMillis() - 7 * 24 * 60 * 60 * 1000L
                    db.playLogDao().deleteOldSynced(weekAgo)
                }
            } catch (e: Exception) {
                // Queue stays — will retry next heartbeat
            }
        }
    }

    // ── NETWORK CHECK ─────────────────────────────────────────────────────

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        @Suppress("DEPRECATION")
        return cm.activeNetworkInfo?.isConnected == true
    }
}
