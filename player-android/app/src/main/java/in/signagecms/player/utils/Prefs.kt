package `in`.signagecms.player.utils

import android.content.Context
import android.content.SharedPreferences

class Prefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("player_prefs", Context.MODE_PRIVATE)

    var playerToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var screenId: String?
        get() = prefs.getString(KEY_SCREEN_ID, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_ID, value).apply()

    var screenCode: String?
        get() = prefs.getString(KEY_SCREEN_CODE, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_CODE, value).apply()

    var screenName: String?
        get() = prefs.getString(KEY_SCREEN_NAME, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_NAME, value).apply()

    var syncIntervalSec: Int
        get() = prefs.getInt(KEY_SYNC_INTERVAL, 300)
        set(value) = prefs.edit().putInt(KEY_SYNC_INTERVAL, value).apply()

    var heartbeatIntervalSec: Int
        get() = prefs.getInt(KEY_HEARTBEAT_INTERVAL, 60)
        set(value) = prefs.edit().putInt(KEY_HEARTBEAT_INTERVAL, value).apply()

    val isRegistered: Boolean
        get() = playerToken != null && screenId != null

    fun clear() = prefs.edit().clear().apply()

    companion object {
        private const val KEY_TOKEN = "player_token"
        private const val KEY_SCREEN_ID = "screen_id"
        private const val KEY_SCREEN_CODE = "screen_code"
        private const val KEY_SCREEN_NAME = "screen_name"
        private const val KEY_SYNC_INTERVAL = "sync_interval_sec"
        private const val KEY_HEARTBEAT_INTERVAL = "heartbeat_interval_sec"

        @Volatile
        private var INSTANCE: Prefs? = null

        fun getInstance(context: Context): Prefs =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Prefs(context.applicationContext).also { INSTANCE = it }
            }
    }
}
