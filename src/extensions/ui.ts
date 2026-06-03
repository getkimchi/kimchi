import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"
import { Key, isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { RST_FG, resolvedAccentFg } from "../ansi.js"
import { PromptEditor } from "../components/editor.js"
import { ScriptFooter, StatsFooter, buildScriptPayload, readStatusLineCommand } from "../components/footer.js"
import { LogoHeader } from "../components/logo.js"
import { collapseAll, expandNext, resetState } from "../expand-state.js"
import { isBareExitAlias } from "./exit-utils.js"
import { formatFermentFooterDisplay } from "./ferment/footer-status.js"
import { getActiveFerment, getFermentContinuationPolicy } from "./ferment/index.js"
import { formatDuration } from "./format.js"
import { sessionHasImages } from "./model-guard.js"
import { splitModelRef } from "./orchestration/model-roles.js"
import {
	getMultiModelEnabled,
	getOrchestratorModelId,
	getOrchestratorModelRef,
	setMultiModelEnabled,
} from "./prompt-construction/prompt-enrichment.js"
import {
	isSessionModeOnboardingFooterSuppressed,
	registerSharedFooterRenderer,
	setSessionModeOnboardingFooterSuppressed,
} from "./shared-footer.js"
import { isRawInputCaptureActive } from "./shared-input.js"
import { createWorkingAnimator } from "./spinner.js"
import { getKittyKeyboardSupport } from "./terminal-compat/keyboard-capability.js"

export { requestSharedFooterRender, setSessionModeOnboardingFooterSuppressed } from "./shared-footer.js"

function modelsAreEqual(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id
}

// True when `data` is a terminal *response* to a query rather than a user
// keypress: OSC color reports (ESC ] … BEL/ST), DCS replies (ESC P … ST),
// primary device-attributes / kitty-keyboard replies (ESC [ ? … c|u), and
// cursor-position reports (ESC [ row;col R). Terminals such as iTerm2 and
// Ghostty emit these unbidden right after startup (answering our OSC 10/11
// background/foreground probes), so any "dismiss on any key" handler must skip
// them or it fires before the user ever sees the prompt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching raw terminal escape sequences
const TERMINAL_RESPONSE_RE = /^\x1b(?:[\]P]|\[\?[0-9;]*[cu]|\[[0-9;]*R)/
function isTerminalResponse(data: string): boolean {
	return TERMINAL_RESPONSE_RE.test(data)
}

/** Reason a model was skipped during ctrl+p cycle. */
export interface SkippedModel {
	model: Model<Api>
	reason: string
}

/** Result of findNextCompatibleModel — the selected model plus any skipped candidates. */
export interface NextModelResult {
	model: Model<Api> | undefined
	skipped: SkippedModel[]
}

/**
 * Iterates through the model list starting after currentIndex, wrapping around,
 * and returns the first model compatible with the current context (token count
 * and vision requirements). Also collects a list of all skipped models with
 * human-readable reasons, which the caller can surface in a notification.
 */
export function findNextCompatibleModel(
	available: readonly Model<Api>[],
	currentIndex: number,
	currentTokens: number | null,
	hasImages: boolean,
	currentModel?: Model<Api> | null,
): NextModelResult {
	const len = available.length
	if (len === 0) return { model: undefined, skipped: [] }

	const currentModelHasVision = currentModel?.input.includes("image") ?? false
	const skipped: SkippedModel[] = []

	for (let offset = 1; offset < len; offset++) {
		const idx = (currentIndex + offset) % len
		const candidate = available[idx]

		if (currentTokens !== null && candidate.contextWindow < currentTokens) {
			skipped.push({
				model: candidate,
				reason: `${(candidate.contextWindow / 1000).toFixed(0)}K context \u2014 current usage (${(currentTokens / 1000).toFixed(0)}K tokens) exceeds its window`,
			})
			continue
		}

		if (hasImages && !candidate.input.includes("image") && currentModelHasVision) {
			skipped.push({
				model: candidate,
				reason: "no vision support \u2014 run /strip-images to unlock",
			})
			continue
		}

		return { model: candidate, skipped }
	}

	return { model: undefined, skipped }
}

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

function getEnabledModelIds(): Set<string> | null {
	try {
		const raw = readFileSync(HARNESS_SETTINGS_PATH, "utf-8")
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed.enabledModels) && parsed.enabledModels.length > 0) {
			return new Set(parsed.enabledModels as string[])
		}
	} catch {
		// settings absent or unreadable
	}
	return null
}

// Track current editor for indicator updates
let currentEditor: PromptEditor | undefined
let pasteImageHandler: (() => void) | undefined
let currentSessionIndicatorText: string | null = null

type DisposableComponent = Component & { dispose?(): void }

class SuppressibleFooter implements Component {
	private readonly requestRender: () => void
	private readonly unregisterRequestRender: () => void

	constructor(
		private readonly inner: DisposableComponent,
		tui: TUI,
	) {
		this.requestRender = () => tui.requestRender()
		this.unregisterRequestRender = registerSharedFooterRenderer(this.requestRender)
	}

	dispose(): void {
		this.unregisterRequestRender()
		this.inner.dispose?.()
	}

	invalidate(): void {
		this.inner.invalidate()
	}

	render(width: number): string[] {
		return isSessionModeOnboardingFooterSuppressed() ? [] : this.inner.render(width)
	}
}

export function setPasteImageHandler(handler: () => void): void {
	pasteImageHandler = handler
}

/**
 * Show or clear a short status string right-aligned on the prompt's first row,
 * next to the placeholder. Used by the clipboard-image extension to surface
 * pending pasted attachments. Pass `null` to clear.
 */
export function setPendingImageIndicator(text: string | null): void {
	currentEditor?.setPendingImageIndicator(text)
}

/**
 * Show or clear a short session label right-aligned on the prompt's first row.
 * Used by the teleport extension to surface a persistent "(host)" indicator
 * while attached to a remote worker. Pass `null` to clear.
 */
export function setSessionIndicator(text: string | null): void {
	currentSessionIndicatorText = text
	currentEditor?.setSessionIndicator(text)
}

function runScript(scriptPath: string, payload: object, tui: TUI, footer: ScriptFooter, onDone: () => void): void {
	const child = spawn(scriptPath, [], {
		env: process.env,
		timeout: 1000,
	})

	let stdout = ""
	let stderr = ""
	child.stdout.on("data", (d: Buffer) => {
		stdout += d.toString()
	})
	child.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})
	child.stdin.write(JSON.stringify(payload))
	child.stdin.end()

	let settled = false
	const settle = (lines: string[] | null) => {
		if (settled) return
		settled = true
		if (lines) footer.setLines(lines)
		tui.requestRender()
		onDone()
	}

	child.on("error", (err) => settle([`\x1b[31m[statusline error] ${err.message}\x1b[0m`]))

	child.on("close", (code) => {
		if (code === 0 && stdout) {
			const lines = stdout.split("\n")
			while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()
			settle(lines)
		} else if (stderr) {
			settle([`\x1b[31m[statusline error] ${stderr.trim()}\x1b[0m`])
		} else {
			settle(null)
		}
	})
}

export default function uiExtension(pi: ExtensionAPI) {
	let unsubModelCycleInput: (() => void) | null = null
	let scriptFooter: ScriptFooter | null = null
	let scriptTui: TUI | null = null
	let uiTui: TUI | null = null
	let scriptCmd: string | null = null
	let scriptPending = false
	let scriptGeneration = 0
	let currentCtx: ExtensionContext | null = null
	let sessionStartMs = 0
	let turnStartMs = 0
	let linesAdded = 0
	let linesRemoved = 0
	let newlineHintHandle: { hide(): void } | null = null
	let thinkingStatus: "thinking" | number | null = null
	let thinkingStartMs = 0
	let workedForTimer: ReturnType<typeof setTimeout> | undefined
	let piToolsExpanded = false

	const refresh = (status: "idle" | "generating") => {
		if (!currentCtx?.hasUI || !scriptFooter || !scriptTui || !scriptCmd) return
		if (scriptPending) return
		scriptPending = true
		const gen = scriptGeneration
		runScript(
			scriptCmd,
			buildScriptPayload(currentCtx, status, sessionStartMs, linesAdded, linesRemoved),
			scriptTui,
			scriptFooter,
			() => {
				if (scriptGeneration === gen) scriptPending = false
			},
		)
	}

	pi.on("session_start", (event, ctx) => {
		setSessionModeOnboardingFooterSuppressed(false)
		stopWorkingAnimation?.()
		stopWorkingAnimation = undefined
		toolsInFlight = 0
		resetState()
		currentCtx = ctx
		sessionStartMs = Date.now()
		linesAdded = 0
		linesRemoved = 0
		scriptGeneration++
		scriptPending = false

		ctx.ui.setHeader((_tui, theme) => new LogoHeader(theme))
		ctx.ui.setFooter((tui, theme, footerData) => {
			uiTui = tui
			const cmd = readStatusLineCommand()
			if (!cmd) {
				scriptCmd = null
				return new SuppressibleFooter(new StatsFooter(ctx, theme, footerData), tui)
			}
			scriptCmd = cmd
			const getControlsLine = (): string | null => {
				const parts: string[] = []
				const ferment = formatFermentFooterDisplay(getActiveFerment(), getFermentContinuationPolicy(), {
					dim: (s) => theme.fg("dim", s),
					accent: (s) => `${resolvedAccentFg(theme)}${s}${RST_FG}`,
				})
				if (ferment) parts.push(ferment.text)
				const perm = footerData.getExtensionStatuses().get("permissions-mode")
				if (perm) parts.push(perm)
				const modelId = getMultiModelEnabled() ? `multi-model (${getOrchestratorModelId()})` : (ctx.model?.id ?? "n/a")
				parts.push(`${resolvedAccentFg(theme)}${modelId}${RST_FG} ${theme.fg("dim", "→ ctrl+p")}`)
				return parts.join(` ${theme.fg("dim", "·")} `)
			}
			scriptFooter = new ScriptFooter(getControlsLine)
			scriptTui = tui
			scriptPending = true
			const gen = scriptGeneration
			runScript(
				cmd,
				buildScriptPayload(ctx, "idle", sessionStartMs, linesAdded, linesRemoved),
				tui,
				scriptFooter,
				() => {
					if (scriptGeneration === gen) scriptPending = false
				},
			)
			return new SuppressibleFooter(scriptFooter, tui)
		})

		// Surface the Ctrl+J newline tip inside the TUI for terminals that don't
		// support the Kitty keyboard protocol (the real root-cause behind Shift+Enter
		// not working). The startup console warning is easy to miss (nag-throttled
		// and swallowed by TUI init), so a persistent per-session widget is more
		// visible than a one-time notification.
		if (getKittyKeyboardSupport() === false && ctx.hasUI) {
			const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
			if (agentDir) {
				try {
					const kbPath = resolve(agentDir, "keybindings.json")
					if (existsSync(kbPath)) {
						const kb = JSON.parse(readFileSync(kbPath, "utf-8"))
						const nl = kb["tui.input.newLine"]
						const settingsPath = resolve(agentDir, "settings.json")
						let settingsData: Record<string, unknown> = {}
						if (existsSync(settingsPath)) {
							try {
								settingsData = JSON.parse(readFileSync(settingsPath, "utf-8"))
							} catch {}
						}
						const nlHasCtrlJ =
							(typeof nl === "string" && nl.includes("ctrl+j")) ||
							(Array.isArray(nl) && nl.some((k: unknown) => typeof k === "string" && k.includes("ctrl+j")))
						if (!settingsData.newlineHintDismissed && nlHasCtrlJ) {
							ctx.ui.custom(
								(_tui, theme, _kb, done) => {
									const settingsFile = settingsPath
									const dismiss = () => {
										_tui.setShowHardwareCursor(true)
										done(undefined)
									}
									return {
										render(width: number): string[] {
											_tui.setShowHardwareCursor(false)
											const accent = theme.getFgAnsi("accent")
											const reset = "\x1b[0m"
											const box = new Box(2, 1)
											box.addChild(new Text(theme.inverse("  ⚠  Shift+Enter doesn't work in this terminal  ")))
											box.addChild(new Text(""))
											box.addChild(new Text(`Ctrl+J${" ".padEnd(13)}→  insert a newline`))
											box.addChild(new Text(`\\ + Enter${" ".padEnd(10)}→  insert a newline`))
											box.addChild(new Text(""))
											box.addChild(new Text(`Any key${" ".padEnd(12)}→  dismiss`))
											box.addChild(new Text(`${accent}d${" ".padEnd(18)}→  don't remind again${reset}`))
											const hbar = "─"
											const inner = width - 2
											const lines = box.render(inner)
											const bordered = lines.map((l: string, i: number) => {
												if (i === 0) return `${accent}┌${hbar.repeat(inner)}┐${reset}`
												if (i === lines.length - 1) return `${accent}└${hbar.repeat(inner)}┘${reset}`
												return `${accent}│${reset}${l}${accent}│${reset}`
											})
											return bordered
										},
										invalidate() {},
										handleInput(data: string): void {
											// Ignore terminal query responses (OSC color reports, DCS, primary
											// device-attributes, kitty-keyboard and cursor-position replies). These
											// arrive on stdin moments after the overlay opens — e.g. iTerm/Ghostty
											// answering kimchi's OSC 10/11 color probe — and must NOT count as the
											// "any key" dismissal, or the hint is torn down before it ever renders.
											if (isTerminalResponse(data)) return
											if (data === "d") {
												try {
													const s: Record<string, unknown> = {}
													if (existsSync(settingsFile)) {
														try {
															Object.assign(s, JSON.parse(readFileSync(settingsFile, "utf-8")))
														} catch {}
													}
													s.newlineHintDismissed = true
													writeFileSync(settingsFile, JSON.stringify(s, null, 2))
												} catch {}
											}
											dismiss()
										},
										wantsKeyRelease: false,
									}
								},
								{
									overlay: true,
									overlayOptions: { anchor: "center" },
									onHandle: (handle) => {
										newlineHintHandle = handle
									},
								},
							)
						}
					}
				} catch {
					// best-effort; don't break startup if keybindings are unreadable
				}
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			tui.setShowHardwareCursor(true)
			const editor = new PromptEditor(tui, editorTheme, keybindings, ctx.ui.theme)
			editor.setExpandHandler(() => {
				piToolsExpanded = !piToolsExpanded
				ctx.ui.setToolsExpanded(piToolsExpanded)
				if (piToolsExpanded) {
					expandNext()
				} else {
					collapseAll()
				}
			})
			currentEditor = editor
			if (pasteImageHandler) {
				editor.onPasteImage = pasteImageHandler
			}
			if (currentSessionIndicatorText) {
				editor.setSessionIndicator(currentSessionIndicatorText)
			}
			return editor
		})

		// Register a global terminal input listener so ctrl+p (model cycle forward)
		// works even when a permission prompt or other dialog has focus.
		// The cycle includes a virtual "multi-model" entry after the last real model.
		if (unsubModelCycleInput) unsubModelCycleInput()
		if (ctx.hasUI) {
			unsubModelCycleInput = ctx.ui.onTerminalInput((data) => {
				// In raw-mode terminals Ctrl+C arrives as \x03 rather than raising
				// SIGINT.  The upstream TUI already maps Escape to abort, but does
				// not handle Ctrl+C.  Bridge the gap so both keys cancel the active
				// turn while the agent is working.
				if (matchesKey(data, Key.ctrl("c")) && !isKeyRelease(data)) {
					if (currentCtx && !currentCtx.isIdle()) {
						currentCtx.abort()
					}
					return undefined
				}
				if (matchesKey(data, "ctrl+p")) {
					// Defer to a foreground UI that is forwarding raw terminal input
					// (e.g. the teleport overlay), so its consumer sees Ctrl+P.
					if (isRawInputCaptureActive()) return undefined
					if (!isKeyRelease(data)) {
						const allAvailable = ctx.modelRegistry.getAvailable()
						const enabledIds = getEnabledModelIds()
						const available = enabledIds
							? allAvailable.filter((m) => enabledIds.has(`${m.provider}/${m.id}`))
							: allAvailable
						const current = ctx.model
						const orchRef = getOrchestratorModelRef()
						const orchParsed = splitModelRef(orchRef)
						const orchestratorModel = orchParsed
							? ctx.modelRegistry.find(orchParsed.provider, orchParsed.modelId)
							: undefined

						// Cycle order: model[0] → ... → model[last] → multi-model → model[0]
						// kimi-k2.6 appears as a regular model AND multi-model appears
						// as a separate virtual entry right after the last real model.
						if (getMultiModelEnabled()) {
							// Currently on the virtual multi-model entry — wrap to first real model.
							// Check ALL models (including the orchestrator itself) because we are
							// leaving the virtual entry, not a real model — the orchestrator in
							// single-model mode is a valid distinct destination.
							if (available.length > 0) {
								const usage = ctx.getContextUsage()
								const tokens = usage?.tokens ?? null
								const images = sessionHasImages()
								const curVision = current?.input.includes("image") ?? false
								let firstReal: Model<Api> | undefined
								for (const candidate of available) {
									if (tokens !== null && candidate.contextWindow < tokens) continue
									if (images && !candidate.input.includes("image") && curVision) continue
									firstReal = candidate
									break
								}
								if (firstReal) {
									setMultiModelEnabled(false)
									if (current && modelsAreEqual(firstReal, current)) {
										// Model object is the same (orchestrator → orchestrator) so setModel
										// won't emit model_select and the footer won't re-render.
										// Force a re-render via a no-op status update.
										ctx.ui.setStatus("__model_cycle", undefined)
									} else {
										pi.setModel(firstReal).catch((err) => {
											ctx.ui.notify(
												`Failed to cycle model: ${err instanceof Error ? err.message : String(err)}`,
												"warning",
											)
										})
									}
								}
							}
						} else if (available.length > 0 && current) {
							let idx = available.findIndex((m) => modelsAreEqual(m, current))
							if (idx === -1) idx = 0

							const usage = ctx.getContextUsage()
							const { model: next, skipped } = findNextCompatibleModel(
								available,
								idx,
								usage?.tokens ?? null,
								sessionHasImages(),
								current,
							)

							const nextIdx = next ? available.findIndex((m) => modelsAreEqual(m, next)) : -1
							const wouldWrap = next === undefined || nextIdx <= idx

							if (wouldWrap && orchestratorModel) {
								// Reached end of real models — enter multi-model.
								setMultiModelEnabled(true)
								if (modelsAreEqual(orchestratorModel, current)) {
									// Already on the orchestrator — setModel won't emit model_select
									// so the footer won't re-render.  Force it.
									ctx.ui.setStatus("__model_cycle", undefined)
								} else {
									pi.setModel(orchestratorModel).catch((err) => {
										ctx.ui.notify(
											`Failed to switch to multi-model: ${err instanceof Error ? err.message : String(err)}`,
											"warning",
										)
									})
								}
							} else if (next && !modelsAreEqual(next, current)) {
								if (skipped.length > 0) {
									const lines = skipped.map((s) => `  • ${s.model.id}: ${s.reason}`)
									ctx.ui.notify(
										`Skipped ${skipped.length} model${skipped.length > 1 ? "s" : ""}:\n${lines.join("\n")}\n\nUse /compact to unlock models blocked by context size, or /strip-images for models without vision support.`,
										"info",
									)
								}
								pi.setModel(next).catch((err) => {
									ctx.ui.notify(`Failed to cycle model: ${err instanceof Error ? err.message : String(err)}`, "warning")
								})
							}
						}
					}
					return { consume: true }
				}
				return undefined
			})
		}
	})

	pi.on("session_shutdown", () => {
		stopWorkingAnimation?.()
		stopWorkingAnimation = undefined
		currentCtx = null
	})

	pi.on("input", (event, ctx) => {
		if (isBareExitAlias(event.text)) {
			ctx.shutdown()
		}

		// User typed something — clear any pending-user-input state so the spinner
		// does not stay suppressed on the next assistant message that follows.
		userInputPending = Math.max(0, userInputPending - 1)

		if (newlineHintHandle) {
			newlineHintHandle.hide()
			newlineHintHandle = null
		}
	})

	let stopWorkingAnimation: (() => void) | undefined
	let toolsInFlight = 0
	/** Tracks whether a tool-executed block is awaiting user input at the TUI.
	 *  Incremented when toolsInFlight hits 0 and the UI may be blocking (e.g. questionnaire).
	 *  Decremented when the user actually types a response (input event).
	 *  message_start checks this to avoid restarting the spinner while the user is being prompted.
	 */
	let userInputPending = 0

	const startIndicator = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingVisible(true)
		stopWorkingAnimation?.()
		stopWorkingAnimation = createWorkingAnimator((char, message) => {
			const accent = resolvedAccentFg(ctx.ui.theme)
			ctx.ui.setWorkingIndicator({ frames: [`${accent}${char}${RST_FG}`] })
			let suffix = ""
			if (thinkingStatus === "thinking") {
				suffix = ` ${ctx.ui.theme.fg("dim", "(thinking…)")}`
			} else if (typeof thinkingStatus === "number") {
				const secs = Math.max(1, Math.round(thinkingStatus / 1000))
				suffix = ` ${ctx.ui.theme.fg("dim", `(thought for ${secs}s)`)}`
			}
			ctx.ui.setWorkingMessage(`${accent}${message}${RST_FG}${suffix}`)
		})
	}

	pi.on("turn_start", (_, ctx) => {
		clearTimeout(workedForTimer)
		workedForTimer = undefined
		currentCtx = ctx
		toolsInFlight = 0
		userInputPending = 0
		turnStartMs = Date.now()
		thinkingStatus = null
		thinkingStartMs = 0
		refresh("generating")
		startIndicator(ctx)
	})
	pi.on("message_update", (event) => {
		const evt = event.assistantMessageEvent as { type: string }
		if (evt.type === "thinking_start") {
			thinkingStartMs = Date.now()
			thinkingStatus = "thinking"
		} else if (evt.type === "thinking_end") {
			if (thinkingStatus === "thinking") {
				const duration = Date.now() - thinkingStartMs
				thinkingStatus = duration > 100 ? duration : null
			}
		}
	})
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return
		// Only stop the tool animation when assistant text arrives if no tools are
		// still running AND we are not awaiting user input at the TUI. Parallel tool
		// calls (Kimi K2.5+, deepseek) may have their results arrive while the
		// assistant message is still streaming; keeping the indicator alive until all
		// tools finish avoids a premature flash-and-clear. userInputPending is set
		// by tool_execution_end when the last in-flight tool finishes and the UI may
		// be blocking on a prompt (e.g. questionnaire, ask_user).
		if (toolsInFlight === 0) {
			if (userInputPending > 0) {
				// Still waiting for user input — suppress spinner restart; decrement so
				// it re-arms for the next message_start if no user input arrives (e.g.
				// turn ends without a response).
				userInputPending--
				return
			}
			stopWorkingAnimation?.()
			stopWorkingAnimation = undefined
			ctx.ui.setWorkingVisible(false)
		}
	})
	pi.on("tool_execution_start", (_, ctx) => {
		toolsInFlight++
		startIndicator(ctx)
	})
	pi.on("tool_execution_end", (_, ctx) => {
		toolsInFlight = Math.max(0, toolsInFlight - 1)
		if (toolsInFlight === 0) {
			// Last tool finished — the UI may now be blocking waiting for user input
			// (e.g. a questionnaire prompt). Mark it so message_start does not restart
			// the spinner on the assistant text that follows before the user responds.
			userInputPending++
			stopWorkingAnimation?.()
			stopWorkingAnimation = undefined
			ctx.ui.setWorkingVisible(false)
		}
	})
	pi.on("turn_end", (_, ctx) => {
		currentCtx = ctx
		refresh("idle")
		if (ctx.hasUI && turnStartMs > 0) {
			clearTimeout(workedForTimer)
			const elapsed = Date.now() - turnStartMs
			ctx.ui.setWorkingVisible(true)
			ctx.ui.setWorkingMessage(ctx.ui.theme.fg("dim", `✻ Worked for ${formatDuration(elapsed)}`))
			workedForTimer = setTimeout(() => {
				workedForTimer = undefined
				ctx.ui.setWorkingVisible(false)
			}, 2500)
		}
	})
	pi.on("agent_end", (_, ctx) => {
		clearTimeout(workedForTimer)
		workedForTimer = undefined
		toolsInFlight = 0
		stopWorkingAnimation?.()
		stopWorkingAnimation = undefined
		ctx.ui.setWorkingVisible(false)
	})
	pi.on("model_select", (_, ctx) => {
		currentCtx = ctx
		refresh("idle")
		uiTui?.requestRender()
	})
	pi.on("session_shutdown", () => {
		setSessionModeOnboardingFooterSuppressed(false)
	})

	pi.on("tool_result", (event) => {
		if (isEditToolResult(event) && event.details?.diff) {
			for (const line of event.details.diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++
				else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++
			}
		} else if (isWriteToolResult(event)) {
			const content = event.input.content
			if (typeof content === "string") linesAdded += content.split("\n").length
		}
	})

	pi.registerCommand("exit", {
		description: "Exit the application (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown()
		},
	})

	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession()
		},
	})
}
