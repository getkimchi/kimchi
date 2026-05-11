package dev.kimchi.jetbrains.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

@Service(Service.Level.PROJECT)
class KimchiWebSocketServer(private val project: Project) : Disposable {

    private val logger = Logger.getInstance(KimchiWebSocketServer::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    private var serverSocket: ServerSocket? = null
    private var running = false
    val authToken: String = UUID.randomUUID().toString()
    var port: Int = 0
        private set

    private val clients = CopyOnWriteArrayList<WebSocketClient>()

    // Latest selection tracked per-project
    private var latestSelectionFilePath: String? = null
    private var latestSelectionLineStart: Int = 0
    private var latestSelectionLineEnd: Int = 0

    companion object {
        fun getInstance(project: Project): KimchiWebSocketServer {
            return project.getService(KimchiWebSocketServer::class.java)
        }
    }

    fun start() {
        if (running) return

        try {
            serverSocket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
            port = serverSocket!!.localPort
            running = true

            LockFileManager.write(project, port, authToken)
            setupSelectionListener()

            Thread({ acceptLoop() }, "KimchiWebSocket-${project.name}").also { it.isDaemon = true }.start()
            logger.info("Kimchi WebSocket server started on port $port for project ${project.name}")
        } catch (e: Exception) {
            logger.error("Failed to start Kimchi WebSocket server", e)
        }
    }

    private fun acceptLoop() {
        while (running) {
            try {
                val socket = serverSocket?.accept() ?: break
                val client = WebSocketClient(socket, this)
                clients.add(client)
                Thread({ client.run() }, "KimchiWS-client").also { it.isDaemon = true }.start()
            } catch (e: Exception) {
                if (running) logger.error("Error accepting WebSocket connection", e)
            }
        }
    }

    private fun setupSelectionListener() {
        val multicaster = EditorFactory.getInstance().eventMulticaster
        multicaster.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                val editor = e.editor
                val doc = editor.document
                val file = FileDocumentManager.getInstance().getFile(doc) ?: return
                val filePath = file.path

                val startOffset = e.newRange.startOffset
                val endOffset = e.newRange.endOffset
                if (startOffset == endOffset) return

                val lineStart = doc.getLineNumber(startOffset) + 1
                val lineEnd = doc.getLineNumber(endOffset) + 1

                latestSelectionFilePath = filePath
                latestSelectionLineStart = lineStart
                latestSelectionLineEnd = lineEnd

                val params = buildJsonObject {
                    put("filePath", JsonPrimitive(filePath))
                    put("lineStart", JsonPrimitive(lineStart))
                    put("lineEnd", JsonPrimitive(lineEnd))
                }
                sendNotification("selection_changed", params)
            }
        }, this)
    }

    fun hasConnectedClients(): Boolean = clients.isNotEmpty()

    fun sendAtMentioned(filePath: String, lineStart: Int, lineEnd: Int): Boolean {
        val params = buildJsonObject {
            put("filePath", JsonPrimitive(filePath))
            put("lineStart", JsonPrimitive(lineStart))
            put("lineEnd", JsonPrimitive(lineEnd))
        }
        return sendNotification("at_mentioned", params)
    }

    fun sendNotification(method: String, params: JsonObject): Boolean {
        if (clients.isEmpty()) return false
        val notification = buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("method", JsonPrimitive(method))
            put("params", params)
        }
        val text = json.encodeToString(JsonObject.serializer(), notification)
        clients.forEach { it.send(text) }
        return true
    }

    fun handleToolCall(name: String, arguments: JsonObject?): Any {
        return when (name) {
            "getWorkspaceFolders" -> {
                val basePath = project.basePath ?: return emptyList<String>()
                listOf(basePath)
            }
            "getCurrentSelection", "getLatestSelection" -> {
                val fp = latestSelectionFilePath
                if (fp == null) {
                    mapOf("filePath" to null, "lineStart" to null, "lineEnd" to null)
                } else {
                    mapOf("filePath" to fp, "lineStart" to latestSelectionLineStart, "lineEnd" to latestSelectionLineEnd)
                }
            }
            "getOpenEditors" -> {
                val result = mutableListOf<Map<String, Any>>()
                ApplicationManager.getApplication().invokeAndWait {
                    FileEditorManager.getInstance(project).openFiles.forEach { vf ->
                        result.add(mapOf("filePath" to vf.path, "name" to vf.name))
                    }
                }
                result
            }
            "openFile" -> {
                val filePath = arguments?.get("filePath")?.jsonPrimitive?.content ?: return mapOf("error" to "missing filePath")
                ApplicationManager.getApplication().invokeLater {
                    val vf = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return@invokeLater
                    FileEditorManager.getInstance(project).openFile(vf, true)
                }
                mapOf("success" to true)
            }
            "saveDocument" -> {
                val filePath = arguments?.get("filePath")?.jsonPrimitive?.content ?: return mapOf("error" to "missing filePath")
                ApplicationManager.getApplication().invokeAndWait {
                    val vf = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return@invokeAndWait
                    val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@invokeAndWait
                    ApplicationManager.getApplication().runWriteAction {
                        FileDocumentManager.getInstance().saveDocument(doc)
                    }
                }
                mapOf("success" to true)
            }
            else -> mapOf("error" to "unknown tool: $name")
        }
    }

    fun removeClient(client: WebSocketClient) {
        clients.remove(client)
    }

    override fun dispose() {
        running = false
        clients.forEach { it.close() }
        clients.clear()
        serverSocket?.close()
        serverSocket = null
        LockFileManager.delete(project)
        logger.info("Kimchi WebSocket server stopped for project ${project.name}")
    }
}

class WebSocketClient(
    private val socket: Socket,
    private val server: KimchiWebSocketServer
) {
    private val logger = Logger.getInstance(WebSocketClient::class.java)
    private val json = Json { ignoreUnknownKeys = true }
    private val outputLock = Any()

    fun run() {
        try {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()

            if (!performHandshake(input, output)) {
                socket.close()
                return
            }

            logger.info("WebSocket client connected")
            receiveLoop(input, output)
        } catch (e: Exception) {
            if (!socket.isClosed) logger.error("WebSocket client error", e)
        } finally {
            close()
            server.removeClient(this)
            logger.info("WebSocket client disconnected")
        }
    }

    private fun performHandshake(input: InputStream, output: OutputStream): Boolean {
        val headers = readHttpHeaders(input)
        val wsKey = headers["sec-websocket-key"] ?: return false
        val authHeader = headers["x-claude-code-ide-authorization"]

        if (authHeader != server.authToken) {
            output.write("HTTP/1.1 400 Bad Request\r\n\r\n".toByteArray())
            output.flush()
            return false
        }

        val acceptKey = computeAcceptKey(wsKey)
        val response = buildString {
            append("HTTP/1.1 101 Switching Protocols\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Accept: $acceptKey\r\n")
            append("\r\n")
        }
        output.write(response.toByteArray())
        output.flush()
        return true
    }

    private fun readHttpHeaders(input: InputStream): Map<String, String> {
        val sb = StringBuilder()
        // Read until \r\n\r\n
        while (true) {
            val b = input.read()
            if (b == -1) break
            sb.append(b.toChar())
            if (sb.length >= 4 && sb[sb.length - 4] == '\r' && sb[sb.length - 3] == '\n' &&
                sb[sb.length - 2] == '\r' && sb[sb.length - 1] == '\n'
            ) break
        }
        val headers = mutableMapOf<String, String>()
        for (line in sb.toString().split("\r\n").drop(1)) {
            val colon = line.indexOf(':')
            if (colon > 0) {
                headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
        }
        return headers
    }

    private fun computeAcceptKey(clientKey: String): String {
        val magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        val combined = clientKey + magic
        val sha1 = MessageDigest.getInstance("SHA-1").digest(combined.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(sha1)
    }

    private fun receiveLoop(input: InputStream, output: OutputStream) {
        val outputStream = output
        while (!socket.isClosed) {
            val message = readFrame(input) ?: break
            handleMessage(message, outputStream)
        }
    }

    private fun readFrame(input: InputStream): String? {
        val byte1 = input.read()
        if (byte1 == -1) return null
        val opcode = byte1 and 0x0F
        if (opcode == 8) return null // close

        val byte2 = input.read()
        if (byte2 == -1) return null
        val masked = (byte2 and 0x80) != 0
        var payloadLen = (byte2 and 0x7F).toLong()

        payloadLen = when (payloadLen.toInt()) {
            126 -> ((input.read() shl 8) or input.read()).toLong()
            127 -> {
                var len = 0L
                repeat(8) { len = (len shl 8) or input.read().toLong() }
                len
            }
            else -> payloadLen
        }

        val maskKey = if (masked) ByteArray(4) { input.read().toByte() } else null

        val payload = ByteArray(payloadLen.toInt())
        var offset = 0
        while (offset < payload.size) {
            val n = input.read(payload, offset, payload.size - offset)
            if (n == -1) return null
            offset += n
        }

        if (masked && maskKey != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
        }

        return String(payload, Charsets.UTF_8)
    }

    private fun handleMessage(text: String, @Suppress("UNUSED_PARAMETER") output: OutputStream) {
        try {
            val msg = json.parseToJsonElement(text).jsonObject
            val id = msg["id"]
            val method = msg["method"]?.jsonPrimitive?.content
            val params = msg["params"]?.let { if (it is JsonObject) it else null }

            if (method == null) return

            val result: Any = when (method) {
                "initialize" -> buildJsonObject {
                    put("protocolVersion", JsonPrimitive("2024-11-05"))
                    put("capabilities", buildJsonObject {})
                    put("serverInfo", buildJsonObject {
                        put("name", JsonPrimitive("KimchiJetBrains"))
                        put("version", JsonPrimitive("1.0.0"))
                    })
                }
                "tools/list" -> buildJsonObject {
                    put("tools", buildJsonArray {
                        add(toolDef("getWorkspaceFolders", "Get project workspace folder paths"))
                        add(toolDef("getCurrentSelection", "Get the current editor selection with file path and line range"))
                        add(toolDef("getLatestSelection", "Get the most recent editor selection"))
                        add(toolDef("getOpenEditors", "List all open editor tabs"))
                        add(toolDef("openFile", "Open a file in the editor", mapOf("filePath" to "string")))
                        add(toolDef("saveDocument", "Save a file", mapOf("filePath" to "string")))
                    })
                }
                "tools/call" -> {
                    val toolName = params?.get("name")?.jsonPrimitive?.content ?: "unknown"
                    val arguments = params?.get("arguments")?.let { if (it is JsonObject) it else null }
                    val toolResult = server.handleToolCall(toolName, arguments)
                    buildJsonObject {
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", JsonPrimitive("text"))
                                put("text", JsonPrimitive(anyToJsonElement(toolResult).toString()))
                            })
                        })
                    }
                }
                "notifications/initialized" -> {
                    // No response needed for notifications
                    return
                }
                else -> buildJsonObject { put("error", JsonPrimitive("unknown method: $method")) }
            }

            if (id != null) {
                val response = buildJsonObject {
                    put("jsonrpc", JsonPrimitive("2.0"))
                    put("id", id)
                    put("result", anyToJsonElement(result))
                }
                send(json.encodeToString(JsonObject.serializer(), response))
            }
        } catch (e: Exception) {
            logger.error("Error handling WebSocket message: $text", e)
        }
    }

    private fun toolDef(name: String, description: String, requiredProps: Map<String, String> = emptyMap()): JsonObject {
        return buildJsonObject {
            put("name", JsonPrimitive(name))
            put("description", JsonPrimitive(description))
            put("inputSchema", buildJsonObject {
                put("type", JsonPrimitive("object"))
                if (requiredProps.isNotEmpty()) {
                    put("properties", buildJsonObject {
                        requiredProps.forEach { (k, type) ->
                            put(k, buildJsonObject { put("type", JsonPrimitive(type)) })
                        }
                    })
                    put("required", buildJsonArray { requiredProps.keys.forEach { add(JsonPrimitive(it)) } })
                }
            })
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun anyToJsonElement(value: Any): kotlinx.serialization.json.JsonElement {
        return when (value) {
            is kotlinx.serialization.json.JsonElement -> value
            is String -> JsonPrimitive(value)
            is Int -> JsonPrimitive(value)
            is Long -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is List<*> -> buildJsonArray {
                value.forEach { item ->
                    if (item != null) add(anyToJsonElement(item))
                }
            }
            is Map<*, *> -> buildJsonObject {
                (value as Map<String, Any?>).forEach { (k, v) ->
                    put(k, if (v != null) anyToJsonElement(v) else JsonNull)
                }
            }
            else -> JsonPrimitive(value.toString())
        }
    }

    fun send(text: String) {
        if (socket.isClosed) return
        try {
            val payload = text.toByteArray(Charsets.UTF_8)
            synchronized(outputLock) {
                val out = socket.getOutputStream()
                out.write(0x81) // FIN=1, text frame
                when {
                    payload.size < 126 -> out.write(payload.size)
                    payload.size < 65536 -> {
                        out.write(126)
                        out.write((payload.size shr 8) and 0xFF)
                        out.write(payload.size and 0xFF)
                    }
                    else -> {
                        out.write(127)
                        for (i in 7 downTo 0) out.write((payload.size ushr (i * 8)) and 0xFF)
                    }
                }
                out.write(payload)
                out.flush()
            }
        } catch (e: Exception) {
            logger.error("Failed to send WebSocket frame", e)
        }
    }

    fun close() {
        try { socket.close() } catch (_: Exception) {}
    }
}
