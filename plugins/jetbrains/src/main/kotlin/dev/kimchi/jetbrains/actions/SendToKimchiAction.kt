package dev.kimchi.jetbrains.actions

import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import dev.kimchi.jetbrains.ide.KimchiWebSocketServer

class SendToKimchiAction : AnAction() {

    private val logger = Logger.getInstance(SendToKimchiAction::class.java)

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor != null &&
            e.getData(CommonDataKeys.PROJECT) != null &&
            editor.selectionModel.hasSelection()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val project = e.getData(CommonDataKeys.PROJECT) ?: return

        val selectionModel = editor.selectionModel
        if (!selectionModel.hasSelection()) return

        val doc: Document = editor.document
        val file = FileDocumentManager.getInstance().getFile(doc) ?: run {
            notify(project, "Cannot resolve file path for current document", NotificationType.WARNING)
            return
        }

        val server = KimchiWebSocketServer.getInstance(project)
        if (!server.hasConnectedClients()) {
            notify(project, "Kimchi is not connected — start kimchi in the terminal first", NotificationType.WARNING)
            return
        }

        // Auto-save so the CLI reads the current content from disk
        ApplicationManager.getApplication().runWriteAction {
            FileDocumentManager.getInstance().saveDocument(doc)
        }

        val filePath = file.path
        val startOffset = selectionModel.selectionStart
        val endOffset = selectionModel.selectionEnd
        val lineStart = doc.getLineNumber(startOffset) + 1
        val lineEnd = doc.getLineNumber(endOffset) + 1

        server.sendAtMentioned(filePath, lineStart, lineEnd)

        val ref = "@${file.name}:$lineStart-$lineEnd"
        notify(project, "$ref added — type your prompt in the Kimchi terminal", NotificationType.INFORMATION)
        logger.info("Sent at_mentioned: $filePath:$lineStart-$lineEnd")
    }

    private fun notify(project: com.intellij.openapi.project.Project, message: String, type: NotificationType) {
        Notifications.Bus.notify(
            Notification("Kimchi", "Kimchi", message, type),
            project
        )
    }
}
