import {
	InteractiveMode,
	SessionManager,
	SettingsManager,
	createAgentSessionRuntime,
	initTheme,
} from "@earendil-works/pi-coding-agent"
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import type { KimchiConfig } from "../../config.js"
import "../../login-command-patch.js"
import { createRemoteRuntimeFactory } from "./proxy/runtime-factory.js"

export interface RunRemoteSessionOptions {
	kimchiConfig: KimchiConfig
	extensionFactories: ExtensionFactory[]
	agentDir: string
	apiKey: string
	endpoint?: string
}

/**
 * Entry point for standalone remote sessions. Mirrors the interactive branch
 * of pi-mono's main() but composes a RemoteAgentSession via the teleport
 * proxy layer instead of a local agent.
 */
export async function runRemoteSession(options: RunRemoteSessionOptions): Promise<void> {
	const argv = process.argv.slice(2)
	if (argv.includes("--no-session")) {
		console.error("Error: remote sessions cannot be combined with --no-session")
		process.exit(1)
	}
	if (argv.includes("--list-models")) {
		console.error("Error: --list-models is not supported for remote sessions")
		process.exit(1)
	}
	if (argv.includes("--export")) {
		console.error("Error: --export is not supported for remote sessions")
		process.exit(1)
	}

	const cwd = process.cwd()
	const settingsManager = SettingsManager.create(cwd, options.agentDir)
	const sessionDir = process.env.KIMCHI_SESSION_DIR ?? settingsManager.getSessionDir()
	const sessionManager = SessionManager.create(cwd, sessionDir)

	const factory = createRemoteRuntimeFactory({
		apiKey: options.apiKey,
		endpoint: options.endpoint,
		extensionFactories: options.extensionFactories,
		agentDir: options.agentDir,
	})

	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: options.agentDir,
		sessionManager,
	})

	initTheme(runtime.services.settingsManager.getTheme(), true)

	const interactiveMode = new InteractiveMode(runtime, {
		modelFallbackMessage: runtime.modelFallbackMessage,
	})
	try {
		await interactiveMode.run()
	} finally {
		await runtime.dispose()
	}
}
