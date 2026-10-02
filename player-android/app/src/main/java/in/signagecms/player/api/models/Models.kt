package `in`.signagecms.player.api.models

import com.google.gson.annotations.SerializedName

// ── REGISTER ──────────────────────────────────────────────────────────────

data class RegisterRequest(
    @SerializedName("screen_code") val screenCode: String,
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("android_version") val androidVersion: String,
    @SerializedName("app_version") val appVersion: String
)

data class RegisterResponse(
    val token: String,
    val screen: ScreenInfo,
    @SerializedName("sync_interval_sec") val syncIntervalSec: Int,
    @SerializedName("heartbeat_interval_sec") val heartbeatIntervalSec: Int
)

data class ScreenInfo(
    val id: String,
    @SerializedName("screen_code") val screenCode: String,
    val name: String,
    @SerializedName("width_px") val widthPx: Int,
    @SerializedName("height_px") val heightPx: Int
)

// ── SCHEDULE ──────────────────────────────────────────────────────────────

data class ScheduleResponse(
    @SerializedName("screen_id") val screenId: String,
    @SerializedName("server_time") val serverTime: String,
    @SerializedName("content_version") val contentVersion: String?,
    val campaigns: List<CampaignItem>
)

data class CampaignItem(
    @SerializedName("campaign_id") val campaignId: String,
    @SerializedName("campaign_code") val campaignCode: String?,
    val title: String?,
    @SerializedName("start_date") val startDate: String?,
    @SerializedName("end_date") val endDate: String?,
    @SerializedName("start_time") val startTime: String?,
    @SerializedName("end_time") val endTime: String?,
    val status: String?,
    @SerializedName("content_id") val contentId: String,
    @SerializedName("file_url") val fileUrl: String,
    @SerializedName("stored_name") val storedName: String?,   // nullable — fallback to URL filename
    @SerializedName("content_type") val contentType: String,  // video | image
    @SerializedName("duration_sec") val durationSec: Double?,
    @SerializedName("width_px") val widthPx: Int?,
    @SerializedName("height_px") val heightPx: Int?,
    @SerializedName("file_size") val fileSize: Long?,
    val weight: Double?,
    @SerializedName("content_tier") val contentTier: String?
)

// ── HEARTBEAT ─────────────────────────────────────────────────────────────

data class HeartbeatRequest(
    @SerializedName("ip_address") val ipAddress: String?,
    @SerializedName("app_version") val appVersion: String,
    @SerializedName("android_version") val androidVersion: String,
    @SerializedName("uptime_sec") val uptimeSec: Long,
    @SerializedName("is_playing") val isPlaying: Boolean,
    @SerializedName("current_campaign_id") val currentCampaignId: String?,
    @SerializedName("content_version") val contentVersion: String?
)

data class HeartbeatResponse(
    val ok: Boolean,
    @SerializedName("server_time") val serverTime: String,
    val commands: List<RemoteCommand>,
    @SerializedName("should_reload") val shouldReload: Boolean?,
    @SerializedName("content_version") val contentVersion: String?
)

data class RemoteCommand(
    val command: String,  // reload | reboot | clear_cache
    val payload: String?
)

// ── PROOF OF PLAY ─────────────────────────────────────────────────────────

data class PlayEntry(
    @SerializedName("campaign_id") val campaignId: String,
    @SerializedName("content_id") val contentId: String,
    @SerializedName("played_at") val playedAt: String,  // ISO 8601
    @SerializedName("duration_sec") val durationSec: Double,
    @SerializedName("play_count") val playCount: Int = 1,
    @SerializedName("content_tier") val contentTier: String? = null
)

data class ProofOfPlayRequest(
    val plays: List<PlayEntry>
)

data class ProofOfPlayResponse(
    val ok: Boolean,
    val inserted: Int
)
