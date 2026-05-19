import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import type { TUI } from "@earendil-works/pi-tui"
import { RST_FG, resolvedAccentFg } from "../ansi.js"
import { PromptEditor } from "../components/editor.js"
import { ScriptFooter, StatsFooter, buildScriptPayload, readStatusLineCommand } from "../components/footer.js"
import { LogoHeader } from "../components/logo.js"
import { collapseAll, expandNext, resetState } from "../expand-state.js"
import { isBareExitAlias } from "./exit-utils.js"
import { MULTI_MODEL_SHORTCUT, getMultiModelEnabled } from "./prompt-construction/prompt-enrichment.js"
import { createWorkingAnimator } from "./spinner.js"

function modelsAreEqual(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id
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
	let linesAdded = 0
	let linesRemoved = 0

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
				return new StatsFooter(ctx, theme, footerData)
			}
			scriptCmd = cmd
			const getControlsLine = (): string | null => {
				const parts: string[] = []
				const perm = footerData.getExtensionStatuses().get("permissions-mode")
				if (perm) parts.push(perm)
				const enabled = getMultiModelEnabled()
				const label = enabled ? `${resolvedAccentFg(theme)}on${RST_FG}` : theme.fg("dim", "off")
				const shortcut = MULTI_MODEL_SHORTCUT
				parts.push(`${theme.fg("dim", "multi-model:")} ${label} ${theme.fg("dim", `→ ${shortcut}`)}`)
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
			return scriptFooter
		})

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			tui.setShowHardwareCursor(true)
			const editor = new PromptEditor(tui, editorTheme, keybindings, ctx.ui.theme)
			editor.setExpandHandler(() => {
				if (!expandNext()) {
					collapseAll()
				}
				ctx.ui.setToolsExpanded(false)
			})
			currentEditor = editor
			if (pasteImageHandler) {
				editor.onPasteImage = pasteImageHandler
			}
			return editor
		})

		// Register a global terminal input listener so ctrl+p (model cycle forward)
		// works even when a permission prompt or other dialog has focus.
		if (unsubModelCycleInput) unsubModelCycleInput()
		if (ctx.hasUI) {
			unsubModelCycleInput = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "ctrl+p")) {
					if (!isKeyRelease(data)) {
						const allAvailable = ctx.modelRegistry.getAvailable()
						const enabledIds = getEnabledModelIds()
						const available = enabledIds
							? allAvailable.filter((m) => enabledIds.has(`${m.provider}/${m.id}`))
							: allAvailable
						const current = ctx.model
						if (available.length > 1 && current) {
							let idx = available.findIndex((m) => modelsAreEqual(m, current))
							if (idx === -1) idx = 0
							const next = available[(idx + 1) % available.length]
							pi.setModel(next).catch((err) => {
								ctx.ui.notify(`Failed to cycle model: ${err instanceof Error ? err.message : String(err)}`, "warning")
							})
						}
					}
					return { consume: true }
				}
				return undefined
			})
		}
	})

	pi.on("input", (event, ctx) => {
		if (isBareExitAlias(event.text)) {
			ctx.shutdown()
		}
	})

	let stopWorkingAnimation: (() => void) | undefined
	let toolsInFlight = 0

	const startIndicator = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingVisible(true)
		stopWorkingAnimation?.()
		stopWorkingAnimation = createWorkingAnimator((char, message) => {
			const accent = resolvedAccentFg(ctx.ui.theme)
			ctx.ui.setWorkingIndicator({ frames: [`${accent}${char}${RST_FG}`] })
			ctx.ui.setWorkingMessage(`${accent}${message}${RST_FG}`)
		})
	}

	pi.on("turn_start", (_, ctx) => {
		currentCtx = ctx
		toolsInFlight = 0
		refresh("generating")
		startIndicator(ctx)
	})
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return
		// Only stop the tool animation when assistant text arrives if no tools are
		// still running. Parallel tool calls (Kimi K2.5+, deepseek) may have their
		// results arrive while the assistant message is still streaming; keeping the
		// indicator alive until all tools finish avoids a premature flash-and-clear.
		if (toolsInFlight === 0) {
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
			stopWorkingAnimation?.()
			stopWorkingAnimation = undefined
			ctx.ui.setWorkingVisible(false)
		}
	})
	pi.on("turn_end", (_, ctx) => {
		currentCtx = ctx
		refresh("idle")
	})
	pi.on("agent_end", (_, ctx) => {
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
}
