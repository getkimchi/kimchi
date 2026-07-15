import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui"
import { RST_FG, resolvedAccentFg } from "../ansi.js"
import { PromptEditor } from "../components/editor.js"
import { LogoHeader } from "../components/logo.js"
import { buildScriptPayload, readStatusLineCommand, StatusLine, StatusLineScript } from "../components/status-line.js"
import { collapseAll, expandNext, resetState } from "../expand-state.js"
import { refreshGitBranch } from "../utils.js"
import { getBillingStatusLine, getCommunityTierHeaderNotice, subscribeBillingStatus } from "./billing/status.js"
import { formatBillingStatusLine } from "./billing/status-line-format.js"
import { isBareExitAlias } from "./exit-utils.js"
import { getActiveFerment, getFermentContinuationPolicy } from "./ferment/index.js"
import { formatFermentStatusLineDisplay } from "./ferment/status-line.js"
import { formatDuration } from "./format.js"
import { sessionHasImages } from "./model-guard.js"
import { getMultiModelEnabled, setMultiModelEnabled } from "./multi-model.js"
import { getOrchestratorModelId, getOrchestratorModelRef, splitModelRef } from "./orchestration/model-roles.js"
import { isRawInputCaptureActive } from "./shared-input.js"
import {
	isSessionModeOnboardingStatusLineSuppressed,
	registerSharedStatusLineRenderer,
	setSessionModeOnboardingStatusLineSuppressed,
} from "./shared-status-line.js"
import { createWorkingAnimator } from "./spinner.js"
import { createBranchPoller } from "./ui-branch-poll.js"

export { requestSharedStatusLineRender, setSessionModeOnboardingStatusLineSuppressed } from "./shared-status-line.js"

function modelsAreEqual(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id
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

const branchPoller = createBranchPoller({
	refreshBranch: (cb) => refreshGitBranch(cb),
})

type DisposableComponent = Component & { dispose?(): void }

class SuppressibleStatusLine implements Component {
	private readonly requestRender: () => void
	private readonly unregisterRequestRender: () => void

	constructor(
		private readonly inner: DisposableComponent,
		tui: TUI,
	) {
		this.requestRender = () => tui.requestRender()
		this.unregisterRequestRender = registerSharedStatusLineRenderer(this.requestRender)
	}

	dispose(): void {
		this.unregisterRequestRender()
		this.inner.dispose?.()
	}

	invalidate(): void {
		this.inner.invalidate()
	}

	render(width: number): string[] {
		return isSessionModeOnboardingStatusLineSuppressed() ? [] : this.inner.render(width)
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

function runScript(
	scriptPath: string,
	payload: object,
	tui: TUI,
	scriptStatusLine: StatusLineScript,
	onDone: () => void,
): void {
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
		if (lines) scriptStatusLine.setLines(lines)
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

/**
 * Hide the cooking animation while an interactive prompt (ui.custom,
 * ui.select, ui.input, ui.confirm) has keyboard focus, then restore it.
 *
 * Only needed for prompts shown *during a turn* (tool execute(),
 * permission prompts, ferment step recovery). Command handlers run when the
 * agent is idle and don't need this.
 *
 * Uses try/finally so the indicator is restored even if the prompt throws
 * or the user cancels.
 */
export async function withWorkingHidden<T>(
	ctx: Pick<ExtensionContext, "ui"> | { ui?: { setWorkingVisible?: (visible: boolean) => void } },
	fn: () => Promise<T>,
): Promise<T> {
	ctx.ui?.setWorkingVisible?.(false)
	try {
		return await fn()
	} finally {
		ctx.ui?.setWorkingVisible?.(true)
	}
}

export default function uiExtension(pi: ExtensionAPI) {
	let unsubModelCycleInput: (() => void) | null = null
	let scriptStatusLine: StatusLineScript | null = null
	let scriptTui: TUI | null = null
	let uiTui: TUI | null = null
	let headerTui: TUI | null = null
	let unregisterBillingStatus: (() => void) | undefined
	let scriptCmd: string | null = null
	let scriptPending = false
	let scriptGeneration = 0
	let currentCtx: ExtensionContext | null = null
	let sessionStartMs = 0
	let turnStartMs = 0
	let linesAdded = 0
	let linesRemoved = 0
	let workedForTimer: ReturnType<typeof setTimeout> | undefined
	let piToolsExpanded = false

	const refresh = (status: "idle" | "generating") => {
		if (!currentCtx?.hasUI || !scriptStatusLine || !scriptTui || !scriptCmd) return
		if (scriptPending) return
		scriptPending = true
		const gen = scriptGeneration
		runScript(
			scriptCmd,
			buildScriptPayload(currentCtx, status, sessionStartMs, linesAdded, linesRemoved),
			scriptTui,
			scriptStatusLine,
			() => {
				if (scriptGeneration === gen) scriptPending = false
			},
		)
	}

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()

		setSessionModeOnboardingStatusLineSuppressed(false)
		stopWorkingAnimation?.()
		stopWorkingAnimation = undefined
		resetState()
		currentCtx = ctx
		sessionStartMs = Date.now()
		linesAdded = 0
		linesRemoved = 0
		scriptGeneration++
		scriptPending = false
		unregisterBillingStatus?.()
		unregisterBillingStatus = subscribeBillingStatus(() => {
			headerTui?.requestRender()
			uiTui?.requestRender()
		})

		ctx.ui.setHeader((tui, theme) => {
			headerTui = tui
			branchPoller.start(() => tui.requestRender())
			const logo = new LogoHeader(theme, {
				getBranch: () => branchPoller.getBranch(),
				getRightColumnNotice: getCommunityTierHeaderNotice,
			})
			const header: DisposableComponent = {
				render: (w) => logo.render(w),
				invalidate: () => logo.invalidate(),
				dispose: () => {
					if (headerTui === tui) headerTui = null
					branchPoller.stop()
				},
			}
			return header
		})
		ctx.ui.setFooter((tui, theme, statusLineData) => {
			uiTui = tui
			const cmd = readStatusLineCommand()
			if (!cmd) {
				scriptCmd = null
				return new SuppressibleStatusLine(new StatusLine(ctx, theme, statusLineData), tui)
			}
			scriptCmd = cmd
			const getControlsLine = (): string | null => {
				const parts: string[] = []
				const ferment = formatFermentStatusLineDisplay(getActiveFerment(), getFermentContinuationPolicy(), {
					dim: (s) => theme.fg("dim", s),
					accent: (s) => `${resolvedAccentFg(theme)}${s}${RST_FG}`,
				})
				if (ferment) parts.push(ferment.text)
				const perm = statusLineData.getExtensionStatuses().get("permissions-mode")
				if (perm) parts.push(perm)
				const billing = getBillingStatusLine()
				if (billing) parts.push(formatBillingStatusLine(billing, theme))
				const modelId = getMultiModelEnabled(ctx.sessionManager)
					? `multi-model (${getOrchestratorModelId(sessionId)})`
					: (ctx.model?.id ?? "n/a")
				parts.push(`${resolvedAccentFg(theme)}${modelId}${RST_FG} ${theme.fg("dim", "→ ctrl+p")}`)
				return parts.join(` ${theme.fg("dim", "·")} `)
			}
			scriptStatusLine = new StatusLineScript(getControlsLine)
			scriptTui = tui
			scriptPending = true
			const gen = scriptGeneration
			runScript(
				cmd,
				buildScriptPayload(ctx, "idle", sessionStartMs, linesAdded, linesRemoved),
				tui,
				scriptStatusLine,
				() => {
					if (scriptGeneration === gen) scriptPending = false
				},
			)
			return new SuppressibleStatusLine(scriptStatusLine, tui)
		})

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
						const orchRef = getOrchestratorModelRef(sessionId)
						const orchParsed = splitModelRef(orchRef)
						const orchestratorModel = orchParsed
							? ctx.modelRegistry.find(orchParsed.provider, orchParsed.modelId)
							: undefined

						// Cycle order: model[0] → ... → model[last] → multi-model → model[0]
						// kimi-k2.6 appears as a regular model AND multi-model appears
						// as a separate virtual entry right after the last real model.
						if (getMultiModelEnabled(ctx.sessionManager)) {
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
									setMultiModelEnabled(sessionId, false)
									if (current && modelsAreEqual(firstReal, current)) {
										// Model object is the same (orchestrator → orchestrator) so setModel
										// won't emit model_select and the status line won't re-render.
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
								setMultiModelEnabled(sessionId, true)
								if (modelsAreEqual(orchestratorModel, current)) {
									// Already on the orchestrator — setModel won't emit model_select
									// so the status line won't re-render.  Force it.
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
		branchPoller.stop()
	})

	pi.on("input", (event, ctx) => {
		if (isBareExitAlias(event.text)) {
			ctx.shutdown()
		}
	})

	let stopWorkingAnimation: (() => void) | undefined

	// ── Indicator lifecycle ──────────────────────────────────────────────────
	//
	// The cooking animation is ON whenever the assistant is mid-turn. It starts
	// at turn_start and stops at message_end / turn_end / agent_end.
	// tool_execution_end is a no-op — the indicator keeps running through the
	// tool-result gap because the turn is still active.
	//
	// Interactive prompts (ui.custom, ui.select, ui.input, ui.confirm) are the
	// one exception: while they have keyboard focus the spinner must be hidden
	// so it doesn't show behind the form. Each tool that shows an interactive
	// prompt during a turn wraps the call in `withWorkingHidden(ctx, fn)`
	// (exported below) — it calls setWorkingVisible(false), runs the prompt, then
	// restores setWorkingVisible(true) in a finally block. Currently:
	//   - questionnaire       (questionnaire.ts)
	//   - ask_user / confirm  (ferment/prompt-ui.ts)
	//   - permission prompts   (permissions/prompts.ts)
	//   - step recovery        (ferment/tools/steps.ts)
	//   - phase boundary       (ferment/tools/phases.ts)
	// Command handlers (/agents, /theme, /mcp, etc.) do NOT need this — they run
	// when the agent is idle, so the indicator is already off.

	const startIndicator = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingVisible(true)
		stopWorkingAnimation?.()
		stopWorkingAnimation = createWorkingAnimator((char, message) => {
			const accent = resolvedAccentFg(ctx.ui.theme)
			ctx.ui.setWorkingIndicator({ frames: [`${accent}${char}${RST_FG}`] })
			ctx.ui.setWorkingMessage(`${accent}${message}${RST_FG}`)
		})
	}

	const stopIndicator = (ctx: ExtensionContext) => {
		stopWorkingAnimation?.()
		stopWorkingAnimation = undefined
		ctx.ui.setWorkingVisible(false)
	}

	pi.on("turn_start", (_, ctx) => {
		clearTimeout(workedForTimer)
		workedForTimer = undefined
		currentCtx = ctx
		turnStartMs = Date.now()
		refresh("generating")
		startIndicator(ctx)
	})
	pi.on("message_update", (event, ctx) => {
		const evt = event.assistantMessageEvent as { type: string }
		if (evt.type === "thinking_start" && ctx) {
			// Re-arm: a permission prompt or tool result may have stopped the
			// spinner. Reasoning is in flight — keep the cooking animation visible.
			startIndicator(ctx)
		}
	})
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return
		// Re-arm the spinner. The upstream TUI only creates its loader once
		// session.isStreaming is true (which becomes true around message_start),
		// so the setWorkingVisible(true) call at turn_start was a rendering
		// no-op. This call triggers loader creation, making the cooking animation
		// visible during the message_start → first-content-event gap.
		// message_end stops it again once the assistant finishes.
		startIndicator(ctx)
	})
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return
		// Assistant finished its message. Stop the spinner so the response can
		// render cleanly. turn_end will follow up with the "Worked for Xs" display.
		stopIndicator(ctx)
	})
	pi.on("tool_execution_start", (_, ctx) => {
		// Re-arm: a permission prompt may have stopped the spinner during the
		// tool's argument-collection phase. The turn is still in flight.
		startIndicator(ctx)
	})
	pi.on("tool_execution_end", () => {
		// The turn is still active — keep the indicator running. It stops at the
		// next message_end (assistant text follows) or turn_end (model stops).
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
		stopIndicator(ctx)
	})
	pi.on("model_select", (_, ctx) => {
		currentCtx = ctx
		refresh("idle")
		uiTui?.requestRender()
	})
	pi.on("session_shutdown", () => {
		setSessionModeOnboardingStatusLineSuppressed(false)
		unregisterBillingStatus?.()
		unregisterBillingStatus = undefined
		headerTui = null
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
