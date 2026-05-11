package dev.kimchi.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

@Service
@State(
    name = "KimchiSettings",
    storages = [Storage("kimchi.xml")]
)
class KimchiSettings : PersistentStateComponent<KimchiSettings.State> {

    data class State(
        var kimchiPath: String? = null,
        var workingDirectory: String = System.getProperty("user.home"),
        var autoStart: Boolean = true,
        var showInlineDiffs: Boolean = true,
        var requireApproval: Boolean = true
    )

    private var state = State()

    var kimchiPath: String?
        get() = state.kimchiPath
        set(value) { state.kimchiPath = value }

    var workingDirectory: String
        get() = state.workingDirectory
        set(value) { state.workingDirectory = value }

    var autoStart: Boolean
        get() = state.autoStart
        set(value) { state.autoStart = value }

    var showInlineDiffs: Boolean
        get() = state.showInlineDiffs
        set(value) { state.showInlineDiffs = value }

    var requireApproval: Boolean
        get() = state.requireApproval
        set(value) { state.requireApproval = value }

    override fun getState(): State = state

    override fun loadState(state: State) {
        XmlSerializerUtil.copyBean(state, this.state)
    }

    companion object {
        fun getInstance(): KimchiSettings {
            return ApplicationManager.getApplication().getService(KimchiSettings::class.java)
        }
    }
}