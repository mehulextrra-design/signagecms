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
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.bumptech.glide.Glide
import com.bumptech.glide.load.DataSource
import com.bumptech.glide.load.engine.GlideException
import com.bumptech.glide.request.RequestListener
import com.bumptech.glide.request.target.Target
import android.graphics.drawable.Drawable
import `in`.signagecms.player.api.RetrofitClient
import `in`.signagecms.player.api.models.HeartbeatRequest
import `in`.signagecms.player.api.models.PlayEntry
import `in`.signagecms.player.api.models.ProofOfPlayRequest
import `in`.signagecms.player.databinding.ActivityPlayerBinding
import `in`.signagecms.player.db.AppDatabase
import `in`.signagecms.player.db.entities.CampaignEntity
import `in`.signagecms.player.db.entities.PlayLogEntity
import `in`.signagecms.player.admin.KioskManager
import `in`.signagecms.player.update.AppUpdater
import `in`.signagecms.player.utils.ContentDownloader
import `in`.signagecms.player.utils.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class PlayerActivity : AppCompatActivity() {

    companion object {
        // Checked by PlayerService / WatchdogWorker to know if activity is alive.
        @Volatile var isVisible = false
    }

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
            lifecycleScope.launch { AppUpdater.checkAndUpdate(this@PlayerActivity) }
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

        // Start foreground service — keeps process alive, handles task-removed restart via START_STICKY
        val serviceIntent = android.content.Intent(this, `in`.signagecms.player.service.PlayerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        // Start Lock Task Mode (true kiosk) if this app is Device Owner.
        // Back / Home / Recents are blocked by the OS — no user can exit.
        KioskManager.startLockTask(this)

        // Set STAY_ON_WHILE_PLUGGED_IN at system level (Device Owner only)
        KioskManager.setDisplayAlwaysOn(this)

        // ── Kiosk / display-override flags ────────────────────────────────
        // Show over lock screen and force-turn the display on.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }
        acquireWakeLock()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setFullscreen()

        binding.tvScreenCode.text = prefs.screenCode ?: ""

        // Load cached content first (offline-first)
        loadFromDatabase(forceRestart = true)

        // Check for app update in background (downloads + installs if newer version available)
        lifecycleScope.launch { AppUpdater.checkAndUpdate(this@PlayerActivity) }

        // Sync from server, then start heartbeat + periodic sync
        syncSchedule()
        handler.post(heartbeatRunnable)
        handler.postDelayed(syncRunnable, prefs.syncIntervalSec * 1000L)

        @Suppress("DEPRECATION")
        registerReceiver(networkReceiver, IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION))
    }

    override fun onResume() {
        super.onResume()
        isVisible = true
        // Re-apply fullscreen in case status bar was revealed
        setFullscreen()
    }

    override fun onPause() {
        super.onPause()
        isVisible = false
    }

    override fun onDestroy() {
        super.onDestroy()
        isVisible = false
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

    // Block back button — kiosk mode: user cannot exit the player
    @Suppress("DEPRECATION")
    override fun onBackPressed() { /* intentionally empty */ }

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
                            contentTier  = c.contentTier ?: "paid",
                            qrEnabled    = c.qrEnabled ?: false,
                            qrPlacement  = c.qrPlacement,
                            qrContentUrl = c.qrContentUrl
                        )
                    }

                    // Preserve existing download state — insertAll(REPLACE) would reset
                    // localFilePath=null on every sync, breaking offline playback.
                    // Only clear download state when content actually changed (storedName differs).
                    val existingMap = db.campaignDao().getAll().associateBy { it.campaignId }
                    val mergedEntities = entities.map { newEntity ->
                        val old = existingMap[newEntity.campaignId]
                        if (old != null && old.storedName == newEntity.storedName && old.isDownloaded) {
                            newEntity.copy(localFilePath = old.localFilePath, isDownloaded = true)
                        } else {
                            newEntity
                        }
                    }

                    db.campaignDao().insertAll(mergedEntities)
                    if (mergedEntities.isNotEmpty()) {
                        db.campaignDao().deleteNotIn(mergedEntities.map { it.campaignId })
                    }

                    downloadContent(mergedEntities)

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
            // Check physical file on disk, not just DB flag — file may have been pruned by OS
            val cachedFile = ContentDownloader.getCachedFile(this, campaign.storedName)
            if (campaign.isDownloaded && cachedFile != null) return@forEach

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
        updateQrOverlay(campaign)

        when (campaign.contentType) {
            "video" -> playVideo(campaign)
            "image" -> showImage(campaign)
            else    -> showImage(campaign)
        }
    }

    private fun updateQrOverlay(campaign: CampaignEntity) {
        val qrView = binding.ivQrOverlay
        if (!campaign.qrEnabled || campaign.qrContentUrl.isNullOrBlank()) {
            qrView.visibility = View.GONE
            return
        }
        Glide.with(this).load(campaign.qrContentUrl).into(qrView)
        qrView.visibility = View.VISIBLE
        qrView.bringToFront()
        // positionQrOnImage() is called from the Glide image load listener (after drawable is ready)
    }

    private fun positionQrOnImage(placement: String?) {
        val iv   = binding.ivImage
        val qr   = binding.ivQrOverlay
        val drawable = iv.drawable ?: return

        val imgW  = drawable.intrinsicWidth.toFloat()
        val imgH  = drawable.intrinsicHeight.toFloat()
        if (imgW <= 0f || imgH <= 0f) return

        val viewW = iv.width.toFloat()
        val viewH = iv.height.toFloat()
        if (viewW <= 0f || viewH <= 0f) return

        // Compute where fitCenter actually draws the image
        val scale   = minOf(viewW / imgW, viewH / imgH)
        val scaledW = imgW * scale
        val scaledH = imgH * scale
        val offsetX = (viewW - scaledW) / 2f
        val offsetY = (viewH - scaledH) / 2f

        val qrSize = 56.dpToPx().toFloat()
        val margin = 12.dpToPx().toFloat()

        val left: Float
        val top: Float
        when (placement) {
            "top-left"  -> { left = offsetX + margin;                         top = offsetY + margin }
            "top-right" -> { left = offsetX + scaledW - qrSize - margin;      top = offsetY + margin }
            "mid-left"  -> { left = offsetX + margin;                         top = offsetY + (scaledH - qrSize) / 2f }
            "mid-right" -> { left = offsetX + scaledW - qrSize - margin;      top = offsetY + (scaledH - qrSize) / 2f }
            "bot-left"  -> { left = offsetX + margin;                         top = offsetY + scaledH - qrSize - margin }
            else        -> { left = offsetX + scaledW - qrSize - margin;      top = offsetY + scaledH - qrSize - margin }
        }

        val params = qr.layoutParams as FrameLayout.LayoutParams
        params.gravity     = android.view.Gravity.TOP or android.view.Gravity.START
        params.leftMargin  = left.toInt()
        params.topMargin   = top.toInt()
        params.rightMargin = 0
        params.bottomMargin= 0
        params.width       = qrSize.toInt()
        params.height      = qrSize.toInt()
        qr.layoutParams = params
        qr.bringToFront()
    }

    private fun Int.dpToPx(): Int =
        (this * resources.displayMetrics.density).toInt()

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
        binding.playerView.resizeMode = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_ZOOM
        player.volume = 0f

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
        Glide.with(this).load(uri)
            .listener(object : RequestListener<Drawable> {
                override fun onLoadFailed(e: GlideException?, model: Any?, target: Target<Drawable>, isFirstResource: Boolean): Boolean {
                    return false
                }
                override fun onResourceReady(resource: Drawable, model: Any, target: Target<Drawable>?, dataSource: DataSource, isFirstResource: Boolean): Boolean {
                    binding.ivImage.post { positionQrOnImage(campaign.qrPlacement) }
                    return false
                }
            })
            .into(binding.ivImage)

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
        // 1. Try the stored local path
        val localFile = campaign.localFilePath?.let { File(it) }
        if (localFile != null && localFile.exists() && localFile.length() > 0) {
            return android.net.Uri.fromFile(localFile)
        }
        // 2. Fallback: look up by filename in the cache directory (covers cases where
        //    localFilePath was reset to null by a sync but the file is still on disk)
        val cachedFile = ContentDownloader.getCachedFile(this, campaign.storedName)
        if (cachedFile != null) {
            return android.net.Uri.fromFile(cachedFile)
        }
        // 3. Last resort: remote URL (only works when online)
        return android.net.Uri.parse(campaign.fileUrl)
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
                // Use Device Owner API for real system reboot; fallback to app restart
                if (KioskManager.isDeviceOwner(this)) {
                    KioskManager.reboot(this)
                } else {
                    finish()
                    startActivity(Intent(this, PlayerActivity::class.java))
                }
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
