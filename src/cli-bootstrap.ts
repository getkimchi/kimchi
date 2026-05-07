// Shared agent-directory setup extracted from cli.ts so that autonomous mode
// (auto.ts) can run the same harness preparation without entering the interactive
// cli.ts path (which triggers probeTerminalBackground, setup wizard, etc.).
//
// cli.ts calls this before building extension factories.
// auto.ts calls this before calling pi-coding-agent's main().
//
// Must NOT import cli.ts or auto.ts to avoid circular dependencies.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, writeApiKey } from "./config.js"
import { isBunBinary } from "./env.js"
import { updateModelsConfig } from "./models.js"
import { setAvailableModels } from "./startup-context.js"
import { getVersion } from "./utils.js"

export interface PrepareAgentEnvironmentResult {
	apiKey: string
}

/**
 * Sets up the agent directory for a kimchi run (interactive or autonomous).
 *
 * - Resolves the KIMCHI_API_KEY from env or config and persists it if needed.
 * - Fetches / refreshes models.json in agentDir.
 * - Shares discovered model metadata via setAvailableModels().
 * - Writes a default settings.json if one doesn't exist yet.
 * - Syncs bundled themes into agentDir/themes (byte-identical no-op if unchanged).
 * - Patches globalThis.fetch to include a kimchi User-Agent header.
 *
 * Does NOT run probeTerminalBackground, the setup wizard, or
 * reserveShiftTabForPermissions — those are interactive-only and remain in cli.ts.
 *
 * Throws if KIMCHI_CODING_AGENT_DIR is not set (must be entered via entry.ts).
 * In autonomous mode throws with a clear message if no API key is available.
 */
export async function prepareAgentEnvironment(opts?: {
	/** When true, throw instead of silently continuing when no API key is set. */
	requireApiKey?: boolean
}): Promise<PrepareAgentEnvironmentResult> {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) {
		throw new Error("KIMCHI_CODING_AGENT_DIR is not set; cli-bootstrap must be entered via entry.ts")
	}

	let config = loadConfig()
	const envKey = process.env.KIMCHI_API_KEY || undefined
	// biome-ignore lint/performance/noDelete: process.env coerces assignments to strings, so `= undefined` would set it to the literal "undefined"
	delete process.env.KIMCHI_API_KEY
	if (envKey && !config.apiKey) {
		writeApiKey(envKey)
		config = loadConfig()
	}

	const apiKey = config.apiKey

	if (opts?.requireApiKey && !apiKey && !envKey) {
		throw new Error("KIMCHI_API_KEY is not set and no API key is configured. Set KIMCHI_API_KEY to run autonomously.")
	}

	const resolvedApiKey = apiKey || envKey || ""

	// Ensure models.json exists with Cast AI provider configuration
	const modelsJsonPath = resolve(agentDir, "models.json")
	const { models } = await updateModelsConfig(modelsJsonPath, resolvedApiKey)

	// Share the discovered model metadata with extensions before main() runs.
	setAvailableModels(models)

	// Write default settings on first run only — respect user's choices afterward
	const settingsPath = resolve(agentDir, "settings.json")
	try {
		readFileSync(settingsPath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			writeFileSync(settingsPath, `${JSON.stringify({ quietStartup: true, theme: "kimchi-minimal" }, null, 2)}\n`)
		} else {
			console.error(`Warning: could not read ${settingsPath}: ${(err as Error).message}`)
		}
	}

	// Bundled themes are write-through cache — owned by the package, not the user.
	const themesDir = resolve(agentDir, "themes")
	const bundledThemes = ["kimchi.json", "kimchi-minimal.json", "kimchi-light.json", "dark.json", "light.json"]
	const bundledThemesSrcDir = isBunBinary
		? resolve(process.env.PI_PACKAGE_DIR ?? "", "theme")
		: resolve(dirname(fileURLToPath(import.meta.url)), "../themes")
	mkdirSync(themesDir, { recursive: true })

	for (const file of bundledThemes) {
		const src = resolve(bundledThemesSrcDir, file)
		const dest = resolve(themesDir, file)
		let srcContent: string
		try {
			srcContent = readFileSync(src, "utf-8")
		} catch {
			console.warn(`Warning: bundled theme ${file} not found at ${src}, skipping`)
			continue
		}
		let destContent: string | undefined
		try {
			destContent = readFileSync(dest, "utf-8")
		} catch {
			// dest missing — fall through and write
		}
		if (destContent !== srcContent) writeFileSync(dest, srcContent)
	}

	// Suppress Node.js warnings (same as pi-mono's own cli.js)
	process.emitWarning = () => {}

	// Patch globalThis.fetch to include a kimchi User-Agent header
	const fetchPatchedSymbol = Symbol.for("kimchi.fetchPatched")
	if (!(globalThis.fetch as typeof globalThis.fetch & { [key: symbol]: boolean })[fetchPatchedSymbol]) {
		const userAgent = `kimchi/${getVersion()}`
		const originalFetch = globalThis.fetch.bind(globalThis)
		const patchedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers)
			if (!headers.has("user-agent")) {
				headers.set("user-agent", userAgent)
			}
			return originalFetch(input, { ...init, headers })
		}
		;(patchedFetch as typeof patchedFetch & { [key: symbol]: boolean })[fetchPatchedSymbol] = true
		globalThis.fetch = patchedFetch
	}

	return { apiKey: resolvedApiKey }
}
