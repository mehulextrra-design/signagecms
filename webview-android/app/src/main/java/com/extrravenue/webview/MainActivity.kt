package com.extrravenue.webview

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.extrravenue.webview.BuildConfig
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

        setupWebView()

        binding.swipeRefresh.setColorSchemeColors(0xFF7b68c8.toInt())
        binding.swipeRefresh.setOnChildScrollUpCallback { _, _ -> binding.webView.scrollY > 0 }
        binding.swipeRefresh.setOnRefreshListener { binding.webView.reload() }

        binding.btnRetry.setOnClickListener {
            binding.layoutOffline.visibility = View.GONE
            binding.webView.reload()
        }

        binding.webView.loadUrl(BuildConfig.PORTAL_URL)

        AppUpdater(this).checkForUpdate()
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
                binding.swipeRefresh.isRefreshing = true
                binding.layoutOffline.visibility = View.GONE
            }
            override fun onPageFinished(view: WebView, url: String) {
                binding.swipeRefresh.isRefreshing = false
                CookieManager.getInstance().flush()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    binding.swipeRefresh.isRefreshing = false
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
}
