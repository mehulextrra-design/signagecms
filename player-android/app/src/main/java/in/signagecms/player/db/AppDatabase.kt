package `in`.signagecms.player.db

import android.content.Context
import androidx.room.*
import `in`.signagecms.player.db.entities.CampaignEntity
import `in`.signagecms.player.db.entities.PlayLogEntity

@Dao
interface CampaignDao {
    @Query("SELECT * FROM campaigns ORDER BY startDate ASC")
    suspend fun getAll(): List<CampaignEntity>

    @Query("SELECT * FROM campaigns WHERE campaignId = :id LIMIT 1")
    suspend fun getById(id: String): CampaignEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(campaigns: List<CampaignEntity>)

    @Query("UPDATE campaigns SET localFilePath = :path, isDownloaded = 1 WHERE campaignId = :id")
    suspend fun markDownloaded(id: String, path: String)

    @Query("DELETE FROM campaigns WHERE campaignId NOT IN (:ids)")
    suspend fun deleteNotIn(ids: List<String>)

    @Query("DELETE FROM campaigns")
    suspend fun deleteAll()
}

@Dao
interface PlayLogDao {
    @Insert
    suspend fun insert(log: PlayLogEntity)

    @Query("SELECT * FROM play_log_queue WHERE synced = 0 ORDER BY createdAt ASC LIMIT 50")
    suspend fun getUnsynced(): List<PlayLogEntity>

    @Query("UPDATE play_log_queue SET synced = 1 WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<Long>)

    @Query("DELETE FROM play_log_queue WHERE synced = 1 AND createdAt < :olderThan")
    suspend fun deleteOldSynced(olderThan: Long)
}

@Database(
    entities = [CampaignEntity::class, PlayLogEntity::class],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun campaignDao(): CampaignDao
    abstract fun playLogDao(): PlayLogDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "player.db"
                ).fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
    }
}
