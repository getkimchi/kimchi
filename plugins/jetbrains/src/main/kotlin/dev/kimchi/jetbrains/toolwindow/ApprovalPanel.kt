package dev.kimchi.jetbrains.toolwindow

import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.*

class ApprovalPanel(private val project: Project) : JPanel(BorderLayout()) {

    private val changesModel = DefaultListModel<ChangeItemData>()
    private val changesList = JBList(changesModel)
    private val previewPanel = JPanel(BorderLayout())
    private val emptyLabel = JLabel("No pending changes", SwingConstants.CENTER)

    data class ChangeItemData(
        val filePath: String,
        val lineStart: Int,
        val lineEnd: Int
    )

    init {
        setupUI()
    }

    private fun setupUI() {
        changesList.cellRenderer = ChangeItemRenderer()
        changesList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        changesList.addListSelectionListener {
            changesList.selectedValue?.let { showPreview(it) }
        }

        val leftPanel = JPanel(BorderLayout())
        leftPanel.border = JBUI.Borders.empty(8)
        leftPanel.add(JBScrollPane(changesList), BorderLayout.CENTER)

        previewPanel.border = JBUI.Borders.empty(8)
        previewPanel.background = JBColor.PanelBackground
        emptyLabel.foreground = JBColor.GRAY
        previewPanel.add(emptyLabel, BorderLayout.CENTER)

        val splitPane = JSplitPane(JSplitPane.HORIZONTAL_SPLIT, leftPanel, previewPanel)
        splitPane.dividerLocation = 300
        splitPane.resizeWeight = 0.3

        add(splitPane, BorderLayout.CENTER)
    }

    fun addMention(filePath: String, lineStart: Int, lineEnd: Int) {
        changesModel.addElement(ChangeItemData(filePath, lineStart, lineEnd))
        updateEmptyState()
    }

    private fun showPreview(data: ChangeItemData) {
        previewPanel.removeAll()

        val infoPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8)
            add(JLabel("File: ${data.filePath}").apply { font = font.deriveFont(Font.BOLD) })
            add(Box.createVerticalStrut(4))
            add(JLabel("Lines: ${data.lineStart}-${data.lineEnd}").apply { foreground = JBColor.GRAY })
            add(Box.createVerticalStrut(16))
            val actionPanel = JPanel(FlowLayout(FlowLayout.LEFT))
            actionPanel.add(JButton("View in Editor").apply {
                addActionListener { openFileInEditor(data.filePath, data.lineStart) }
            })
            add(actionPanel)
        }

        previewPanel.add(infoPanel, BorderLayout.NORTH)
        previewPanel.revalidate()
        previewPanel.repaint()
    }

    private fun openFileInEditor(filePath: String, @Suppress("UNUSED_PARAMETER") line: Int) {
        val virtualFile = LocalFileSystem.getInstance().findFileByPath(filePath) ?: return
        FileEditorManager.getInstance(project).openFile(virtualFile, true)
    }

    private fun updateEmptyState() {
        if (changesModel.isEmpty) {
            previewPanel.removeAll()
            previewPanel.add(emptyLabel, BorderLayout.CENTER)
            previewPanel.revalidate()
            previewPanel.repaint()
        }
    }

    private inner class ChangeItemRenderer : DefaultListCellRenderer() {
        override fun getListCellRendererComponent(
            list: JList<*>?, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean
        ): Component {
            super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
            val data = value as? ChangeItemData ?: return this
            text = "${data.filePath}:${data.lineStart}-${data.lineEnd}"
            return this
        }
    }
}
