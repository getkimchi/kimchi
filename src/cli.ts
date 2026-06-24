// CLI logic — imported dynamically by entry.ts after PI_PACKAGE_DIR is set.
// All static imports here (extensions, pi-mono) are safe because the env is already configured.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import {
	getCliModeArg,
	isExperimentalFeaturesArg,
	isHelpOrVersionArgs,
	isTerminalUiMode,
	stripExperimentalFeaturesArg,
} from "./cli-args.js"
import { dispatchSubcommand } from "./commands/dispatch.js"
// IMPORTANT: must be first local import — patches InteractiveMode.prototype
// before any module can construct an InteractiveMode instance.
import "./login-command-patch.js"
import "./paste-to-editor-patch.js"
import {
	DEFAULT_SKILL_PATHS,
	getActiveVendorSkillPaths,
	loadConfig,
	readTelemetryConfig,
	writeApiKey,
	writeMigrationState,
	writeSkillPaths,
} from "./config.js"
import { isBunBinary } from "./env.js"
import activityExtension from "./extensions/activity.js"
import agentsExtension from "./extensions/agents/index.js"
import assistantPrefixExtension from "./extensions/assistant-prefix.js"
import bashDefaultTimeoutExtension from "./extensions/bash-default-timeout.js"
import bashToolGuardExtension from "./extensions/bash-tool-guard.js"
import behavioursExtension from "./extensions/behaviours/index.js"
import claudeCodeHooksAdapter from "./extensions/claude-code-hook-adapter/index.js"
import claudeCodeSkillsExtension from "./extensions/claude-code-skills/index.js"
import clipboardImageExtension from "./extensions/clipboard-image.js"
import customizeFooterExtension from "./extensions/customize-footer-command.js"
import explorationGuardExtension from "./extensions/exploration-guard.js"
import fermentExtension from "./extensions/ferment/index.js"
import firstTurnOrientationExtension from "./extensions/first-turn-orientation.js"
import helpExtension from "./extensions/help.js"
import hideThinkingExtension from "./extensions/hide-thinking.js"
import ideAdapterExtension from "./extensions/ide-adapter/index.js"
import inputHistoryExtension from "./extensions/input-history.js"
import kimchiMinimalTintsExtension from "./extensions/kimchi-minimal-tints.js"
import llmResponseLogExtension from "./extensions/llm-response-log.js"
import loginExtension from "./extensions/login/index.js"
import { createStartupAuthGate, createStartupAuthGateState } from "./extensions/login/startup-auth.js"
import loopGuardExtension from "./extensions/loop-guard.js"
import lspExtension from "./extensions/lsp.js"
import mcpAdapterExtension from "./extensions/mcp-adapter/index.js"
import modelGuardExtension from "./extensions/model-guard.js"
import modelSwitchExtension from "./extensions/model-switch.js"
import { createSessionModeOnboardingForStartup } from "./extensions/onboarding/session-mode-startup.js"
import { applyRoleAugmentation } from "./extensions/orchestration/model-roles.js"
import permissionsExtension from "./extensions/permissions/index.js"
import { writeKimchiKeybindingDefaults } from "./extensions/permissions/keybindings.js"
import { installPiNativeCompatibilityShim } from "./extensions/pi-package-lookup/native-compat.js"
import pluginPackageHooksAdapter from "./extensions/plugin-package-hook-adapter/index.js"
import promptEnrichmentExtension from "./extensions/prompt-construction/prompt-enrichment.js"
import promptSummaryExtension from "./extensions/prompt-summary.js"
import questionnaireExtension from "./extensions/questionnaire/index.js"
import reportBugExtension from "./extensions/report-bug.js"
import reviewWriteGuardExtension from "./extensions/review-write-guard.js"
import rtkRewriteExtension from "./extensions/rtk-rewrite.js"
import sessionNameExtension from "./extensions/session-name.js"
import shutdownMarkerExtension from "./extensions/shutdown-marker.js"
import startupUpdateExtension from "./extensions/startup-update.js"
import statsExtension from "./extensions/stats/index.js"
import stripImagesExtension from "./extensions/strip-images.js"
import superpowersExtension from "./extensions/superpowers.js"
import surveysExtension from "./extensions/surveys/index.js"
import tagsExtension from "./extensions/tags.js"
import telemetryExtension from "./extensions/telemetry/index.js"
import { drain as drainPreSessionTelemetry, sendPreSessionEvent } from "./extensions/telemetry/pre-session.js"
import teleportExtension from "./extensions/teleport/index.js"
import terminalColorsExtension from "./extensions/terminal-colors.js"
import { probeKittyKeyboardSupport } from "./extensions/terminal-compat/keyboard-capability.js"
import { emitTerminalCompatWarning } from "./extensions/terminal-compat/startup-warning.js"
import themeSelectorExtension from "./extensions/theme-selector.js"
import thinkingStepsExtension from "./extensions/thinking-steps/index.js"
import tipsExtension from "./extensions/tips/index.js"
import todosExtension from "./extensions/todos/index.js"
import toolGroupingExtension from "./extensions/tool-grouping.js"
import toolRenderingExtension from "./extensions/tool-rendering.js"
import traceIdExtension from "./extensions/trace-id.js"
import uiExtension from "./extensions/ui.js"
import webFetchExtension from "./extensions/web-fetch/index.js"
import webSearchExtension from "./extensions/web-search/index.js"
import {
	injectExperimentalProvider,
	isTransientModelsError,
	readExperimentalModels,
	updateModelsConfig,
} from "./models.js"
import {
	augmentModelRolesWithOllama,
	injectOllamaProvider,
	readOllamaModelMetadata,
	readOllamaModelsFromConfig,
	resolveOllamaHost,
} from "./ollama.js"
import resourcesExtension from "./resources/extension.js"
import { type ManagedExtensionFactory, enabledExtensionFactories } from "./resources/filter.js"
import resourceToolBlockerExtension from "./resources/tool-blocker.js"
import { runSetupWizard } from "./setup-wizard.js"
import { setAvailableModels } from "./startup-context.js"
import { probeTerminalBackground } from "./terminal-bg-probe.js"
import { installCloudflare524RetryPatch } from "./upstream-retry-patch.js"
import { getVersion } from "./utils.js"
import { postProcessHtmlExport, postProcessJsonlExport } from "./utils/export-post-process.js"

installCloudflare524RetryPatch()
installPiNativeCompatibilityShim()

function getSubcommand(args: string[]): string {
	if (args.includes("--version") || args.includes("-v")) return "version"
	if (args.includes("--help") || args.includes("-h")) return "help"
	const sub = args[0]
	if (!sub || sub.startsWith("-")) return "harness"
	if (["setup", "config", "login", "logout", "doctor", "skills", "telemetry"].includes(sub)) return sub
	return "harness"
}

// --- Telemetry ---
const telemetryConfig = readTelemetryConfig()

// Fire-and-forget app_started on every invocation (respects telemetry opt-out).
// The promise is tracked internally; drain before process.exit() to reduce
// the chance of truncated HTTP requests.
if (telemetryConfig.enabled) {
	sendPreSessionEvent(telemetryConfig, "app_started", {
		subcommand: getSubcommand(process.argv.slice(2)),
	})
}

// ACP mode runs JSON-RPC over stdio; interactive mode runs the standard TUI
// harness. Decide once at module load, before anything else runs.
const cliMode = getCliModeArg(process.argv.slice(2))
const acpMode = cliMode === "acp"

// Monkey-patch AgentSession.prototype.exportToJsonl so ALL JSONL exports
// (interactive, ACP, and teleport mode) get trace IDs injected inline.
// biome-ignore lint/suspicious/noExplicitAny: monkey-patching an abstract class prototype
const _origExportToJsonl = (AgentSession as any).prototype.exportToJsonl
// biome-ignore lint/suspicious/noExplicitAny: monkey-patching an abstract class prototype
;(AgentSession as any).prototype.exportToJsonl = function (outputPath?: string) {
	const filePath = _origExportToJsonl.call(this, outputPath)
	try {
		postProcessJsonlExport(filePath)
	} catch (err) {
		console.warn("[export-post-process] Failed to post-process JSONL export:", err)
	}
	return filePath
}

// Monkey-patch AgentSession.prototype.exportToHtml so HTML exports get
// trace IDs injected into assistant message entries the same way JSONL does.
// biome-ignore lint/suspicious/noExplicitAny: monkey-patching an abstract class prototype
const _origExportToHtml = (AgentSession as any).prototype.exportToHtml
// biome-ignore lint/suspicious/noExplicitAny: monkey-patching an abstract class prototype
;(AgentSession as any).prototype.exportToHtml = async function (outputPath?: string) {
	const filePath = await _origExportToHtml.call(this, outputPath)
	try {
		postProcessHtmlExport(filePath)
	} catch (err) {
		console.warn("[export-post-process] Failed to post-process HTML export:", err)
	}
	return filePath
}
const helpOrVersion = isHelpOrVersionArgs(process.argv.slice(2))

// Internal control signal: setup cancellation must skip harness/extensions
// without a hard process.exit(), so clack can restore terminal state normally.
class SetupCancelled extends Error {}

try {
	// Top-level kimchi subcommands (setup, claude, opencode, …) and the
	// top-level --help take ownership before any harness setup runs.
	// `--version` falls through to pi-coding-agent's main below so it prints
	// the version using piConfig.name = "kimchi".
	const dispatch = await dispatchSubcommand(process.argv.slice(2))
	if (dispatch.kind === "handled") {
		await drainPreSessionTelemetry()
		process.exit(dispatch.exitCode)
	}

	if (helpOrVersion) {
		const { main } = await import("@earendil-works/pi-coding-agent")
		await main(process.argv.slice(2), { extensionFactories: [] })
	} else {
		// Fire harness_launched (one shot per harness session; respects telemetry opt-out)
		if (telemetryConfig.enabled) {
			sendPreSessionEvent(telemetryConfig, "harness_launched", { version: getVersion() })
		}

		const experimentalFeatures = isExperimentalFeaturesArg(process.argv.slice(2))
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
				if (result.cancelled) {
					process.exitCode = 130
					throw new SetupCancelled()
				}
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

		let currentApiKey = apiKey
		let models: Awaited<ReturnType<typeof updateModelsConfig>>["models"]
		try {
			;({ models } = await updateModelsConfig(modelsJsonPath, currentApiKey, { endpoint: config.customLlmEndpoint }))
			if (experimentalFeatures) {
				injectExperimentalProvider(modelsJsonPath, currentApiKey ?? "")
				models = [...models, ...readExperimentalModels(modelsJsonPath)]
			}
			// Auto-discover a local Ollama server and merge its models into the
			// registry. Probe is silent on failure — startup is never blocked.
			await injectOllamaProvider(modelsJsonPath, resolveOllamaHost())
			models = [...models, ...readOllamaModelMetadata(modelsJsonPath)]
		} catch (err) {
			const is401 = err instanceof Error && err.message.includes("401")
			if (is401 && process.stdin.isTTY) {
				console.warn("API key is invalid or expired. Redirecting to setup...")
				writeApiKey("")
				config = loadConfig()
				const { runWizard } = await import("./setup-wizard/index.js")
				const wizardResult = await runWizard()
				if (wizardResult.cancelled) {
					await drainPreSessionTelemetry()
					process.exit(130)
				}
				currentApiKey = wizardResult.apiKey ?? ""
				writeApiKey(currentApiKey)
				config = loadConfig()
				;({ models } = await updateModelsConfig(modelsJsonPath, currentApiKey, { endpoint: config.customLlmEndpoint }))
				if (experimentalFeatures) {
					injectExperimentalProvider(modelsJsonPath, currentApiKey)
					models = [...models, ...readExperimentalModels(modelsJsonPath)]
				}
				await injectOllamaProvider(modelsJsonPath, resolveOllamaHost())
				models = [...models, ...readOllamaModelMetadata(modelsJsonPath)]
			} else if (isTransientModelsError(err)) {
				// Rate limit / gateway error with no cached models to fall back on.
				// Don't crash startup over a transient condition — continue with an
				// empty list; the login gate and later refreshes will repopulate it.
				console.warn(
					`Could not load the model list right now (${err instanceof Error ? err.message : String(err)}). Continuing; models will refresh once the service is reachable.`,
				)
				models = []
			} else {
				throw err
			}
		}

		// Must run before main() so the keybindings file is loaded with the
		// override in place.
		writeKimchiKeybindingDefaults(agentDir)

		// Share the discovered model metadata with extensions before main() runs.
		// prompt-enrichment reads this to build ModelRegistry with live model IDs.
		setAvailableModels(models)

		// Wire Ollama-discovered models into the explorer / reviewer / builder
		// role pools. Runs after setAvailableModels so the resolved roles
		// singleton reflects the same model list the picker exposes.
		const ollamaModelsForRoles = readOllamaModelsFromConfig(modelsJsonPath)
		if (ollamaModelsForRoles.length > 0) {
			applyRoleAugmentation((roles) => augmentModelRolesWithOllama(roles, ollamaModelsForRoles))
		}

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

		// Sync retry config to SDK settings so both systems use the same value
		try {
			const existing = JSON.parse(readFileSync(settingsPath, "utf-8"))
			const sdkRetry = existing.retry
			if (!sdkRetry || sdkRetry.maxRetries !== config.retry.maxRetries) {
				existing.retry = { ...sdkRetry, maxRetries: config.retry.maxRetries }
				writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`)
			}
		} catch {
			/* retry sync is best-effort */
		}

		// Bundled themes are write-through cache — owned by the package, not the user.
		// Source edits propagate so packaged upgrades pick up new defaults. Users
		// wanting custom colors should clone+rename (e.g. `my-kimchi.json`), which
		// this loop won't touch. The kimchi-minimal source keeps all six bg tokens
		// as `""` placeholders; the kimchi-minimal-tints extension fills them in
		// per-process at session_start from the OSC 11 probe.
		const themesDir = resolve(agentDir, "themes")
		const bundledThemes = [
			"kimchi.json",
			"kimchi-minimal.json",
			"kimchi-light.json",
			"dark.json",
			"light.json",
			"night-owl.json",
			"nord.json",
			"one-dark.json",
			"monokai.json",
			"catppuccin-macchiato.json",
			"lucent-orng.json",
			"dracula.json",
			"github-dark.json",
			"github-light.json",
			"solarized-dark.json",
			"solarized-light.json",
		]
		const bundledThemesSrcDir = isBunBinary
			? resolve(process.env.PI_PACKAGE_DIR ?? "", "theme")
			: resolve(dirname(fileURLToPath(import.meta.url)), "../themes")
		mkdirSync(themesDir, { recursive: true })

		// Probe runs here (before pi-mono takes stdin) so the result is cached for
		// the kimchi-minimal-tints and terminal-colors extensions. Skip non-TUI
		// modes: stdout belongs to the caller, and OSC escapes corrupt it.
		const rawArgs = stripExperimentalFeaturesArg(process.argv.slice(2))
		const terminalIo = {
			stdinIsTTY: process.stdin.isTTY === true,
			stdoutIsTTY: process.stdout.isTTY === true,
		}
		const terminalStartupOutputAllowed = isTerminalUiMode(rawArgs, terminalIo)
		if (terminalStartupOutputAllowed) {
			await probeTerminalBackground()
			await probeKittyKeyboardSupport()
		}

		// Emit warnings for terminals that don't support modifier-aware Enter.
		// Runs after the keyboard-capability probe so the result is available.
		if (terminalStartupOutputAllowed) emitTerminalCompatWarning(agentDir)

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

		// Clear the visible viewport and home the cursor so kimchi renders at the top.
		if (terminalStartupOutputAllowed) {
			process.stdout.write("\x1b[2J\x1b[H")
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

		const interactiveStartupContext = {
			nonInteractiveMode: acpMode,
			...terminalIo,
		}
		const startupAuthState = createStartupAuthGateState()
		const startupAuthGate = createStartupAuthGate({
			...interactiveStartupContext,
			state: startupAuthState,
		})
		const sessionModeOnboarding = createSessionModeOnboardingForStartup({
			rawArgs,
			...interactiveStartupContext,
			shouldSkip: () => startupAuthState.cancelled,
		})
		// Terminal chrome extensions need an actual TUI, not just an extension UI protocol.
		const terminalUiExtensionFactories = isTerminalUiMode(rawArgs, terminalIo)
			? [terminalColorsExtension, kimchiMinimalTintsExtension, uiExtension]
			: []
		const effectiveSkillPaths = [...new Set([...skillPaths, ...getActiveVendorSkillPaths()])]
		const extensionFactories = [
			startupUpdateExtension,
			superpowersExtension,
			sessionNameExtension(),
			shutdownMarkerExtension,
			statsExtension,
			...terminalUiExtensionFactories,
			loginExtension,
			startupAuthGate,
			loopGuardExtension,
			explorationGuardExtension,
			firstTurnOrientationExtension,
			reviewWriteGuardExtension,
			lspExtension,
			// Always registered — the tool_call handler checks isResourceEnabled
			// dynamically on every bash call, so enable/disable from /resources
			// takes effect immediately without a process restart.
			bashDefaultTimeoutExtension,
			bashToolGuardExtension,
			...enabledExtensionFactories([
				{ id: "plugins.mcp-apps", factory: mcpAdapterExtension },
			] satisfies ManagedExtensionFactory[]),
			ideAdapterExtension,
			// Ferment must see raw input before prompt enrichment rewrites print-mode text.
			...enabledExtensionFactories([
				{ id: "extensions.ferment", factory: fermentExtension },
			] satisfies ManagedExtensionFactory[]),
			questionnaireExtension,
			...enabledExtensionFactories([
				{ id: "extensions.claude-code-skills", factory: (pi) => claudeCodeSkillsExtension(pi, effectiveSkillPaths) },
			] satisfies ManagedExtensionFactory[]),
			promptEnrichmentExtension(effectiveSkillPaths),
			rtkRewriteExtension,
			...enabledExtensionFactories([
				{ id: "extensions.claude-code-hook-adapter", factory: claudeCodeHooksAdapter },
			] satisfies ManagedExtensionFactory[]),
			// Always-on, not user-visible: injects installed plugin packages'
			// SessionStart steering blocks into the system prompt. Gated per-package
			// by each package's own resource toggle (see pluginPackageHookSources).
			pluginPackageHooksAdapter,
			permissionsExtension,
			resourcesExtension,
			resourceToolBlockerExtension,
			behavioursExtension,
			promptSummaryExtension,
			...enabledExtensionFactories([
				{ id: "extensions.todos", factory: todosExtension },
			] satisfies ManagedExtensionFactory[]),
			hideThinkingExtension,
			thinkingStepsExtension,
			assistantPrefixExtension,
			clipboardImageExtension,
			sessionModeOnboarding,
			tipsExtension(),
			...enabledExtensionFactories([
				{ id: "extensions.agents", factory: agentsExtension },
			] satisfies ManagedExtensionFactory[]),
			helpExtension,
			themeSelectorExtension,
			customizeFooterExtension,
			inputHistoryExtension,
			reportBugExtension,
			tagsExtension,
			teleportExtension,
			telemetryExtension(telemetryConfig),
			surveysExtension(),
			toolRenderingExtension,
			toolGroupingExtension,
			...enabledExtensionFactories([
				{ id: "tools.web_fetch", factory: webFetchExtension },
				{ id: "tools.web_search", factory: webSearchExtension },
			] satisfies ManagedExtensionFactory[]),
			modelSwitchExtension,
			modelGuardExtension,
			stripImagesExtension,
			traceIdExtension,
			llmResponseLogExtension,
			activityExtension,
		]

		if (acpMode) {
			const { runAcpMode } = await import("./modes/acp/server.js")
			await runAcpMode({ extensionFactories, agentDir })
		} else {
			// Delegate to pi-mono's CLI main function, injecting the kimchi extension
			const { main } = await import("@earendil-works/pi-coding-agent")
			await main(rawArgs, { extensionFactories })
		}
	}
} catch (err) {
	await drainPreSessionTelemetry()
	if (err instanceof SetupCancelled) {
		process.exitCode = 130
	} else {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
