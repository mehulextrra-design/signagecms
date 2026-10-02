package `in`.signagecms.player.db.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "campaigns")
data class CampaignEntity(
    @PrimaryKey val campaignId: String,
    val campaignCode: String,
    val title: String,
    val startDate: String,
    val endDate: String,
    val startTime: String,
    val endTime: String,
    val status: String,
    val contentId: String,
    val fileUrl: String,
    val storedName: String,
    val contentType: String,   // video | image
    val durationSec: Double,
    val contentTier: String = "paid",
    val localFilePath: String? = null,
    val isDownloaded: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "play_log_queue")
data class PlayLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val campaignId: String,
    val contentId: String,
    val playedAt: String,      // ISO 8601
    val durationSec: Double,
    val playCount: Int = 1,
    val contentTier: String? = "paid",
    val synced: Boolean = false,
    val createdAt: Long = System.currentTimeMillis()
)
