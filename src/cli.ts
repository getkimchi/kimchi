// CLI logic — imported dynamically by entry.ts after PI_PACKAGE_DIR is set.
// All static imports here (extensions, pi-mono) are safe because the env is already configured.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { dispatchSubcommand } from "./commands/dispatch.js"
import {
	DEFAULT_SKILL_PATHS,
	loadConfig,
	readTelemetryConfig,
	writeApiKey,
	writeMigrationState,
	writeSkillPaths,
} from "./config.js"
import { isBunBinary } from "./env.js"
import bashCollapseExtension from "./extensions/bash-collapse.js"
import behavioursExtension from "./extensions/behaviours/index.js"
import clipboardImageExtension from "./extensions/clipboard-image.js"
import contextCompactorExtension from "./extensions/context-compactor.js"
import kimchiMinimalTintsExtension from "./extensions/kimchi-minimal-tints.js"
import loginExtension from "./extensions/login/index.js"
import loopGuardExtension from "./extensions/loop-guard.js"
import lspExtension from "./extensions/lsp.js"
import mcpAdapterExtension from "./extensions/mcp-adapter/index.js"
import promptEnrichmentExtension from "./extensions/orchestration/prompt-enrichment.js"
import permissionsExtension from "./extensions/permissions/index.js"
import { reserveShiftTabForPermissions } from "./extensions/permissions/keybindings.js"
import promptSummaryExtension from "./extensions/prompt-summary.js"
import shutdownMarkerExtension from "./extensions/shutdown-marker.js"
import startupUpdateExtension from "./extensions/startup-update.js"
// import statsExtension from "./extensions/stats/index.js"
import subagentExtension from "./extensions/subagent.js"
import tagsExtension from "./extensions/tags.js"
import telemetryExtension from "./extensions/telemetry.js"
import terminalColorsExtension from "./extensions/terminal-colors.js"
import toolRendererExtension from "./extensions/tool-renderer.js"
import uiExtension from "./extensions/ui.js"
import webFetchExtension from "./extensions/web-fetch/index.js"
import webSearchExtension from "./extensions/web-search/index.js"
import { updateModelsConfig } from "./models.js"
import { runSetupWizard } from "./setup-wizard.js"
import { setAvailableModels } from "./startup-context.js"
import { probeTerminalBackground } from "./terminal-bg-probe.js"
import { getVersion } from "./utils.js"

const telemetryConfig = readTelemetryConfig()

let sessionId: string | undefined
let sessionFile: string | undefined
let sessionStarted = false
// ACP mode runs JSON-RPC over stdio; the "To resume:" print (even remapped to
// stderr via console.log = console.error inside runAcpMode) is noise in IDE
// logs and not actionable — the IDE owns session continuation. Decide once,
// at module load, before anything else runs.
const acpMode = isAcpMode(process.argv.slice(2))
const helpOrVersion = isHelpOrVersionArgs(process.argv.slice(2))

process.on("exit", (code) => {
	// Only print the resume hint after a real harness session ran. Subcommands
	// (kimchi setup, kimchi version, …) and --help/--version short-circuit
	// before any session starts, so sessionId stays undefined and we keep
	// quiet. The non-resume case (sessionId still undefined after main exits)
	// is preserved by checking whether session capture had a chance to run —
	// done by the harness path setting sessionStarted = true below.
	if (code === 0 && !acpMode && sessionStarted) {
		// Only print a session-specific hint if the session file was actually
		// flushed to disk. Empty sessions (immediate exit) never get persisted,
		// so `--session <id>` would fail to resolve. Fall back to --continue,
		// which finds the most recent persisted session for this cwd.
		const persisted = sessionId && sessionFile && existsSync(sessionFile)
		const resumeCmd = persisted ? `kimchi --session ${sessionId}` : "kimchi --continue"
		console.log(`\nTo resume: ${resumeCmd}`)
	}
})

function sessionIdCaptureExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		try {
			sessionId = ctx.sessionManager.getSessionId()
			sessionFile = ctx.sessionManager.getSessionFile()
		} catch {
			// ignore — exit handler falls back to --continue
		}
	})
}

// Intentionally minimal pre-dispatch sniff: we need to know whether to enter
// ACP stdio mode BEFORE pi-mono's main() takes over (which would otherwise
// print a banner, wire up the TUI, and corrupt the JSON-RPC stream). The
// canonical --mode parser lives in pi-mono; this only looks for the one value
// that forces a different entrypoint. Don't extend this sniff for new flags —
// thread them through pi-mono's parser instead.
function isHelpOrVersionArgs(args: string[]): boolean {
	return args.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v")
}

function isAcpMode(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--mode" && args[i + 1] === "acp") return true
		if (a === "--mode=acp") return true
	}
	return false
}

try {
	// Top-level kimchi subcommands (setup, claude, opencode, …) and the
	// top-level --help take ownership before any harness setup runs.
	// `--version` falls through to pi-coding-agent's main below so it prints
	// the version using piConfig.name = "kimchi".
	const dispatch = await dispatchSubcommand(process.argv.slice(2))
	if (dispatch.kind === "handled") {
		process.exit(dispatch.exitCode)
	}

	if (helpOrVersion) {
		const { main } = await import("@mariozechner/pi-coding-agent")
		await main(process.argv.slice(2), { extensionFactories: [] })
	} else {
		// We're entering the harness/ACP path. Subcommands and --help/--version
		// short-circuit above without ever reaching here, which is why the exit
		// hook keys off this flag instead of just running unconditionally on a
		// 0-status exit.
		sessionStarted = true
		let config = loadConfig()

		const envKey = process.env.KIMCHI_API_KEY || undefined
		// biome-ignore lint/performance/noDelete: process.env coerces assignments to strings, so `= undefined` would set it to the literal "undefined"
		delete process.env.KIMCHI_API_KEY
		if (envKey && !config.apiKey) {
			writeApiKey(envKey)
			config = loadConfig()
		}

		const apiKey = config.apiKey

		const needsSkillsSetup = config.skillPaths === undefined
		const needsMigrationCheck = config.migrationState === undefined
		let skillPaths = config.skillPaths ?? []

		if (needsSkillsSetup || needsMigrationCheck) {
			if (!process.stdin.isTTY) {
				if (needsSkillsSetup) {
					skillPaths = DEFAULT_SKILL_PATHS
					writeSkillPaths(skillPaths)
				}
				writeMigrationState("done")
			} else {
				const result = await runSetupWizard({ needsSkillsSetup, needsMigrationCheck })
				if (needsSkillsSetup) {
					skillPaths = result.skillPaths
					writeSkillPaths(skillPaths)
				}
				if (result.migrationState !== undefined) {
					writeMigrationState(result.migrationState)
				}
			}
		}

		// Ensure models.json exists with Cast AI provider configuration
		const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
		if (!agentDir) {
			throw new Error("KIMCHI_CODING_AGENT_DIR is not set; cli.ts must be entered via entry.ts")
		}
		const modelsJsonPath = resolve(agentDir, "models.json")
		const { models } = await updateModelsConfig(modelsJsonPath, apiKey)

		// Must run before main() so the keybindings file is loaded with the
		// override in place.
		reserveShiftTabForPermissions(agentDir)

		// Share the discovered model metadata with extensions before main() runs.
		// prompt-enrichment reads this to build ModelRegistry with live model IDs.
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
		// Source edits propagate so packaged upgrades pick up new defaults. Users
		// wanting custom colors should clone+rename (e.g. `my-kimchi.json`), which
		// this loop won't touch. The kimchi-minimal source keeps all six bg tokens
		// as `""` placeholders; the kimchi-minimal-tints extension fills them in
		// per-process at session_start from the OSC 11 probe.
		const themesDir = resolve(agentDir, "themes")
		const bundledThemes = ["kimchi.json", "kimchi-minimal.json", "kimchi-light.json", "dark.json", "light.json"]
		const bundledThemesSrcDir = isBunBinary
			? resolve(process.env.PI_PACKAGE_DIR ?? "", "theme")
			: resolve(dirname(fileURLToPath(import.meta.url)), "../themes")
		mkdirSync(themesDir, { recursive: true })

		// Probe runs here (before pi-mono takes stdin) so the result is cached for
		// the kimchi-minimal-tints and terminal-colors extensions. Skip in ACP mode —
		// stdout is the JSON-RPC channel and OSC escapes would corrupt the IDE's
		// input stream.
		if (!acpMode) await probeTerminalBackground()

		// Compare contents and only write when they differ. Restarts in a second
		// terminal must be byte-identical no-ops because pi runs `fs.watch` on the
		// active theme file — any rewrite (even with the same bytes via copyFileSync)
		// fires a reload in every other running instance. The previous version of
		// this loop injected per-process bg tints into kimchi-minimal.json on every
		// startup; that race is what made terminals clobber each other's colors.
		// Tints now live in memory only, applied by the kimchi-minimal-tints
		// extension at session_start.
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

		const extensionFactories = [
			startupUpdateExtension,
			sessionIdCaptureExtension,
			shutdownMarkerExtension,
			// statsExtension,
			terminalColorsExtension,
			kimchiMinimalTintsExtension,
			bashCollapseExtension,
			loopGuardExtension,
			lspExtension,
			mcpAdapterExtension,
			promptEnrichmentExtension(skillPaths),
			permissionsExtension,
			behavioursExtension,
			promptSummaryExtension,
			contextCompactorExtension,
			clipboardImageExtension,
			uiExtension,
			subagentExtension,
			tagsExtension,
			telemetryExtension(telemetryConfig),
			toolRendererExtension,
			webFetchExtension,
			webSearchExtension,
			loginExtension,
		]

		const rawArgs = process.argv.slice(2)
		if (acpMode) {
			const { runAcpMode } = await import("./modes/acp/server.js")
			await runAcpMode({ extensionFactories, agentDir })
		} else {
			// Delegate to pi-mono's CLI main function, injecting the kimchi extension
			const { main } = await import("@mariozechner/pi-coding-agent")
			await main(rawArgs, { extensionFactories })
		}
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}
