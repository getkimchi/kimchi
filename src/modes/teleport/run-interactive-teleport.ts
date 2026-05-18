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
import { TeleportableAgentSession } from "./teleportable-agent-session.js"

export interface RunTeleportSessionOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	apiKey: string
	endpoint?: string
}

/**
 * Entry point for `kimchi --teleport`. Mirrors the local-mode interactive
 * bootstrap (and the structural pattern in `src/modes/remote/run-interactive.ts`)
 * but wraps the freshly-built local AgentSession in a
 * `TeleportableAgentSession` so the TUI holds a swappable foreground from the
 * very first frame.
 *
 * No network is opened here — the wrapper starts with foreground === home base
 * (local). Remote workers are spawned later via the `/teleport` slash command
 * (tasks 08+).
 */
export async function runTeleportSession(options: RunTeleportSessionOptions): Promise<void> {
	const cwd = process.cwd()
	const settingsManager = SettingsManager.create(cwd, options.agentDir)
	const sessionDir = process.env.KIMCHI_SESSION_DIR ?? settingsManager.getSessionDir()
	const sessionManager = SessionManager.create(cwd, sessionDir)

	let wrapperRef: TeleportableAgentSession | undefined
	let servicesRef: AgentSessionServices | undefined
	// Captured below from runtime.setRebindSession once InteractiveMode
	// registers its rebind. Calling it asks InteractiveMode to re-bind to
	// the wrapper's current foreground — required after /teleport, /attach,
	// or /detach because we mutate the wrapper's inner session in place and
	// the runtime's `apply()` path (which normally triggers the rebind) is
	// not involved.
	let triggerRebindRef: (() => Promise<void>) | undefined

	const teleportExtension = makeTeleportExtension({
		getWrapper: () => wrapperRef,
		getServices: () => servicesRef,
		getTriggerRebind: () => triggerRebindRef,
		apiKey: options.apiKey,
		endpoint: options.endpoint,
	})

	const allExtensionFactories: ExtensionFactory[] = [...options.extensionFactories, teleportExtension]

	const factory = createTeleportRuntimeFactory({
		extensionFactories: allExtensionFactories,
		agentDir: options.agentDir,
		onWrapperReady: (wrapper, services) => {
			wrapperRef = wrapper
			servicesRef = services
		},
	})

	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: options.agentDir,
		sessionManager,
	})

	initTheme(runtime.services.settingsManager.getTheme(), true)

	// Intercept setRebindSession so we can drive InteractiveMode's
	// rebindCurrentSession ourselves after the wrapper swaps its inner
	// foreground (which the runtime's session replacement path doesn't
	// know about). Must run before `new InteractiveMode(...)` because
	// InteractiveMode's constructor synchronously calls setRebindSession.
	type RebindCb = (session: AgentSession) => Promise<void>
	const originalSetRebindSession = runtime.setRebindSession.bind(runtime)
	runtime.setRebindSession = (cb?: RebindCb) => {
		triggerRebindRef = cb ? async () => cb(runtime.session) : undefined
		originalSetRebindSession(cb)
	}

	const interactiveMode = new InteractiveMode(runtime, {
		modelFallbackMessage: runtime.modelFallbackMessage,
	})
	try {
		await interactiveMode.run()
	} finally {
		await runtime.dispose()
	}
}

interface CreateTeleportRuntimeFactoryOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	onWrapperReady?: (wrapper: TeleportableAgentSession, services: AgentSessionServices) => void
}

function createTeleportRuntimeFactory(options: CreateTeleportRuntimeFactoryOptions): CreateAgentSessionRuntimeFactory {
	return async (opts) => {
		const { cwd, agentDir, sessionManager, sessionStartEvent } = opts

		const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"))
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: new Map(),
			resourceLoaderOptions: {
				extensionFactories: options.extensionFactories,
			},
		})

		const sessionResult = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})

		const wrapper = TeleportableAgentSession.create(sessionResult.session)
		options.onWrapperReady?.(wrapper, services)

		return {
			session: wrapper as unknown as AgentSession,
			extensionsResult: sessionResult.extensionsResult,
			services,
			diagnostics: services.diagnostics,
			modelFallbackMessage: sessionResult.modelFallbackMessage,
		}
	}
}
