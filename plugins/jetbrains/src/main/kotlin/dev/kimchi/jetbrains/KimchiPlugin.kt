package dev.kimchi.jetbrains

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger

@Service
class KimchiPlugin : com.intellij.openapi.Disposable {

    private val logger = Logger.getInstance(KimchiPlugin::class.java)

    init {
        logger.info("Kimchi plugin initialized")
    }

    override fun dispose() {
        logger.info("Kimchi plugin disposed")
    }

    companion object {
        fun getInstance(): KimchiPlugin {
            return ApplicationManager.getApplication().getService(KimchiPlugin::class.java)
        }
    }
}
