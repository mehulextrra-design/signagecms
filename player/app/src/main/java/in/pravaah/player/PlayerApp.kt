package in.pravaah.player

import android.app.Application
import android.util.Log

class PlayerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.d("PlayerApp", "Pravaah Signage Player v${BuildConfig.VERSION_NAME} starting")
    }
}
