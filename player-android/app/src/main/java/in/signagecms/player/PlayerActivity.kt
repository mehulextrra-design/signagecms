package `in`.signagecms.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Drawable
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
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target
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
    private var playStartTime: Long = 0L
    private var activeContentView: android.view.View? = null

    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendHeartbeat()
            handler.postDelayed(this, (prefs.heartbeatIntervalSec * 1000L))
        }
    }

    private val syncRunnable = object : Runnable {
        override fun run() {
            syncSchedule()
            handler.postDelayed(this, (prefs.syncIntervalSec * 1000L))
        }
    }

    // Listen for network reconnect
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

        // Go back to setup if not registered
        if (!prefs.isRegistered) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        binding = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Keep screen on always
        acquireWakeLock()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setFullscreen()

        binding.tvScreenCode.text = prefs.screenCode ?: ""

        // Load from DB first (offline-first)
        loadFromDatabase()

        // Then sync from server
        syncSchedule()

        // Start heartbeat loop
        handler.post(heartbeatRunnable)

        // Schedule periodic sync
        handler.postDelayed(syncRunnable, (prefs.syncIntervalSec * 1000L))

        // Network change listener
        @Suppress("DEPRECATION")
        registerReceiver(networkReceiver, IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION))
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
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
        wakeLock?.acquire(24 * 60 * 60 * 1000L) // 24h max
    }

    // ── SCHEDULE SYNC ─────────────────────────────────────────────────────

    private fun syncSchedule() {
        val token = prefs.playerToken ?: return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val response = RetrofitClient.apiService.getSchedule("Bearer $token")
                if (response.isSuccessful) {
                    val body = response.body() ?: return@launch
                    val entities = body.campaigns.map { c ->
                        CampaignEntity(
                            campaignId = c.campaignId,
                            campaignCode = c.campaignCode,
                            title = c.title,
                            startDate = c.startDate,
                            endDate = c.endDate,
                            startTime = c.startTime,
                            endTime = c.endTime,
                            status = c.status,
                            contentId = c.contentId,
                            fileUrl = c.fileUrl,
                            storedName = c.storedName,
                            contentType = c.contentType,
                            durationSec = c.durationSec ?: 10.0
                        )
                    }
                    // Save to DB
                    db.campaignDao().insertAll(entities)
                    if (entities.isNotEmpty()) {
                        db.campaignDao().deleteNotIn(entities.map { it.campaignId })
                    }

                    // Download content files in background
                    downloadContent(entities)

                    withContext(Dispatchers.Main) {
                        loadFromDatabase()
                    }
                }
            } catch (e: Exception) {
                // Network error — play from cache
            }
        }
    }

    private suspend fun downloadContent(campaigns: List<CampaignEntity>) {
        val toDownload = campaigns.filter { c ->
            db.campaignDao().getById(c.campaignId)?.isDownloaded != true
        }
        if (toDownload.isNotEmpty()) {
            withContext(Dispatchers.Main) {
                binding.tvDownloadStatus.visibility = View.VISIBLE
                binding.tvDownloadStatus.text = "⬇ Downloading content (0/${toDownload.size})…"
            }
        }
        toDownload.forEachIndexed { idx, campaign ->
            withContext(Dispatchers.Main) {
                binding.tvDownloadStatus.text = "⬇ Downloading ${idx + 1}/${toDownload.size}: ${campaign.title}"
            }
            val file = ContentDownloader.download(this, campaign.fileUrl, campaign.storedName)
            if (file != null) {
                db.campaignDao().markDownloaded(campaign.campaignId, file.absolutePath)
            }
        }
        withContext(Dispatchers.Main) {
            binding.tvDownloadStatus.visibility = View.GONE
        }
        // Prune old files
        val activeNames = campaigns.map { it.storedName }.toSet()
        ContentDownloader.pruneOldFiles(this, activeNames)
    }

    // ── LOAD FROM DB ──────────────────────────────────────────────────────

    private fun loadFromDatabase() {
        lifecycleScope.launch(Dispatchers.IO) {
            val campaigns = db.campaignDao().getAll()
            withContext(Dispatchers.Main) {
                playlist = campaigns
                if (playlist.isEmpty()) {
                    showIdle("No active campaign scheduled")
                } else {
                    currentIndex = 0
                    playNext()
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
        playCampaign(campaign)
        currentIndex = (currentIndex + 1) % playlist.size
    }

    private fun playCampaign(campaign: CampaignEntity) {
        currentCampaignId = campaign.campaignId
        playStartTime = System.currentTimeMillis()
        updateStatusBar(campaign.title)

        when (campaign.contentType) {
            "video" -> playVideo(campaign)
            "image" -> showImage(campaign)
            else -> showImage(campaign) // fallback
        }
    }

    private fun crossFade(fadeOut: android.view.View?, fadeIn: android.view.View, duration: Long = 500) {
        binding.layoutIdle.visibility = View.GONE
        activeContentView = fadeIn               // always update — must be before early return
        fadeIn.alpha = if (fadeOut == null) 1f else 0f
        fadeIn.visibility = View.VISIBLE
        if (fadeOut == null || fadeOut === fadeIn) return   // nothing to animate
        fadeIn.animate().alpha(1f).setDuration(duration).start()
        fadeOut.animate().alpha(0f).setDuration(duration).withEndAction {
            fadeOut.visibility = View.GONE
            fadeOut.alpha = 1f
        }.start()
    }

    private fun playVideo(campaign: CampaignEntity) {
        releasePlayer()
        val player = ExoPlayer.Builder(this).build()
        exoPlayer = player
        binding.playerView.player = player
        binding.playerView.useController = false

        val uri = getContentUri(campaign)
        val prevView = activeContentView
        var fadeDone = false

        // Show playerView immediately so screen is never blank.
        // Start transparent and fade in once video is actually ready.
        binding.layoutIdle.visibility = View.GONE
        activeContentView = binding.playerView
        binding.playerView.alpha = 0f
        binding.playerView.visibility = View.VISIBLE

        // Timeout: if STATE_READY hasn't fired in 6 s, force-show anyway
        val readyTimeout = Runnable {
            if (!fadeDone) {
                fadeDone = true
                crossFade(prevView, binding.playerView)
            }
        }
        handler.postDelayed(readyTimeout, 6_000)

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY && !fadeDone) {
                    fadeDone = true
                    handler.removeCallbacks(readyTimeout)
                    crossFade(prevView, binding.playerView)
                }
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
        releasePlayer()

        val uri = getContentUri(campaign)
        val durationMs = (campaign.durationSec * 1000).toLong().coerceAtLeast(3000L)
        val imageToImage = activeContentView === binding.ivImage

        // Show ivImage immediately — don't wait for Glide callback.
        // This ensures we never get a blank screen if Glide is slow.
        if (!imageToImage) {
            crossFade(activeContentView, binding.ivImage)
        }

        val glideRequest = Glide.with(this).load(uri)
        // For image→image use Glide's built-in crossfade; for other transitions
        // we already faded the view above so skip Glide's drawable fade.
        val withTransition = if (imageToImage) {
            glideRequest.transition(DrawableTransitionOptions.withCrossFade(600))
        } else {
            glideRequest
        }

        withTransition
            .listener(object : RequestListener<Drawable> {
                override fun onLoadFailed(
                    e: GlideException?, model: Any?,
                    target: Target<Drawable>, isFirstResource: Boolean
                ): Boolean {
                    // ivImage is already visible from crossFade above; skip to next
                    handler.postDelayed({ playNext() }, 2000)
                    return false
                }
                override fun onResourceReady(
                    resource: Drawable, model: Any, target: Target<Drawable>?,
                    dataSource: DataSource, isFirstResource: Boolean
                ): Boolean {
                    return false   // let Glide set the drawable normally
                }
            })
            .into(binding.ivImage)

        handler.postDelayed({
            logPlay(campaign)
            playNext()
        }, durationMs)
    }

    private fun getContentUri(campaign: CampaignEntity): android.net.Uri {
        val localFile = campaign.localFilePath?.let { File(it) }
        return if (localFile != null && localFile.exists() && localFile.length() > 0) {
            android.net.Uri.fromFile(localFile)
        } else {
            android.net.Uri.parse(fixServerUrl(campaign.fileUrl))
        }
    }

    // Fix localhost URLs left in DB from dev deployments
    private fun fixServerUrl(url: String): String {
        if (url.contains("localhost") || url.contains("127.0.0.1")) {
            val serverBase = BuildConfig.API_BASE_URL
                .removeSuffix("api/").removeSuffix("/")
            val filePart = url.substringAfter("/uploads/", "")
            if (filePart.isNotEmpty()) return "$serverBase/uploads/$filePart"
        }
        return url
    }

    private fun showIdle(message: String) {
        releasePlayer()
        activeContentView = null
        binding.playerView.visibility = View.GONE
        binding.ivImage.visibility = View.GONE
        binding.layoutIdle.visibility = View.VISIBLE
        binding.tvIdleMessage.text = message
        binding.tvNextCheck.text = "Next sync in ${prefs.syncIntervalSec / 60} min · Screen: ${prefs.screenCode ?: "—"}"
        binding.tvDownloadStatus.visibility = View.GONE
        binding.layoutStatus.visibility = View.GONE
    }

    private fun releasePlayer() {
        handler.removeCallbacksAndMessages(null)
        // Re-add recurring tasks
        handler.post(heartbeatRunnable)
        handler.postDelayed(syncRunnable, prefs.syncIntervalSec * 1000L)

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
                    campaignId = campaign.campaignId,
                    contentId = campaign.contentId,
                    playedAt = isoTime,
                    durationSec = durationSec
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
                        ipAddress = null,
                        appVersion = BuildConfig.VERSION_NAME,
                        androidVersion = Build.VERSION.RELEASE,
                        uptimeSec = android.os.SystemClock.elapsedRealtime() / 1000,
                        isPlaying = currentCampaignId != null,
                        currentCampaignId = currentCampaignId
                    )
                )
                if (response.isSuccessful) {
                    // Handle remote commands
                    response.body()?.commands?.forEach { cmd ->
                        withContext(Dispatchers.Main) {
                            handleCommand(cmd.command, cmd.payload)
                        }
                    }
                    // Also sync play logs on each successful heartbeat
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
                currentIndex = 0
                syncSchedule()
            }
            "reboot" -> {
                // Signal boot receiver to restart
                finish()
                startActivity(Intent(this, PlayerActivity::class.java))
            }
            "clear_cache" -> {
                ContentDownloader.clearAll(this)
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
                        campaignId = it.campaignId,
                        contentId = it.contentId,
                        playedAt = it.playedAt,
                        durationSec = it.durationSec,
                        playCount = it.playCount
                    )
                }
                val response = RetrofitClient.apiService.submitProofOfPlay(
                    "Bearer $token",
                    ProofOfPlayRequest(plays)
                )
                if (response.isSuccessful) {
                    db.playLogDao().markSynced(unsynced.map { it.id })
                    // Clean old synced logs > 7 days
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
