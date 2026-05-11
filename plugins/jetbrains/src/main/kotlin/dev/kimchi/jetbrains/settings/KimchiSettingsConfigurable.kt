package dev.kimchi.jetbrains.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBCheckBox
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class KimchiSettingsConfigurable : Configurable {

    private lateinit var mainPanel: JPanel
    private lateinit var kimchiPathField: TextFieldWithBrowseButton
    private lateinit var workingDirField: TextFieldWithBrowseButton
    private lateinit var autoStartCheckBox: JBCheckBox
    private lateinit var showInlineDiffsCheckBox: JBCheckBox
    private lateinit var requireApprovalCheckBox: JBCheckBox

    override fun getDisplayName(): String = "Kimchi"

    override fun createComponent(): JComponent {
        kimchiPathField = TextFieldWithBrowseButton().apply {
            addBrowseFolderListener(
                "Select Kimchi Executable",
                null,
                null,
                FileChooserDescriptor(true, false, false, false, false, false)
            )
        }

        workingDirField = TextFieldWithBrowseButton().apply {
            addBrowseFolderListener(
                "Select Working Directory",
                null,
                null,
                FileChooserDescriptor(false, true, false, false, false, false)
            )
        }

        autoStartCheckBox = JBCheckBox("Auto-start Kimchi on IDE startup")
        showInlineDiffsCheckBox = JBCheckBox("Show inline diff highlighting")
        requireApprovalCheckBox = JBCheckBox("Require approval for changes")

        mainPanel = FormBuilder.createFormBuilder()
            .addLabeledComponent("Kimchi executable:", kimchiPathField)
            .addLabeledComponent("Working directory:", workingDirField)
            .addComponent(autoStartCheckBox)
            .addComponent(showInlineDiffsCheckBox)
            .addComponent(requireApprovalCheckBox)
            .addComponentFillVertically(JPanel(), 0)
            .panel

        return mainPanel
    }

    override fun isModified(): Boolean {
        val settings = KimchiSettings.getInstance()
        return kimchiPathField.text != settings.kimchiPath ||
            workingDirField.text != settings.workingDirectory ||
            autoStartCheckBox.isSelected != settings.autoStart ||
            showInlineDiffsCheckBox.isSelected != settings.showInlineDiffs ||
            requireApprovalCheckBox.isSelected != settings.requireApproval
    }

    override fun apply() {
        val settings = KimchiSettings.getInstance()
        settings.kimchiPath = kimchiPathField.text.takeIf { it.isNotBlank() }
        settings.workingDirectory = workingDirField.text
        settings.autoStart = autoStartCheckBox.isSelected
        settings.showInlineDiffs = showInlineDiffsCheckBox.isSelected
        settings.requireApproval = requireApprovalCheckBox.isSelected
    }

    override fun reset() {
        val settings = KimchiSettings.getInstance()
        kimchiPathField.text = settings.kimchiPath ?: ""
        workingDirField.text = settings.workingDirectory
        autoStartCheckBox.isSelected = settings.autoStart
        showInlineDiffsCheckBox.isSelected = settings.showInlineDiffs
        requireApprovalCheckBox.isSelected = settings.requireApproval
    }
}