import { resolve } from "node:path"
import {
	AuthStorage,
	InteractiveMode,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	initTheme,
} from "@earendil-works/pi-coding-agent"
import type {
	AgentSession,
	AgentSessionServices,
	CreateAgentSessionRuntimeFactory,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent"
import makeTeleportExtension from "../../extensions/teleport.js"

export interface RunTeleportSessionOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	apiKey: string
	endpoint?: string
}

/**
 * Entry point for `kimchi --teleport`. Mirrors the local-mode interactive
 * bootstrap but registers the teleport extension so `/teleport`, `/attach`,
 * `/connect`, `/sync`, and `/sessions` slash commands are available.
 *
 * The local session drives the TUI. Remote sandboxes are accessed via SSH
 * when the user invokes `/teleport` or `/attach`.
 */
export async function runTeleportSession(options: RunTeleportSessionOptions): Promise<void> {
	const cwd = process.cwd()
	const settingsManager = SettingsManager.create(cwd, options.agentDir)
	const sessionDir = process.env.KIMCHI_SESSION_DIR ?? settingsManager.getSessionDir()
	const sessionManager = SessionManager.create(cwd, sessionDir)

	let sessionRef: AgentSession | undefined
	let servicesRef: AgentSessionServices | undefined

	const teleportExtension = makeTeleportExtension({
		getSession: () => sessionRef,
		getServices: () => servicesRef,
		apiKey: options.apiKey,
		endpoint: options.endpoint,
	})

	const allExtensionFactories: ExtensionFactory[] = [...options.extensionFactories, teleportExtension]

	const factory: CreateAgentSessionRuntimeFactory = async (opts) => {
		const { cwd, agentDir, sessionManager, sessionStartEvent } = opts

		const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"))
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: new Map(),
			resourceLoaderOptions: {
				extensionFactories: allExtensionFactories,
			},
		})

		const sessionResult = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})

		sessionRef = sessionResult.session
		servicesRef = services

		return {
			session: sessionResult.session,
			extensionsResult: sessionResult.extensionsResult,
			services,
			diagnostics: services.diagnostics,
			modelFallbackMessage: sessionResult.modelFallbackMessage,
		}
	}

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
