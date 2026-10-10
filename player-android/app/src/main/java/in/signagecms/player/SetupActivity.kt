package `in`.signagecms.player

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import `in`.signagecms.player.api.RetrofitClient
import `in`.signagecms.player.api.models.RegisterRequest
import `in`.signagecms.player.databinding.ActivitySetupBinding
import `in`.signagecms.player.utils.Prefs
import kotlinx.coroutines.launch

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.getInstance(this)

        // Already registered → go straight to player
        if (prefs.isRegistered) {
            startPlayer()
            return
        }

        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnRegister.setOnClickListener { doRegister() }
    }

    private fun doRegister() {
        val screenCode = binding.etScreenCode.text.toString().trim().uppercase()
        if (screenCode.isEmpty()) {
            showError("Please enter a Screen Code")
            return
        }

        setLoading(true)
        binding.tvError.visibility = View.GONE

        lifecycleScope.launch {
            try {
                val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                    ?: "unknown"
                val androidVer = Build.VERSION.RELEASE
                val appVer = BuildConfig.VERSION_NAME

                val response = RetrofitClient.apiService.register(
                    RegisterRequest(
                        screenCode = screenCode,
                        deviceId = deviceId,
                        androidVersion = androidVer,
                        appVersion = appVer
                    )
                )

                if (response.isSuccessful) {
                    val body = response.body()!!
                    prefs.playerToken = body.token
                    prefs.screenId = body.screen.id
                    prefs.screenCode = body.screen.screenCode
                    prefs.screenName = body.screen.name
                    prefs.syncIntervalSec = body.syncIntervalSec
                    prefs.heartbeatIntervalSec = body.heartbeatIntervalSec
                    startPlayer()
                } else {
                    val code = response.code()
                    val msg = when (code) {
                        404 -> "Screen code '${screenCode}' not found in Admin Panel.\nPlease add this screen first."
                        else -> "Registration failed (HTTP $code). Check your network."
                    }
                    showError(msg)
                }
            } catch (e: Exception) {
                showError("Network error: ${e.message}\nCheck internet connection.")
            } finally {
                setLoading(false)
            }
        }
    }

    private fun startPlayer() {
        requestBatteryOptimizationExemption()
        startActivity(Intent(this, PlayerActivity::class.java))
        finish()
    }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(PowerManager::class.java)
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                    )
                } catch (e: Exception) { /* some TV boxes don't have this screen */ }
            }
        }
    }

    private fun showError(msg: String) {
        binding.tvError.text = msg
        binding.tvError.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        binding.btnRegister.isEnabled = !loading
        binding.btnRegister.text = if (loading) "Registering…" else "Register This Screen"
        binding.etScreenCode.isEnabled = !loading
    }
}
