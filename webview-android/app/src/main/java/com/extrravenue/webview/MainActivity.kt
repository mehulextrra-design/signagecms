package com.extrravenue.webview

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.extrravenue.webview.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris: Array<Uri>? = if (result.resultCode == RESULT_OK) {
            result.data?.let { data ->
                data.clipData?.let { clip ->
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                } ?: data.data?.let { arrayOf(it) }
            }
        } else null
        fileUploadCallback?.onReceiveValue(uris ?: emptyArray())
        fileUploadCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(null)

        setupWebView()

        binding.btnRetry.setOnClickListener {
            binding.layoutOffline.visibility = View.GONE
            binding.webView.loadUrl(BuildConfig.PORTAL_URL)
        }

        binding.webView.loadUrl(BuildConfig.PORTAL_URL)

        AppUpdater(this).checkForUpdate()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(Menu.NONE, MENU_RELOAD, Menu.NONE, "Reload")
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == MENU_RELOAD) {
            binding.webView.reload()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val ws = binding.webView.settings
        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.allowFileAccess = true
        ws.loadWithOverviewMode = true
        ws.useWideViewPort = true
        ws.setSupportZoom(true)
        ws.builtInZoomControls = true
        ws.displayZoomControls = false
        ws.cacheMode = WebSettings.LOAD_DEFAULT
        ws.mediaPlaybackRequiresUserGesture = false

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(binding.webView, true)

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                binding.progressBar.visibility = View.VISIBLE
                binding.layoutOffline.visibility = View.GONE
            }
            override fun onPageFinished(view: WebView, url: String) {
                binding.progressBar.visibility = View.GONE
                CookieManager.getInstance().flush()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    binding.progressBar.visibility = View.GONE
                    binding.layoutOffline.visibility = View.VISIBLE
                }
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                return try {
                    filePickerLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (e: Exception) {
                    fileUploadCallback = null
                    false
                }
            }
        }
    }

    override fun onBackPressed() {
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    companion object {
        private const val MENU_RELOAD = 1
    }
}
