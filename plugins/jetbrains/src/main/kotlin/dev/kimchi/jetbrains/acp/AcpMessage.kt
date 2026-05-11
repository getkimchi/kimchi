package dev.kimchi.jetbrains.acp

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
sealed class AcpMessage {
    abstract val jsonrpc: String
    abstract val id: String?
}

@Serializable
data class AcpRequest(
    override val jsonrpc: String = "2.0",
    override val id: String,
    val method: String,
    val params: JsonElement? = null
) : AcpMessage()

@Serializable
data class AcpResponse(
    override val jsonrpc: String = "2.0",
    override val id: String?,
    val result: JsonElement? = null,
    val error: AcpError? = null
) : AcpMessage()

@Serializable
data class AcpNotification(
    override val jsonrpc: String = "2.0",
    override val id: String? = null,
    val method: String,
    val params: JsonElement? = null
) : AcpMessage()

@Serializable
data class AcpError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null
)

@Serializable
data class DiffNotification(
    val filePath: String,
    val originalContent: String,
    val newContent: String,
    val changeId: String
)

@Serializable
data class ApprovalRequest(
    val changeId: String,
    val filePath: String,
    val description: String,
    val lineStart: Int,
    val lineEnd: Int
)