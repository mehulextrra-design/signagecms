package `in`.signagecms.player

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import `in`.signagecms.player.api.RetrofitClient
import `in`.signagecms.player.api.models.RegisterRequest
import `in`.signagecms.player.databinding.ActivitySetupBinding
import `in`.signagecms.player.update.AppUpdater
import `in`.signagecms.player.utils.Prefs
import kotlinx.coroutines.launch

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.getInstance(this)

        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Already registered → show info screen (version + update button)
        if (prefs.isRegistered) {
            showRegisteredScreen()
            return
        }

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

    private fun showRegisteredScreen() {
        binding.layoutRegistered.visibility = View.VISIBLE
        binding.tvRegScreenCode.text = prefs.screenCode ?: "—"
        binding.tvRegScreenName.text = prefs.screenName ?: "—"
        binding.tvRegVersion.text = "Current version: v${BuildConfig.VERSION_NAME}"

        binding.btnCheckUpdate.setOnClickListener {
            binding.btnCheckUpdate.isEnabled = false
            binding.btnCheckUpdate.text = "Checking…"
            binding.tvUpdateStatus.visibility = View.GONE
            lifecycleScope.launch {
                try {
                    val resp = RetrofitClient.apiService.getAppVersion()
                    val info = resp.body()
                    if (info != null && info.versionCode > BuildConfig.VERSION_CODE) {
                        showUpdateStatus("Update available: v${info.versionName} — downloading…", "#16a34a")
                        AppUpdater.checkAndUpdate(this@SetupActivity)
                        showUpdateStatus("Update downloaded! App will restart shortly.", "#16a34a")
                    } else {
                        showUpdateStatus("Already on latest version (v${BuildConfig.VERSION_NAME})", "#64748B")
                    }
                } catch (e: Exception) {
                    showUpdateStatus("Error: ${e.message}", "#EF4444")
                } finally {
                    binding.btnCheckUpdate.isEnabled = true
                    binding.btnCheckUpdate.text = "Check for Update"
                }
            }
        }

        binding.btnGoToPlayer.setOnClickListener { startPlayer() }

        // Auto-start player after 5 seconds
        Handler(Looper.getMainLooper()).postDelayed({ startPlayer() }, 5000)
    }

    private fun showUpdateStatus(msg: String, colorHex: String) {
        binding.tvUpdateStatus.text = msg
        binding.tvUpdateStatus.setTextColor(android.graphics.Color.parseColor(colorHex))
        binding.tvUpdateStatus.visibility = View.VISIBLE
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
