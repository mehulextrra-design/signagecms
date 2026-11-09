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
import `in`.signagecms.player.api.models.PairRequest
import `in`.signagecms.player.databinding.ActivitySetupBinding
import `in`.signagecms.player.update.AppUpdater
import `in`.signagecms.player.utils.Prefs
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding
    private lateinit var prefs: Prefs
    private var polling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.getInstance(this)

        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (prefs.isRegistered) {
            showRegisteredScreen()
            return
        }

        startPairing()
    }

    override fun onDestroy() {
        super.onDestroy()
        polling = false
    }

    // ── Pairing flow ──────────────────────────────────────────────────────

    private fun startPairing() {
        val code = getOrCreatePairingCode()
        binding.tvPairingCode.text = code
        binding.layoutPairing.visibility = View.VISIBLE
        binding.layoutRegistered.visibility = View.GONE
        binding.tvBindStatus.text = "Admin Panel me kisi bhi screen pe ye code enter karo"
        binding.tvError.visibility = View.GONE

        sendPairRequest(code)
        polling = true
        pollPairStatus(code)
    }

    private fun getOrCreatePairingCode(): String {
        val existing = prefs.pairingCode
        if (!existing.isNullOrEmpty()) return existing
        val newCode = (100000..999999).random().toString()
        prefs.pairingCode = newCode
        return newCode
    }

    private fun sendPairRequest(code: String) {
        lifecycleScope.launch {
            try {
                val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
                RetrofitClient.apiService.requestPairing(
                    PairRequest(
                        pairingCode = code,
                        deviceId = deviceId,
                        androidVersion = Build.VERSION.RELEASE,
                        appVersion = BuildConfig.VERSION_NAME
                    )
                )
            } catch (_: Exception) {}
        }
    }

    private fun pollPairStatus(code: String) {
        lifecycleScope.launch {
            while (polling) {
                delay(5000)
                if (!polling) break
                try {
                    val resp = RetrofitClient.apiService.getPairStatus(code)
                    if (resp.isSuccessful) {
                        val body = resp.body() ?: continue
                        when (body.status) {
                            "bound" -> {
                                val screen = body.screen
                                val token = body.token
                                if (screen != null && token != null) {
                                    polling = false
                                    prefs.playerToken = token
                                    prefs.screenId = screen.id
                                    prefs.screenCode = screen.screenCode
                                    prefs.screenName = screen.name
                                    prefs.syncIntervalSec = body.syncIntervalSec ?: 300
                                    prefs.heartbeatIntervalSec = body.heartbeatIntervalSec ?: 60
                                    prefs.pairingCode = null
                                    binding.tvBindStatus.text = "Bound! Screen: ${screen.name}"
                                    delay(800)
                                    startPlayer()
                                }
                            }
                            "pending" -> {
                                // keep polling silently
                            }
                            "not_found" -> {
                                // re-register the code
                                sendPairRequest(code)
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    // ── Already registered ────────────────────────────────────────────────

    private fun showRegisteredScreen() {
        binding.layoutPairing.visibility = View.GONE
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

        Handler(Looper.getMainLooper()).postDelayed({ startPlayer() }, 60000)
    }

    private fun showUpdateStatus(msg: String, colorHex: String) {
        binding.tvUpdateStatus.text = msg
        binding.tvUpdateStatus.setTextColor(android.graphics.Color.parseColor(colorHex))
        binding.tvUpdateStatus.visibility = View.VISIBLE
    }

    // ── Shared helpers ────────────────────────────────────────────────────

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
                } catch (_: Exception) {}
            }
        }
    }
}
