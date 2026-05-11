package dev.kimchi.jetbrains.diff

enum class ChangeType {
    ADDED,
    REMOVED,
    MODIFIED
}

data class DiffChange(
    val type: ChangeType,
    val startOffset: Int,
    val endOffset: Int,
    val originalText: String,
    val newText: String,
    val description: String
)