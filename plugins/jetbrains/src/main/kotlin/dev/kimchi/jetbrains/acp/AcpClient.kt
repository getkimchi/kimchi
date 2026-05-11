package dev.kimchi.jetbrains.acp

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.serializer
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class AcpClient(
    private val process: Process
) {
    private val logger = Logger.getInstance(AcpClient::class.java)
    private val json = Json { ignoreUnknownKeys = true }
    private val requestId = AtomicLong(0)
    private val pendingRequests = ConcurrentHashMap<String, CompletableFuture<AcpResponse>>()

    private val reader = BufferedReader(InputStreamReader(process.inputStream))
    private val writer = BufferedWriter(OutputStreamWriter(process.outputStream))
    private var running = false
    private var readThread: Thread? = null

    var onNotification: ((AcpNotification) -> Unit)? = null
    var onDiffReceived: ((DiffNotification) -> Unit)? = null
    var onApprovalRequested: ((ApprovalRequest) -> Unit)? = null

    fun start() {
        if (running) return
        running = true

        readThread = Thread {
            try {
                while (running) {
                    val line = reader.readLine() ?: break
                    handleMessage(line)
                }
            } catch (e: Exception) {
                if (running) {
                    logger.error("Error reading from ACP process", e)
                }
            }
        }.apply { isDaemon = true; start() }

        logger.info("ACP client started")
    }

    fun stop() {
        running = false
        try {
            reader.close()
            writer.close()
        } catch (e: Exception) {
            logger.warn("Error closing streams", e)
        }
        pendingRequests.values.forEach { it.completeExceptionally(Exception("Connection closed")) }
        pendingRequests.clear()
        logger.info("ACP client stopped")
    }

    private fun handleMessage(line: String) {
        try {
            val jsonElement = json.parseToJsonElement(line)
            val jsonObject = jsonElement as? JsonObject ?: return

            when {
                jsonObject.containsKey("method") && !jsonObject.containsKey("id") -> {
                    val notification: AcpNotification = json.decodeFromJsonElement(jsonElement)
                    handleNotification(notification)
                }
                jsonObject.containsKey("id") -> {
                    val response: AcpResponse = json.decodeFromJsonElement(jsonElement)
                    pendingRequests[response.id]?.complete(response)
                    pendingRequests.remove(response.id)
                }
            }
        } catch (e: Exception) {
            logger.error("Failed to parse ACP message: $line", e)
        }
    }

    private fun handleNotification(notification: AcpNotification) {
        when (notification.method) {
            "diff/created" -> {
                notification.params?.let { params ->
                    val diff: DiffNotification = json.decodeFromJsonElement(params)
                    onDiffReceived?.invoke(diff)
                }
            }
            "approval/requested" -> {
                notification.params?.let { params ->
                    val request: ApprovalRequest = json.decodeFromJsonElement(params)
                    onApprovalRequested?.invoke(request)
                }
            }
            else -> onNotification?.invoke(notification)
        }
    }

    fun sendRequest(method: String, params: JsonElement? = null): CompletableFuture<AcpResponse> {
        val id = requestId.incrementAndGet().toString()
        val request = AcpRequest(id = id, method = method, params = params)

        val future = CompletableFuture<AcpResponse>()
        pendingRequests[id] = future

        val jsonStr = json.encodeToString(request)
        synchronized(writer) {
            writer.write(jsonStr)
            writer.newLine()
            writer.flush()
        }

        return future
    }

    fun sendNotification(method: String, params: JsonElement? = null) {
        val notification = AcpNotification(method = method, params = params)
        val jsonStr = json.encodeToString(notification)
        synchronized(writer) {
            writer.write(jsonStr)
            writer.newLine()
            writer.flush()
        }
    }

    fun approveChange(changeId: String) {
        val params = JsonObject(mapOf("changeId" to json.encodeToJsonElement(changeId)))
        sendNotification("approval/approve", params)
    }

    fun rejectChange(changeId: String) {
        val params = JsonObject(mapOf("changeId" to json.encodeToJsonElement(changeId)))
        sendNotification("approval/reject", params)
    }
}