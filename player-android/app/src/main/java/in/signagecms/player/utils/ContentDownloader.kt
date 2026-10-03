package `in`.signagecms.player.utils

import android.content.Context
import `in`.signagecms.player.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

object ContentDownloader {

    private const val TAG = "ContentDownloader"

    // Cloudinary stored_name can have slashes (e.g. "signagecms/uploads/filename").
    // Flatten them to underscores so File() doesn't try to create subdirectories.
    private fun safeFileName(name: String): String =
        name.replace('/', '_').replace('\\', '_').trimStart('_')

    private fun fixUrl(url: String): String {
        // Relative path → prepend server base (e.g. "uploads/file.mp4" → full URL)
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            val serverBase = BuildConfig.API_BASE_URL
                .removeSuffix("api/").removeSuffix("/")
            return "$serverBase/${url.trimStart('/')}"
        }
        if (url.contains("localhost") || url.contains("127.0.0.1")) {
            val serverBase = BuildConfig.API_BASE_URL
                .removeSuffix("api/").removeSuffix("/")
            val filePart = url.substringAfter("/uploads/", "")
            if (filePart.isNotEmpty()) return "$serverBase/uploads/$filePart"
        }
        return url
    }

    // Download file and save to app's private cache directory.
    // Returns local File on success, null on failure (logs the error).
    suspend fun download(context: Context, fileUrl: String, fileName: String): File? =
        withContext(Dispatchers.IO) {
            val safeName = safeFileName(fileName)
            try {
                val cacheDir = File(context.filesDir, "content").apply { mkdirs() }
                val destFile = File(cacheDir, safeName)

                // Already downloaded
                if (destFile.exists() && destFile.length() > 0) return@withContext destFile

                val fixedUrl = fixUrl(fileUrl)
                android.util.Log.d(TAG, "Downloading: $safeName from $fixedUrl")

                val url = URL(fixedUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 30_000
                conn.readTimeout = 180_000   // 3 min for large videos
                conn.requestMethod = "GET"
                conn.instanceFollowRedirects = true
                conn.connect()

                if (conn.responseCode != 200) {
                    android.util.Log.e(TAG, "HTTP ${conn.responseCode} for $safeName — not cached")
                    conn.disconnect()
                    return@withContext null
                }

                val tmp = File(cacheDir, "$safeName.tmp")
                try {
                    conn.inputStream.use { input ->
                        tmp.outputStream().use { output ->
                            input.copyTo(output, bufferSize = 64 * 1024)
                        }
                    }
                    tmp.renameTo(destFile)
                } catch (e: Exception) {
                    tmp.delete()
                    throw e
                } finally {
                    conn.disconnect()
                }

                android.util.Log.d(TAG, "Cached: $safeName (${destFile.length() / 1024}KB)")
                destFile
            } catch (e: Exception) {
                android.util.Log.e(TAG, "Download failed for $safeName: ${e.message}")
                null
            }
        }

    fun getCachedFile(context: Context, fileName: String): File? {
        val file = File(File(context.filesDir, "content"), safeFileName(fileName))
        return if (file.exists() && file.length() > 0) file else null
    }

    // Delete cached files not in current schedule
    fun pruneOldFiles(context: Context, activeFileNames: Set<String>) {
        val cacheDir = File(context.filesDir, "content")
        if (!cacheDir.exists()) return
        val safeActive = activeFileNames.map { safeFileName(it) }.toSet()
        cacheDir.listFiles()?.forEach { file ->
            // Never delete a .tmp file that is still being written
            if (!file.name.endsWith(".tmp") && file.name !in safeActive) {
                android.util.Log.d(TAG, "Pruning old file: ${file.name}")
                file.delete()
            }
        }
    }

    fun clearAll(context: Context) {
        File(context.filesDir, "content").deleteRecursively()
    }
}
