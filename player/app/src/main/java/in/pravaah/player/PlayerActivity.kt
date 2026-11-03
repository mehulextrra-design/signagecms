package in.pravaah.player

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import android.widget.VideoView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.load
import in.pravaah.player.models.CampaignSlot
import in.pravaah.player.models.PlayLog
import in.pravaah.player.player.PlaylistEngine
import in.pravaah.player.services.SyncService
import in.pravaah.player.storage.ContentCache
import java.io.File
import java.time.Instant

@SuppressLint("ClickableViewAccessibility")
class PlayerActivity : Activity() {

    companion object {
        private const val TAG = "PlayerActivity"
        const val EXTRA_CAMPAIGNS = "campaigns_json"
        private const val IMAGE_DISPLAY_MS = 10_000L  // 10 seconds for images
    }

    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var statusText: TextView
    private lateinit var screenCodeText: TextView

    private var exoPlayer: ExoPlayer? = null
    private val playlistEngine = PlaylistEngine()
    private lateinit var contentCache: ContentCache

    private var allSlots: List<CampaignSlot> = emptyList()
    private var playQueue: List<CampaignSlot> = emptyList()
    private var currentIndex = -1
    private val pendingLogs = mutableListOf<PlayLog>()
    private val handler = Handler(Looper.getMainLooper())

    private val logFlushRunnable = Runnable { flushLogs() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        keepScreenOn()
        setContentView(R.layout.activity_player)
        contentCache = ContentCache(this)

        playerView = findViewById(R.id.exo_player_view)
        imageView = findViewById(R.id.image_view)
        statusText = findViewById(R.id.status_text)
        screenCodeText = findViewById(R.id.screen_code_text)

        val prefs = in.pravaah.player.storage.PrefsManager(this)
        screenCodeText.text = prefs.screenCode ?: ""

        // Receive schedule from SyncService via intent (Gson-serialized JSON)
        val json = intent.getStringExtra(EXTRA_CAMPAIGNS)
        if (json != null) {
            val gson = com.google.gson.Gson()
            val type = object : com.google.gson.reflect.TypeToken<List<CampaignSlot>>() {}.type
            allSlots = gson.fromJson(json, type) ?: emptyList()
        }

        // Register broadcast receiver to get schedule updates from SyncService
        val filter = android.content.IntentFilter(SyncService.ACTION_SCHEDULE_UPDATED)
        registerReceiver(scheduleReceiver, filter)

        startPlayback()

        // Flush PoP logs every 5 minutes
        handler.postDelayed(logFlushRunnable, 5 * 60 * 1000L)
    }

    private fun startPlayback() {
        playQueue = playlistEngine.buildPlayQueue(allSlots)
        Log.d(TAG, "Play queue: ${playQueue.size} campaigns")
        if (playQueue.isEmpty()) {
            showScreensaver()
        } else {
            playNext()
        }
    }

    private fun playNext() {
        val result = playlistEngine.nextSlot(playQueue, currentIndex) ?: run {
            showScreensaver()
            return
        }
        val (slot, newIndex) = result
        currentIndex = newIndex

        val cachedFile = contentCache.getCachedFile(slot)
        if (cachedFile != null) {
            playCached(slot, cachedFile)
        } else {
            // Download in background, show screensaver meanwhile
            Log.w(TAG, "Cache miss at play time for ${slot.campaignCode} — downloading async")
            showStatus("Loading: ${slot.title}")
            kotlinx.coroutines.GlobalScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                val file = contentCache.downloadIfNeeded(slot)
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                    if (file != null) playCached(slot, file) else playNext()
                }
            }
        }
    }

    @OptIn(UnstableApi::class)
    private fun playCached(slot: CampaignSlot, file: File) {
        val playedAt = Instant.now().toString()
        if (slot.contentType == "video") {
            imageView.visibility = View.GONE
            playerView.visibility = View.VISIBLE
            statusText.visibility = View.GONE

            exoPlayer?.release()
            exoPlayer = ExoPlayer.Builder(this).build().also {
                playerView.player = it
                it.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
                it.prepare()
                it.playWhenReady = true
                it.addListener(object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_ENDED) {
                            recordPlay(slot, playedAt)
                            playNext()
                        }
                    }
                })
            }
        } else {
            // Image — display for IMAGE_DISPLAY_MS
            exoPlayer?.pause()
            exoPlayer?.release()
            exoPlayer = null
            playerView.visibility = View.GONE
            imageView.visibility = View.VISIBLE
            statusText.visibility = View.GONE
            imageView.load(file) {
                crossfade(500)
            }
            handler.postDelayed({
                recordPlay(slot, playedAt)
                playNext()
            }, IMAGE_DISPLAY_MS)
        }

        Log.d(TAG, "Playing: ${slot.campaignCode} — ${slot.title} (${slot.contentType})")
    }

    private fun recordPlay(slot: CampaignSlot, playedAt: String) {
        pendingLogs.add(PlayLog(
            campaignId = slot.campaignId,
            contentId = slot.contentId,
            playedAt = playedAt,
            durationSec = slot.durationSec
        ))
    }

    private fun flushLogs() {
        if (pendingLogs.isNotEmpty()) {
            val toUpload = pendingLogs.toList()
            pendingLogs.clear()
            SyncService.uploadPlayLogs(this, toUpload)
        }
        handler.postDelayed(logFlushRunnable, 5 * 60 * 1000L)
    }

    private fun showScreensaver() {
        exoPlayer?.release(); exoPlayer = null
        playerView.visibility = View.GONE
        imageView.visibility = View.GONE
        showStatus("No active campaigns")
        // Retry in 60 seconds
        handler.postDelayed({ startPlayback() }, 60_000L)
    }

    private fun showStatus(msg: String) {
        statusText.text = msg
        statusText.visibility = View.VISIBLE
    }

    private fun keepScreenOn() {
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        )
    }

    private val scheduleReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
            val json = intent.getStringExtra(SyncService.EXTRA_CAMPAIGNS_JSON) ?: return
            val gson = com.google.gson.Gson()
            val type = object : com.google.gson.reflect.TypeToken<List<CampaignSlot>>() {}.type
            allSlots = gson.fromJson(json, type) ?: emptyList()
            playQueue = playlistEngine.buildPlayQueue(allSlots)
            Log.d(TAG, "Schedule updated: ${allSlots.size} campaigns, ${playQueue.size} active")
            // Prefetch new content in background
            contentCache.evictExpired(allSlots.map { it.campaignId }.toSet())
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        exoPlayer?.release()
        handler.removeCallbacksAndMessages(null)
        flushLogs()
        try { unregisterReceiver(scheduleReceiver) } catch (_: Exception) {}
    }

    override fun onBackPressed() { /* Consume back press — kiosk mode */ }
}
