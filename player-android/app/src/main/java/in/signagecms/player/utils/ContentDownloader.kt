package `in`.signagecms.player.utils

import android.content.Context
import `in`.signagecms.player.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

object ContentDownloader {

    private fun fixUrl(url: String): String {
        if (url.contains("localhost") || url.contains("127.0.0.1")) {
            val serverBase = BuildConfig.API_BASE_URL
                .removeSuffix("api/").removeSuffix("/")
            val filePart = url.substringAfter("/uploads/", "")
            if (filePart.isNotEmpty()) return "$serverBase/uploads/$filePart"
        }
        return url
    }

    // Download file and save to app's private cache directory.
    // Returns local File path on success, null on failure.
    suspend fun download(context: Context, fileUrl: String, fileName: String): File? =
        withContext(Dispatchers.IO) {
            try {
                val cacheDir = File(context.filesDir, "content").apply { mkdirs() }
                val destFile = File(cacheDir, fileName)

                // Already downloaded
                if (destFile.exists() && destFile.length() > 0) return@withContext destFile

                val url = URL(fixUrl(fileUrl))
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 30_000
                conn.readTimeout = 120_000
                conn.requestMethod = "GET"
                conn.connect()

                if (conn.responseCode != 200) {
                    conn.disconnect()
                    return@withContext null
                }

                conn.inputStream.use { input ->
                    destFile.outputStream().use { output ->
                        input.copyTo(output, bufferSize = 8 * 1024)
                    }
                }
                conn.disconnect()
                destFile
            } catch (e: Exception) {
                null
            }
        }

    fun getCachedFile(context: Context, fileName: String): File? {
        val file = File(File(context.filesDir, "content"), fileName)
        return if (file.exists() && file.length() > 0) file else null
    }

    // Delete cached files not in current schedule
    fun pruneOldFiles(context: Context, activeFileNames: Set<String>) {
        val cacheDir = File(context.filesDir, "content")
        if (!cacheDir.exists()) return
        cacheDir.listFiles()?.forEach { file ->
            if (file.name !in activeFileNames) {
                file.delete()
            }
        }
    }

    fun clearAll(context: Context) {
        File(context.filesDir, "content").deleteRecursively()
    }
}
