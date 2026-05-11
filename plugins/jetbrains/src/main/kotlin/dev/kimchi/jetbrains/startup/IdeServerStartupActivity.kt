package dev.kimchi.jetbrains.startup

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import dev.kimchi.jetbrains.ide.KimchiWebSocketServer

class IdeServerStartupActivity : ProjectActivity {

    private val logger = Logger.getInstance(IdeServerStartupActivity::class.java)

    override suspend fun execute(project: Project) {
        val server = project.getService(KimchiWebSocketServer::class.java)
        if (server == null) {
            logger.error("KimchiWebSocketServer service not found — check plugin.xml registration and @Service annotation")
            return
        }
        server.start()
    }
}
