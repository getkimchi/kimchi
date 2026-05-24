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
import { TeleportableAgentSession } from "./proxy/teleportable-session.js"
import "../../login-command-patch.js"

export interface RunTeleportSessionOptions {
	extensionFactories: ExtensionFactory[]
	agentDir: string
	apiKey: string
	endpoint?: string
}

/**
 * Entry point for `kimchi --teleport`. Mirrors the local-mode interactive
 * bootstrap (and the structural pattern in `src/modes/teleport/run-remote.ts`)
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
	// Captured after `new InteractiveMode(...)` below. Used to drive pi-mono's
	// `resetExtensionUI()` + `renderCurrentSessionState()` after a wrapper
	// foreground swap, which `rebindCurrentSession()` alone does not do.
	// Without this pass the chat container, ext shortcut handler, and
	// extension overlays stay wired to the previous foreground and the editor
	// looks unresponsive (text accepted but no visible response).
	// biome-ignore lint/style/useConst: forward reference — captured by the teleportExtension closure below, then assigned after `new InteractiveMode(...)`.
	let interactiveModeRef: InteractiveMode | undefined

	const teleportExtension = makeTeleportExtension({
		getWrapper: () => wrapperRef,
		getServices: () => servicesRef,
		getTriggerRebind: () => triggerRebindRef,
		getTriggerFreshUI: () => {
			// `resetExtensionUI` and `renderCurrentSessionState` are not part
			// of pi-mono's public type surface — they're real methods on
			// `InteractiveMode` (access modifiers are TS-only and stripped at
			// build), so we reach them via cast. Optional-chaining keeps us
			// graceful if a future pi-mono renames either.
			const im = interactiveModeRef as unknown as
				| {
						resetExtensionUI?: () => void
						renderCurrentSessionState?: () => void
				  }
				| undefined
			if (!im) return undefined
			return () => {
				im.resetExtensionUI?.()
				im.renderCurrentSessionState?.()
			}
		},
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
	interactiveModeRef = interactiveMode
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
