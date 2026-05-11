import {
	InteractiveMode,
	SessionManager,
	SettingsManager,
	createAgentSessionRuntime,
	initTheme,
} from "@earendil-works/pi-coding-agent"
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import type { KimchiConfig } from "../../config.js"
import { createRemoteRuntimeFactory } from "./runtime-factory.js"

export interface RunRemoteSessionOptions {
	kimchiConfig: KimchiConfig
	extensionFactories: ExtensionFactory[]
	agentDir: string
	apiKey: string
	endpoint?: string
}

/**
 * Entry point for `kimchi --remote`.  Mirrors the interactive branch of
 * pi-mono's `main()` (`node_modules/.../dist/main.js:320-566`) but composes
 * the parts that are still relevant for remote and swaps the inner
 * `createRuntime` factory for one that builds a `RemoteAgentSession`.
 *
 * What we replicate (in order):
 *   1. cwd + agentDir + SettingsManager (main.js:375-378).
 *   2. SessionManager (main.js:388) — the locally-minted session id is what
 *      we pass to `:authenticate`; reconnect uses the same id.
 *   3. Theme init (main.js:506-507) — before InteractiveMode constructs.
 *   4. Runtime via `createAgentSessionRuntime(...)` (main.js:476-480).
 *   5. `new InteractiveMode(runtime).run()` (main.js:542-565).
 *
 * What we do NOT replicate (and where it goes):
 *   - `parseArgs`, `runMigrations`, `prepareInitialMessage`, `resolveCliPaths`
 *     are not in pi-mono's public API surface (`index.d.ts`).  v1 ignores
 *     them; advanced flag handling for `--remote` is parked behind the
 *     cross-slice TODO below.
 *   - RPC / print / export branches — `--remote` is interactive-only.
 *
 * TODO(remote-agents): cross-slice contract: extend pi-mono's public API to
 * re-export `parseArgs`, `runMigrations`, `prepareInitialMessage`, or expose
 * a "buildInteractiveBoot" helper so `--remote` honours flag semantics
 * identically to local mode.
 */
export async function runRemoteSession(options: RunRemoteSessionOptions): Promise<void> {
	const argv = process.argv.slice(2)
	if (argv.includes("--no-session")) {
		console.error("Error: --remote cannot be combined with --no-session")
		process.exit(1)
	}
	if (argv.includes("--list-models")) {
		console.error("Error: --list-models is not supported under --remote")
		process.exit(1)
	}
	if (argv.includes("--export")) {
		console.error("Error: --export is not supported under --remote")
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

	// initTheme must run before InteractiveMode reads themed components.
	// Read theme from the runtime's settings manager (the cwd-bound one) so a
	// resumed session inheriting a different cwd resolves the right theme.
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
