package in.pravaah.player

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import com.google.gson.Gson
import in.pravaah.player.api.ApiClient
import in.pravaah.player.models.RegisterRequest
import in.pravaah.player.player.PlaylistEngine
import in.pravaah.player.services.DeviceAdminReceiver
import in.pravaah.player.services.SyncService
import in.pravaah.player.storage.ContentCache
import in.pravaah.player.storage.PrefsManager
import kotlinx.coroutines.*

class SetupActivity : Activity() {

    companion object { private const val TAG = "SetupActivity" }

    private lateinit var prefs: PrefsManager
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var setupContainer: View
    private lateinit var etScreenCode: EditText
    private lateinit var etApiUrl: EditText
    private lateinit var btnRegister: Button
    private lateinit var progressBar: ProgressBar
    private lateinit var tvStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = PrefsManager(this)

        // Already registered — go straight to player
        if (prefs.isRegistered) {
            launchPlayer(null)
            return
        }

        setContentView(R.layout.activity_setup)
        setupContainer = findViewById(R.id.setup_container)
        etScreenCode = findViewById(R.id.et_screen_code)
        etApiUrl = findViewById(R.id.et_api_url)
        btnRegister = findViewById(R.id.btn_register)
        progressBar = findViewById(R.id.progress_bar)
        tvStatus = findViewById(R.id.tv_status)

        // Pre-fill API URL from BuildConfig
        etApiUrl.setText(BuildConfig.API_BASE_URL)

        btnRegister.setOnClickListener { startRegistration() }
    }

    private fun startRegistration() {
        val screenCode = etScreenCode.text.toString().trim().uppercase()
        val apiUrl = etApiUrl.text.toString().trim().trimEnd('/')

        if (screenCode.isEmpty()) { tvStatus.text = "Enter screen code (e.g. PHX-001)"; return }
        if (apiUrl.isEmpty()) { tvStatus.text = "Enter API base URL"; return }

        btnRegister.isEnabled = false
        progressBar.visibility = View.VISIBLE
        tvStatus.text = "Registering..."

        prefs.apiBaseUrl = "$apiUrl/api/"
        ApiClient.reset()

        scope.launch {
            try {
                val response = ApiClient.getInstance(this@SetupActivity).register(
                    RegisterRequest(
                        screenCode = screenCode,
                        deviceId = android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID),
                        androidVersion = Build.VERSION.RELEASE,
                        appVersion = BuildConfig.VERSION_NAME
                    )
                )
                if (response.isSuccessful) {
                    val body = response.body()!!
                    prefs.playerToken = body.token
                    prefs.screenCode = body.screen.screenCode
                    prefs.screenId = body.screen.id
                    prefs.screenName = body.screen.name
                    prefs.syncIntervalSec = body.syncIntervalSec
                    prefs.heartbeatIntervalSec = body.heartbeatIntervalSec
                    ApiClient.reset()  // rebuild with new token

                    tvStatus.text = "Registered: ${body.screen.name}"
                    DeviceAdminReceiver.startKioskMode(this@SetupActivity)

                    delay(1000)

                    // Fetch initial schedule
                    tvStatus.text = "Fetching schedule..."
                    val scheduleResp = ApiClient.getInstance(this@SetupActivity).getSchedule()
                    val campaigns = if (scheduleResp.isSuccessful) scheduleResp.body()?.campaigns ?: emptyList() else emptyList()

                    // Pre-cache content
                    tvStatus.text = "Pre-loading content (${campaigns.size} campaigns)..."
                    val cache = ContentCache(this@SetupActivity)
                    campaigns.forEach { slot ->
                        launch(Dispatchers.IO) { cache.downloadIfNeeded(slot) }
                    }

                    launchPlayer(campaigns)
                } else {
                    val err = response.errorBody()?.string()
                    tvStatus.text = "Error: ${response.code()} — $err"
                    btnRegister.isEnabled = true
                    progressBar.visibility = View.GONE
                }
            } catch (e: Exception) {
                Log.e(TAG, "Registration failed: ${e.message}", e)
                tvStatus.text = "Failed: ${e.message}"
                btnRegister.isEnabled = true
                progressBar.visibility = View.GONE
            }
        }
    }

    private fun launchPlayer(campaigns: List<in.pravaah.player.models.CampaignSlot>?) {
        startService(Intent(this, SyncService::class.java))
        val intent = Intent(this, PlayerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (campaigns != null) putExtra(PlayerActivity.EXTRA_CAMPAIGNS, Gson().toJson(campaigns))
        }
        startActivity(intent)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}
