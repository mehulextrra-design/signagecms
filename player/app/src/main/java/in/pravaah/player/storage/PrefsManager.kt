package in.pravaah.player.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class PrefsManager(context: Context) {

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "pravaah_player_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var playerToken: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var screenCode: String?
        get() = prefs.getString(KEY_SCREEN_CODE, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_CODE, value).apply()

    var screenId: String?
        get() = prefs.getString(KEY_SCREEN_ID, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_ID, value).apply()

    var screenName: String?
        get() = prefs.getString(KEY_SCREEN_NAME, null)
        set(value) = prefs.edit().putString(KEY_SCREEN_NAME, value).apply()

    var apiBaseUrl: String?
        get() = prefs.getString(KEY_API_URL, null)
        set(value) = prefs.edit().putString(KEY_API_URL, value).apply()

    var syncIntervalSec: Int
        get() = prefs.getInt(KEY_SYNC_INTERVAL, 300)
        set(value) = prefs.edit().putInt(KEY_SYNC_INTERVAL, value).apply()

    var heartbeatIntervalSec: Int
        get() = prefs.getInt(KEY_HB_INTERVAL, 60)
        set(value) = prefs.edit().putInt(KEY_HB_INTERVAL, value).apply()

    val isRegistered: Boolean get() = playerToken != null && screenCode != null

    fun clearAll() = prefs.edit().clear().apply()

    companion object {
        private const val KEY_TOKEN = "player_token"
        private const val KEY_SCREEN_CODE = "screen_code"
        private const val KEY_SCREEN_ID = "screen_id"
        private const val KEY_SCREEN_NAME = "screen_name"
        private const val KEY_API_URL = "api_base_url"
        private const val KEY_SYNC_INTERVAL = "sync_interval"
        private const val KEY_HB_INTERVAL = "hb_interval"
    }
}
