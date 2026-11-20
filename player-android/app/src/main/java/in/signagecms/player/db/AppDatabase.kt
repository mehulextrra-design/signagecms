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
    version = 3,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun campaignDao(): CampaignDao
    abstract fun playLogDao(): PlayLogDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        // Migration 1→2: added contentTier to campaigns
        private val MIGRATION_1_2 = object : androidx.room.migration.Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE campaigns ADD COLUMN contentTier TEXT NOT NULL DEFAULT 'paid'")
            }
        }

        // Migration 2→3: added play_log_queue table (preserves any existing data)
        private val MIGRATION_2_3 = object : androidx.room.migration.Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS play_log_queue (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        campaignId TEXT NOT NULL,
                        contentId TEXT NOT NULL,
                        playedAt TEXT NOT NULL,
                        durationSec REAL NOT NULL,
                        playCount INTEGER NOT NULL DEFAULT 1,
                        contentTier TEXT DEFAULT 'paid',
                        synced INTEGER NOT NULL DEFAULT 0,
                        createdAt INTEGER NOT NULL
                    )
                """.trimIndent())
            }
        }

        fun getInstance(context: Context): AppDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "player.db"
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                    // Fallback only for versions we have no migration for — won't delete play_log_queue
                    // as long as migrations above are applied in order.
                    .fallbackToDestructiveMigrationFrom(1)
                    .build()
                    .also { INSTANCE = it }
            }
    }
}
