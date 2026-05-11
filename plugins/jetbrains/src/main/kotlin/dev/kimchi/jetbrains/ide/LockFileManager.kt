package dev.kimchi.jetbrains.ide

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.lang.management.ManagementFactory

object LockFileManager {

    private val logger = Logger.getInstance(LockFileManager::class.java)

    private fun lockDir(): File {
        val base = System.getenv("KIMCHI_CONFIG_DIR")
            ?: "${System.getProperty("user.home")}/.config/kimchi"
        return File(base, "ide").also { it.mkdirs() }
    }

    fun write(project: Project, port: Int, authToken: String) {
        val pid = try { ManagementFactory.getRuntimeMXBean().name.split("@")[0].toLong() } catch (_: Exception) { 0L }
        val ideName = try {
            val appInfo = Class.forName("com.intellij.openapi.application.ApplicationInfo")
            val instance = appInfo.getMethod("getInstance").invoke(null)
            appInfo.getMethod("getVersionName").invoke(instance) as? String ?: "IntelliJ IDEA"
        } catch (_: Exception) { "IntelliJ IDEA" }
        val ideVersion = try {
            val appInfo = Class.forName("com.intellij.openapi.application.ApplicationInfo")
            val instance = appInfo.getMethod("getInstance").invoke(null)
            appInfo.getMethod("getFullVersion").invoke(instance) as? String ?: "2024.1"
        } catch (_: Exception) { "2024.1" }

        val workspaceFolder = project.basePath ?: return

        val json = Json { prettyPrint = false }
        val lockContent = buildJsonObject {
            put("port", JsonPrimitive(port))
            put("authToken", JsonPrimitive(authToken))
            put("ideName", JsonPrimitive(ideName))
            put("ideVersion", JsonPrimitive(ideVersion))
            put("transport", JsonPrimitive("ws"))
            put("workspaceFolders", buildJsonArray { add(JsonPrimitive(workspaceFolder)) })
            put("pid", JsonPrimitive(pid))
        }
        val lockFile = File(lockDir(), "$port.lock")
        try {
            lockFile.writeText(json.encodeToString(JsonObject.serializer(), lockContent))
            logger.info("Wrote IDE lockfile: ${lockFile.absolutePath}")
        } catch (e: Exception) {
            logger.error("Failed to write IDE lockfile", e)
        }
    }

    fun delete(project: Project) {
        val dir = lockDir()
        dir.listFiles { f -> f.extension == "lock" }?.forEach { file ->
            try {
                val content = file.readText()
                if (content.contains("\"workspaceFolders\"") && content.contains(project.basePath ?: return@forEach)) {
                    file.delete()
                    logger.info("Deleted IDE lockfile: ${file.absolutePath}")
                }
            } catch (_: Exception) {}
        }
    }
}
