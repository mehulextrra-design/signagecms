package in.pravaah.player.storage

import android.content.Context
import android.util.Log
import in.pravaah.player.models.CampaignSlot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

class ContentCache(private val context: Context) {

    private val cacheDir: File = File(context.filesDir, "content_cache").also { it.mkdirs() }
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    fun getCachedFile(campaignSlot: CampaignSlot): File? {
        val file = cacheFileFor(campaignSlot)
        return if (file.exists() && file.length() > 0) file else null
    }

    suspend fun downloadIfNeeded(campaignSlot: CampaignSlot): File? = withContext(Dispatchers.IO) {
        val file = cacheFileFor(campaignSlot)
        if (file.exists() && file.length() > 0) {
            Log.d(TAG, "Cache HIT: ${file.name}")
            return@withContext file
        }
        Log.d(TAG, "Cache MISS — downloading: ${campaignSlot.fileUrl}")
        try {
            val request = Request.Builder().url(campaignSlot.fileUrl).build()
            val response = http.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.e(TAG, "Download failed: ${response.code} for ${campaignSlot.fileUrl}")
                return@withContext null
            }
            response.body?.byteStream()?.use { input ->
                file.outputStream().use { output ->
                    input.copyTo(output, bufferSize = 8192)
                }
            }
            Log.d(TAG, "Downloaded: ${file.name} (${file.length()} bytes)")
            file
        } catch (e: Exception) {
            Log.e(TAG, "Download exception: ${e.message}", e)
            file.delete()
            null
        }
    }

    fun evictExpired(activeCampaignIds: Set<String>) {
        cacheDir.listFiles()?.forEach { file ->
            val isActive = activeCampaignIds.any { file.name.startsWith(it) }
            if (!isActive) {
                Log.d(TAG, "Evicting: ${file.name}")
                file.delete()
            }
        }
    }

    fun getCacheSize(): Long = cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    private fun cacheFileFor(slot: CampaignSlot): File {
        val ext = when {
            slot.contentType == "video" -> ".mp4"
            slot.fileUrl.endsWith(".png", true) -> ".png"
            slot.fileUrl.endsWith(".webp", true) -> ".webp"
            else -> ".jpg"
        }
        return File(cacheDir, "${slot.campaignId}_${slot.contentId}$ext")
    }

    companion object { private const val TAG = "ContentCache" }
}
