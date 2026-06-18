import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readFile as readFileAsync } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"
import { formatDuration } from "../extensions/format.js"

import type {
	BashToolDetails,
	ExtensionAPI,
	GrepToolDetails,
	ReadToolDetails,
	Theme,
} from "@earendil-works/pi-coding-agent"
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent"
import {
	Container,
	Text,
	deleteAllKittyImages,
	getCapabilities,
	getImageDimensions,
	imageFallback,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"

import * as Diff from "diff"
import { getBashCommandForDisplay } from "./rtk-rewrite.js"
import type { BundledLanguage, BundledTheme } from "shiki"

const RESET = "\x1b[0m"
const TRANSPARENT_BG = "\x1b[49m"
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`

// Border / branch rule colors. Defaults match the previous hardcoded values
// so behavior is identical when the theme is unavailable or themeAdaptive=false.
// `applyThemePaletteIfNeeded(theme)` re-derives these from `theme.fg("borderMuted"|"muted")`.
let BORDER_COLOR = "\x1b[38;5;238m"
const ANSI_RE = /\x1b\[[0-9;]*m/g
const ANSI_PRESENT_RE = /\x1b\[[0-9;]*m/
const PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-container-render")
const TOOL_RENDER_CACHE = Symbol.for("pi-claude-style-tools:tool-render-cache")
const TOOL_CACHE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-cache-invalidation")
const TOOL_IMAGE_EXPAND_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-read-image-expansion")
const USER_MESSAGE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-user-message-render")
const HIDDEN_TOOL_BLOCK_NAMES = new Set(["write_todos"])
const WRAP_MARK = "\uE000"
const KITTY_IMAGE_PREFIX = "\x1b_G"
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File="

let toolBackgroundMode: "default" | "transparent" | "outlines" = "outlines"

interface SettingsFile {
	toolBackground?: "default" | "transparent" | "outlines" | "border"
	readOutputMode?: "hidden" | "summary" | "preview"
	searchOutputMode?: "hidden" | "count" | "preview"
	mcpOutputMode?: "hidden" | "summary" | "preview"
	previewLines?: number
	expandedPreviewMaxLines?: number
	bashOutputMode?: "opencode" | "summary" | "preview"
	bashCollapsedLines?: number
	showTruncationHints?: boolean
	diffCollapsedLines?: number
	diffTheme?: string
	diffColors?: Record<string, string>
	/**
	 * When true (default), derive borders, dim text, branch rules, and diff
	 * accents from the active pi theme via `theme.getFgAnsi`/`getBgAnsi`.
	 * Explicit `diffTheme` / `diffColors` always win over theme-derived
	 * defaults so users keep full control.
	 */
	themeAdaptive?: boolean
	/**
	 * Theme color key used for the spinner verb (e.g. "Cooking…"). Defaults
	 * to "accent". Useful when the active theme's accent is overloaded for
	 * borders, headings, or bash mode and the verb should pop differently.
	 * Valid keys are any of the pi theme `ThemeColor` names (e.g. accent,
	 * borderAccent, success, warning, mdHeading, thinkingMedium, bashMode).
	 */
	spinnerVerbColor?: string
	/**
	 * Theme color key used for the spinner status suffix (the parenthesized
	 * "(thinking · ↓ 10 tokens · 2s)" trailer). Defaults to "muted".
	 */
	spinnerStatusColor?: string
}

let _settingsCache: { value: SettingsFile; timestamp: number } | null = null
const SETTINGS_CACHE_TTL_MS = 5_000

function readSettings(): SettingsFile {
	const now = Date.now()
	if (_settingsCache && now - _settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return _settingsCache.value
	}
	const paths = [`${process.cwd()}/.pi/settings.json`, `${process.env.HOME ?? ""}/.pi/settings.json`]
	for (const path of paths) {
		try {
			if (!path || !existsSync(path)) continue
			const raw = JSON.parse(readFileSync(path, "utf8"))
			if (raw && typeof raw === "object") {
				const result = raw as SettingsFile
				_settingsCache = { value: result, timestamp: now }
				return result
			}
		} catch {
			// ignore invalid settings files
		}
	}
	const empty: SettingsFile = {}
	_settingsCache = { value: empty, timestamp: now }
	return empty
}

// Cross-extension bust signal for spinner.ts — it watches this counter on
// globalThis and invalidates its settings cache when it changes. Lets
// /cc-spinner edits take effect on the next 250ms spinner tick instead of
// waiting for the file-stat TTL.
const SPINNER_BUST_KEY = Symbol.for("pi-claude-style-tools:spinner-settings-bust")
function bustSpinnerSettingsCache(): void {
	const current = ((globalThis as any)[SPINNER_BUST_KEY] as number | undefined) ?? 0
	;(globalThis as any)[SPINNER_BUST_KEY] = current + 1
}

function writeSettingsKey(key: string, value: unknown): void {
	_settingsCache = null // invalidate cache on write
	const home = process.env.HOME ?? ""
	if (!home) return
	const dir = `${home}/.pi`
	const path = `${dir}/settings.json`
	let settings: Record<string, unknown> = {}
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {}
	} catch {
		/* start fresh */
	}
	if (value === undefined) {
		delete settings[key]
	} else {
		settings[key] = value
	}
	try {
		mkdirSync(dir, { recursive: true })
		writeFileSync(path, JSON.stringify(settings, null, 2) + "\n")
	} catch {
		/* best effort */
	}
}

let toolBackgroundOverride: "default" | "transparent" | "outlines" | null = null

function syncToolBackgroundMode(): void {
	if (toolBackgroundOverride) {
		toolBackgroundMode = toolBackgroundOverride
		return
	}
	const settings = readSettings()
	// Backward compat: "border" was renamed to "outlines"
	const raw = settings.toolBackground === "border" ? "outlines" : settings.toolBackground
	toolBackgroundMode = raw ?? "outlines"
}

function setThemeBg(theme: unknown, key: string, value: string): void {
	const themeAny = theme as any
	if (themeAny.bgColors instanceof Map) {
		themeAny.bgColors.set(key, value)
	} else if (themeAny.bgColors && typeof themeAny.bgColors === "object") {
		themeAny.bgColors[key] = value
	}
}

function applyToolBackgroundMode(theme: unknown): void {
	syncToolBackgroundMode()
	if (toolBackgroundMode === "default") return

	setThemeBg(theme, "toolPendingBg", TRANSPARENT_BG)
	setThemeBg(theme, "toolSuccessBg", TRANSPARENT_BG)
	setThemeBg(theme, "toolErrorBg", TRANSPARENT_BG)
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "")
}

function isBlankLine(text: string): boolean {
	// Strip ANSI escapes and the ▍ stroke prefix (with its trailing space) before checking.
	return stripAnsi(text).replace(/▍ ?/g, "").trim().length === 0
}

function borderLine(width: number): string {
	return `${BORDER_COLOR}${"─".repeat(Math.max(1, width))}${TRANSPARENT_RESET}`
}

function clampLineWidth(line: string, width: number): string {
	if (width <= 0) return ""
	return visibleWidth(line) > width ? truncateToWidth(line, width) : line
}

function isToolExecutionLike(value: unknown): value is { toolName: string; toolCallId: string } {
	if (!value || typeof value !== "object") return false
	const candidate = value as Record<string, unknown>
	return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string"
}

function isTerminalImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX)
}

function normalizeLeadingCheckGlyph(line: string): string {
	return line.replace(/^((?:\x1b\[[0-9;]*m|[ \t])*)[✓✔](?=\s)/, "$1●")
}

function firstImageBlockStart(lines: string[]): number {
	const imageLineIndex = lines.findIndex(isTerminalImageLine)
	if (imageLineIndex === -1) return -1
	let start = imageLineIndex
	while (start > 0 && isBlankLine(lines[start - 1])) start--
	return start
}

function splitRenderedImageBlock(lines: string[]): { textLines: string[]; imageLines: string[] } {
	const imageStart = firstImageBlockStart(lines)
	if (imageStart === -1) return { textLines: lines, imageLines: [] }
	const textLines = lines.slice(0, imageStart)
	while (textLines.length > 0 && isBlankLine(textLines[textLines.length - 1])) textLines.pop()
	return { textLines, imageLines: lines.slice(imageStart) }
}

function patchGlobalToolBorders(): void {
	const proto = Container.prototype as any
	if (proto[PATCH_FLAG]) return

	const originalRender = proto.render
	proto.render = function patchedContainerRender(width: number): string[] {
		if (isToolExecutionLike(this) && HIDDEN_TOOL_BLOCK_NAMES.has(this.toolName.toLowerCase())) return []
		if (isToolExecutionLike(this)) {
			const cached = (this as any)[TOOL_RENDER_CACHE]
			if (cached?.width === width && cached?.mode === toolBackgroundMode) {
				return cached.lines
			}
		}

		const rendered = originalRender.call(this, width)
		if (!Array.isArray(rendered) || rendered.length === 0) return rendered
		if (!isToolExecutionLike(this)) return rendered
		if (toolBackgroundMode === "default") {
			;(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered }
			return rendered
		}

		let start = 0
		while (start < rendered.length && isBlankLine(rendered[start])) start++
		let end = rendered.length - 1
		while (end >= start && isBlankLine(rendered[end])) end--
		if (start > end) return rendered

		const { textLines, imageLines } = splitRenderedImageBlock(rendered.slice(start, end + 1))
		if (imageLines.length > 0) {
			;(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: rendered }
			return rendered
		}
		const core = textLines.map((line) => clampLineWidth(normalizeLeadingCheckGlyph(line), width))
		const spacerLine = " ".repeat(width)
		let result: string[]

		if (toolBackgroundMode === "outlines") {
			const ruleWidth = Math.max(1, width)
			const framed = core.length > 0 ? [borderLine(ruleWidth), ...core, borderLine(ruleWidth)] : []
			result = [spacerLine, ...framed, ...imageLines]
		} else {
			result = [spacerLine, ...core, ...imageLines]
		}
		;(this as any)[TOOL_RENDER_CACHE] = { width, mode: toolBackgroundMode, lines: result }
		return result
	}

	proto[PATCH_FLAG] = true
}

function summarizeText(text: string, max = 60): string {
	const oneLine = text.replace(/\n/g, " ").trim()
	if (oneLine.length <= max) return oneLine
	return `${oneLine.slice(0, Math.max(0, max - 3))}...`
}

function hashText(text: string): string {
	let hash = 2166136261
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(36)
}

function clearToolRenderCache(value: unknown): void {
	if (!value || typeof value !== "object") return
	delete (value as any)[TOOL_RENDER_CACHE]
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	;(timer as any)?.unref?.()
}

const TOOL_EXECUTION_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-tool-execution")
const WORKED_DURATION_KEY = "_piClaudeStyleWorkedDurationMs"
const WORKED_START_KEY = "_piClaudeStyleWorkedStartMs"
const ASSISTANT_MESSAGE_PATCH_FLAG = Symbol.for("pi-claude-style-tools:patched-assistant-message-render")
// OSC 133 zone markers applied by AssistantMessageComponent.render() — must be
// reattached to the last line after we append the duration widget.
const OSC133_ZONE_END = "\x1b]133;B\x07"
const OSC133_ZONE_FINAL = "\x1b]133;C\x07"
const OSC133_ZONE_SUFFIX = OSC133_ZONE_END + OSC133_ZONE_FINAL
// WORKED_LINE_FG is theme-derived (from "muted") when themeAdaptive is on.
let WORKED_LINE_FG = "\x1b[38;2;140;140;140m"
let currentAgentWorkStartMs: number | undefined
let currentAssistantMessageStartMs: number | undefined

function formatWorkedDuration(ms: number): string {
	const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0)
	if (safeMs < 60_000) {
		return `${Math.max(0, Math.floor(safeMs / 1000))}s`
	}
	let days = Math.floor(safeMs / 86_400_000)
	let hours = Math.floor((safeMs % 86_400_000) / 3_600_000)
	let minutes = Math.floor((safeMs % 3_600_000) / 60_000)
	let seconds = Math.round((safeMs % 60_000) / 1000)
	if (seconds === 60) {
		seconds = 0
		minutes++
	}
	if (minutes === 60) {
		minutes = 0
		hours++
	}
	if (hours === 24) {
		hours = 0
		days++
	}
	if (days > 0) return `${days}d ${hours}h ${minutes}m`
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
	return `${minutes}m ${seconds}s`
}

/**
 * Returns elapsed milliseconds for a tool call.
 *
 * Note: `ctx.state` is the component's `rendererState` — the upstream
 * framework's `getRenderContext` method aliases them via
 * `state: this.rendererState`.
 */
export function getToolElapsedMs(ctx: any): number {
	const startedAt = ctx?.state?._executionStartedAt
	if (!startedAt) return 0
	const endedAt = ctx?.state?._executionEndedAt
	return (endedAt ?? Date.now()) - startedAt
}

export function formatToolTimer(elapsedMs: number): string | undefined {
	if (elapsedMs <= 0) return undefined
	return formatDuration(elapsedMs)
}

// One space of indent — aligns the ✻ glyph with the assistant message body.
const WORKED_DURATION_INDENT = " "

function inlineWorkedDurationText(ms: number): string {
	return `${WORKED_DURATION_INDENT}${WORKED_LINE_FG}✻ Worked for ${formatWorkedDuration(ms)}${RESET}`
}

function patchAssistantMessageRender(): void {
	const proto = AssistantMessageComponent.prototype as any
	if (proto[ASSISTANT_MESSAGE_PATCH_FLAG]) return
	const originalRender = proto.render
	if (typeof originalRender !== "function") return
	proto.render = function patchedAssistantMessageRender(width: number) {
		const lines: string[] = originalRender.call(this, width)
		if (!Array.isArray(lines) || lines.length === 0) return lines
		const message = (this as any).lastMessage
		const durationMs = message?.[WORKED_DURATION_KEY]
		if (typeof durationMs !== "number" || durationMs <= 0) return lines
		// The original render() appends OSC 133 zone markers to the last line
		// (B = command end, C = command output). Strip them off, push the widget
		// line, then reattach so the zone still brackets the full message.
		const lastIdx = lines.length - 1
		const widgetLine = inlineWorkedDurationText(durationMs)
		if (lines[lastIdx].includes(OSC133_ZONE_END)) {
			lines[lastIdx] = lines[lastIdx].replace(OSC133_ZONE_SUFFIX, "")
			lines.push("", widgetLine)
			lines[lines.length - 1] += OSC133_ZONE_SUFFIX
		} else {
			lines.push("", widgetLine)
		}
		return lines
	}
	proto[ASSISTANT_MESSAGE_PATCH_FLAG] = true
}

// OSC 133 zone markers that UserMessageComponent prepends/appends for shell integration.
// A one-line message can start with multiple markers because the first and last
// rendered lines are the same physical line.
const OSC133_MARKER_RE = /^(?:\x1b\]133;[ABC]\x07)+/

export function splitLeadingOsc133Markers(line: string): { markers: string; rest: string } {
	const match = line.match(OSC133_MARKER_RE)
	if (!match) return { markers: "", rest: line }
	const markers = match[0]
	return { markers, rest: line.slice(markers.length) }
}

export function patchUserMessageRender(): void {
	const proto = UserMessageComponent.prototype as any
	if (proto[USER_MESSAGE_PATCH_FLAG]) return
	const originalRender = proto.render
	if (typeof originalRender !== "function") return
	proto.render = function patchedUserMessageRender(width: number) {
		const box = (this as any).contentBox
		if (box) {
			// Remove the ▍ stroke and blank padding lines. paddingX=0 lets content
			// render at full width; we prepend the prefix and truncate explicitly.
			box.bgFn = null
			box.paddingY = 0
			box.paddingX = 0
			box.invalidateCache?.()
		}
		const theme = _themePaletteCacheTheme as any
		const glyph = typeof theme?.fg === "function" ? theme.fg("accent", "❯") : "❯"
		const prefix = ` ${glyph} `
		const prefixW = visibleWidth(prefix)
		// Render content narrower so all lines fit when we prepend the indent.
		const innerWidth = Math.max(1, width - prefixW)
		const lines: string[] = originalRender.call(this, innerWidth)
		if (!Array.isArray(lines) || lines.length === 0) return lines
		const indent = " ".repeat(prefixW)
		const hasBg = typeof theme?.bg === "function"
		for (let i = 0; i < lines.length; i++) {
			const linePrefix = i === 0 ? prefix : indent
			const { markers, rest } = i === 0 ? splitLeadingOsc133Markers(lines[0]) : { markers: "", rest: lines[i] }
			const composed = linePrefix + rest
			const pad = Math.max(0, width - visibleWidth(composed))
			const styled = hasBg ? theme.bg("userMessageBg", composed + " ".repeat(pad)) : composed
			lines[i] = markers + styled
		}
		return lines
	}
	proto[USER_MESSAGE_PATCH_FLAG] = true
}

export function patchToolRenderCacheInvalidation(): void {
	const proto = ToolExecutionComponent.prototype as any
	if (proto[TOOL_CACHE_PATCH_FLAG]) return

	const methods = [
		"updateDisplay",
		"updateArgs",
		"markExecutionStarted",
		"setArgsComplete",
		"updateResult",
		"setExpanded",
		"setShowImages",
		"setImageWidthCells",
		"invalidate",
	]

	for (const method of methods) {
		const original = proto[method]
		if (typeof original !== "function") continue
		proto[method] = function patchedToolMutation(...args: any[]) {
			clearToolRenderCache(this)
			if (method === "markExecutionStarted" && !this.rendererState._executionStartedAt) {
				this.rendererState._executionStartedAt = Date.now()
			}
			if (
				method === "updateResult" &&
				!this.rendererState._executionEndedAt &&
				args[1] !== true
			) {
				this.rendererState._executionEndedAt = Date.now()
			}
			const result = original.apply(this, args)
			clearToolRenderCache(this)
			return result
		}
	}

	proto[TOOL_CACHE_PATCH_FLAG] = true
}

function deleteRenderedKittyImages(component: any): void {
	if (
		!process.stdout.isTTY ||
		getCapabilities().images !== "kitty" ||
		!Array.isArray(component.imageComponents) ||
		component.imageComponents.length === 0
	)
		return
	try {
		process.stdout.write(deleteAllKittyImages())
	} catch {
		/* noop */
	}
}

function removeImageChildren(component: any): void {
	deleteRenderedKittyImages(component)
	const children = [
		...(Array.isArray(component.imageComponents) ? component.imageComponents : []),
		...(Array.isArray(component.imageSpacers) ? component.imageSpacers : []),
	]
	for (const child of children) {
		try {
			component.removeChild?.(child)
		} catch {
			/* noop */
		}
	}
	component.imageComponents = []
	component.imageSpacers = []
}

function patchReadImageExpansion(): void {
	const proto = ToolExecutionComponent.prototype as any
	if (proto[TOOL_IMAGE_EXPAND_PATCH_FLAG]) return
	const originalUpdateDisplay = proto.updateDisplay
	if (typeof originalUpdateDisplay !== "function") return
	proto.updateDisplay = function patchedReadImageUpdateDisplay(...args: any[]) {
		const result = originalUpdateDisplay.apply(this, args)
		const hasImage =
			Array.isArray(this.result?.content) && this.result.content.some((block: any) => block?.type === "image")
		if (this.toolName === "read" && hasImage && this.expanded !== true) {
			removeImageChildren(this)
			clearToolRenderCache(this)
		}
		return result
	}
	proto[TOOL_IMAGE_EXPAND_PATCH_FLAG] = true
}

function patchToolExecutionRenderers(): void {
	const proto = ToolExecutionComponent.prototype as any
	if (proto[TOOL_EXECUTION_PATCH_FLAG]) return

	const originalHasRendererDefinition = proto.hasRendererDefinition
	const originalGetCallRenderer = proto.getCallRenderer
	const originalGetResultRenderer = proto.getResultRenderer

	if (typeof originalHasRendererDefinition === "function") {
		proto.hasRendererDefinition = function patchedHasRendererDefinition() {
			return originalHasRendererDefinition.call(this) || shouldUseGenericToolRenderer(this?.toolName)
		}
	}

	proto.getCallRenderer = function patchedGetCallRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : ""
		if (toolName === "apply_patch") {
			return (args: any, theme: Theme, ctx: any) =>
				renderApplyPatchCall(args, theme, ctx, (path: string) => shortPath(ctx.cwd ?? process.cwd(), path))
		}
		if (shouldUseGenericToolRenderer(toolName)) {
			return (args: any, theme: Theme, ctx: any) => renderGenericToolCall(toolName, args, theme, ctx)
		}
		return typeof originalGetCallRenderer === "function" ? originalGetCallRenderer.call(this) : undefined
	}

	proto.getResultRenderer = function patchedGetResultRenderer() {
		const toolName = typeof this?.toolName === "string" ? this.toolName : ""
		if (toolName === "apply_patch") {
			return (result: any, options: any, theme: Theme, ctx: any) =>
				renderApplyPatchResult({ content: result.content, details: result.details }, options.isPartial, theme, ctx)
		}
		if (shouldUseGenericToolRenderer(toolName)) {
			return (result: any, options: any, theme: Theme, ctx: any) =>
				renderGenericToolResult(toolName, result, options, theme, ctx)
		}
		return typeof originalGetResultRenderer === "function" ? originalGetResultRenderer.call(this) : undefined
	}

	proto[TOOL_EXECUTION_PATCH_FLAG] = true
}

function shortPath(cwd: string, filePath: string): string {
	if (!filePath) return ""
	const rel = relative(cwd, filePath)
	if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || "."
	const home = process.env.HOME ?? ""
	return home ? filePath.replace(home, "~") : filePath
}

// ---------------------------------------------------------------------------
// Status dot — flickers green/gray while pending
// ---------------------------------------------------------------------------

export function toolHeader(tool: string, summary: string, theme: Theme, prefix = "", timer?: string): string {
	applyThemePaletteIfNeeded(theme)
	const label = theme.fg("toolTitle", theme.bold(tool))
	let result = `${prefix}${label}`
	if (summary) result += ` ${WRAP_MARK}${theme.fg("accent", summary)}`
	if (timer) result += ` ${theme.fg("dim", timer)}`
	return result
}


function shouldRevealCallArgs(ctx: any): boolean {
	if (ctx?.argsComplete === true || ctx?.executionStarted === true) return true
	const args = ctx?.args
	if (!args || typeof args !== "object") return false
	return Object.keys(args).some((key) => args[key] !== undefined && args[key] !== null && args[key] !== "")
}

function stableCallSummary(ctx: any, key: string, build: () => string, reveal = shouldRevealCallArgs(ctx)): string {
	const state = ctx?.state
	const cached = state?.[key]
	const completeKey = `${key}Complete`
	if (!reveal) return typeof cached === "string" ? cached : ""
	if (ctx?.argsComplete === true && state?.[completeKey] === true && typeof cached === "string") return cached
	if (!shouldRevealCallArgs(ctx) && typeof cached === "string" && cached) return cached
	const summary = build()
	if (state) {
		state[key] = summary
		if (ctx?.argsComplete === true) state[completeKey] = true
		else delete state[completeKey]
	}
	return summary
}

function hasOwnArg(args: any, key: string): boolean {
	return !!args && Object.prototype.hasOwnProperty.call(args, key)
}

function fileExistsForTool(cwd: string, filePath: string): boolean {
	if (!filePath) return false
	try {
		return existsSync(resolve(cwd, filePath))
	} catch {
		return false
	}
}

const WRITE_EXISTED_BEFORE = new Map<string, boolean>()

function getWriteWasNewFile(
	ctx: any,
	cwd: string,
	filePath: string,
	reveal = shouldRevealCallArgs(ctx),
): boolean | undefined {
	if (typeof ctx?.state?._writeWasNewFile === "boolean") return ctx.state._writeWasNewFile
	if (!filePath || !reveal) return undefined
	const existedBefore = typeof ctx?.toolCallId === "string" ? WRITE_EXISTED_BEFORE.get(ctx.toolCallId) : undefined
	const wasNew = existedBefore === undefined ? !fileExistsForTool(cwd, filePath) : !existedBefore
	if (ctx?.state) ctx.state._writeWasNewFile = wasNew
	return wasNew
}

function toolStatusDot(ctx: any, theme: Theme): string {
	if (!ctx.isPartial && !ctx.isError) return `${theme.fg("success", "●")} `
	if (!ctx.isPartial && ctx.isError) return `${theme.fg("error", "●")} `
	return `${blinkDot(ctx, theme)} `
}

// ---------------------------------------------------------------------------
// Branch connector — visual tree from header to output
// ---------------------------------------------------------------------------

function branchIndent(text: string, continued = false): string {
	const prefix = continued ? `${TOOL_RULE}│${TRANSPARENT_RESET}  ` : "   "
	return `${prefix}${WRAP_MARK}${text}`
}

function branchLead(text: string, continued = false): string {
	return `${TOOL_RULE}${continued ? "├─" : "└─"}${TRANSPARENT_RESET} ${WRAP_MARK}${text}`
}

function withBranch(content: string, _theme: Theme, _isError = false, continued = false): string {
	if (!content || !content.trim()) return ""
	const lines = content.split("\n")
	const first = lines[0] ?? ""
	if (lines.length === 1) return branchLead(first, continued)
	const rest = lines.slice(1).map((line) => branchIndent(line, continued))
	return `${branchLead(first, continued)}\n${rest.join("\n")}`
}

function withFinalBranchBlock(content: string): string {
	if (!content || !content.trim()) return ""
	const lines = content.split("\n")
	const first = lines[0] ?? ""
	if (lines.length === 1) return branchLead(first, false)
	const middle = lines.slice(1, -1).map((line) => branchIndent(line, true))
	const last = lines[lines.length - 1] ?? ""
	return [branchLead(first, true), ...middle, branchLead(last, false)].join("\n")
}

function indentBranchBlock(block: string): string {
	return block
		.split("\n")
		.map((line) => (line ? ` ${line}` : line))
		.join("\n")
}

// ---------------------------------------------------------------------------
// Blink timer for partial (running) states
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global blink timer — single timer invalidates all active contexts
// ---------------------------------------------------------------------------

const MAX_BLINKING_TOOLS = 5
const BLINK_INTERVAL_MS = 500

type BlinkEntry = { key: any; order: number; invalidate: () => void }

const _blinkContexts = new Map<any, BlinkEntry>()
let _globalBlinkTimer: ReturnType<typeof setTimeout> | null = null
let _blinkOrder = 0
let _globalBlinkPhase = true

function getBlinkIntervalMs(): number {
	return BLINK_INTERVAL_MS
}

function getBlinkKey(ctx: any): any {
	return ctx?.state ?? ctx
}

function getBlinkingEntries(): BlinkEntry[] {
	return [..._blinkContexts.values()].sort((a, b) => b.order - a.order).slice(0, MAX_BLINKING_TOOLS)
}

function updateBlinkActiveStates(): void {
	const activeSet = new Set(getBlinkingEntries().map((entry) => entry.key))
	for (const entry of _blinkContexts.values()) {
		const active = activeSet.has(entry.key)
		if (entry.key?._blinkActive !== active) {
			entry.key._blinkActive = active
			try {
				entry.invalidate()
			} catch {
				/* noop */
			}
		}
	}
}

function _scheduleGlobalBlinkTimer(): void {
	if (_globalBlinkTimer) return
	const intervalMs = getBlinkIntervalMs()
	if (_blinkContexts.size === 0) return
	_globalBlinkTimer = setTimeout(() => {
		_globalBlinkTimer = null
		if (_blinkContexts.size === 0) {
			updateBlinkActiveStates()
			return
		}
		_globalBlinkPhase = !_globalBlinkPhase
		for (const entry of getBlinkingEntries()) {
			try {
				entry.invalidate()
			} catch {
				/* noop */
			}
		}
		_scheduleGlobalBlinkTimer()
	}, intervalMs)
	unrefTimer(_globalBlinkTimer)
}

function _stopGlobalBlinkTimerIfEmpty(): void {
	if (_globalBlinkTimer && _blinkContexts.size === 0) {
		clearTimeout(_globalBlinkTimer)
		_globalBlinkTimer = null
	}
}

function setupBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx)
	if (!key) return
	const invalidate = typeof ctx?.invalidate === "function" ? () => ctx.invalidate() : () => {}
	const existing = _blinkContexts.get(key)
	if (existing) {
		// Already tracked — just refresh the invalidate fn, skip expensive recalc
		existing.invalidate = invalidate
		return
	}
	_blinkContexts.set(key, { key, order: ++_blinkOrder, invalidate })
	key._blinkActive = false
	updateBlinkActiveStates()
	_stopGlobalBlinkTimerIfEmpty()
	_scheduleGlobalBlinkTimer()
}

function clearBlinkTimer(ctx: any): void {
	const key = getBlinkKey(ctx)
	if (!key) return
	_blinkContexts.delete(key)
	key._blinkActive = false
	updateBlinkActiveStates()
	_stopGlobalBlinkTimerIfEmpty()
	_scheduleGlobalBlinkTimer()
}

function blinkDot(ctx: any, theme: Theme): string {
	setupBlinkTimer(ctx)
	const key = getBlinkKey(ctx)
	if (key?._blinkActive !== true) return theme.fg("muted", "○")
	return _globalBlinkPhase ? theme.fg("success", "●") : theme.fg("muted", "○")
}

// ---------------------------------------------------------------------------
// File icons — Nerd Font glyphs (requires Nerd Font terminal)
// ---------------------------------------------------------------------------

const NF_DIR = `\x1b[38;2;100;140;220m\ue5ff\x1b[0m`
const NF_DEFAULT = `\x1b[38;2;80;80;80m\uf15b\x1b[0m`

const EXT_ICON: Record<string, string> = {
	ts: `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	tsx: `\x1b[38;2;49;120;198m\ue7ba\x1b[0m`,
	js: `\x1b[38;2;241;224;90m\ue74e\x1b[0m`,
	jsx: `\x1b[38;2;97;218;251m\ue7ba\x1b[0m`,
	py: `\x1b[38;2;55;118;171m\ue73c\x1b[0m`,
	rs: `\x1b[38;2;222;165;132m\ue7a8\x1b[0m`,
	go: `\x1b[38;2;0;173;216m\ue724\x1b[0m`,
	java: `\x1b[38;2;204;62;68m\ue738\x1b[0m`,
	rb: `\x1b[38;2;204;52;45m\ue739\x1b[0m`,
	swift: `\x1b[38;2;255;172;77m\ue755\x1b[0m`,
	c: `\x1b[38;2;85;154;211m\ue61e\x1b[0m`,
	cpp: `\x1b[38;2;85;154;211m\ue61d\x1b[0m`,
	html: `\x1b[38;2;228;77;38m\ue736\x1b[0m`,
	css: `\x1b[38;2;66;165;245m\ue749\x1b[0m`,
	scss: `\x1b[38;2;207;100;154m\ue749\x1b[0m`,
	vue: `\x1b[38;2;65;184;131m\ue6a0\x1b[0m`,
	svelte: `\x1b[38;2;255;62;0m\ue697\x1b[0m`,
	json: `\x1b[38;2;241;224;90m\ue60b\x1b[0m`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	yml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
	toml: `\x1b[38;2;160;116;196m\ue6b2\x1b[0m`,
	md: `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	sh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	bash: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	zsh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
	lua: `\x1b[38;2;81;160;207m\ue620\x1b[0m`,
	php: `\x1b[38;2;137;147;186m\ue73d\x1b[0m`,
	sql: `\x1b[38;2;218;218;218m\ue706\x1b[0m`,
	xml: `\x1b[38;2;228;77;38m\ue619\x1b[0m`,
	graphql: `\x1b[38;2;224;51;144m\ue662\x1b[0m`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	lock: `\x1b[38;2;130;130;130m\uf023\x1b[0m`,
	png: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
	svg: `\x1b[38;2;255;180;50m\uf1c5\x1b[0m`,
	gif: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
}

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e\x1b[0m`,
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
	".gitignore": `\x1b[38;2;222;165;132m\ue702\x1b[0m`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
	makefile: `\x1b[38;2;130;130;130m\ue615\x1b[0m`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
	license: `\x1b[38;2;218;218;218m\ue60a\x1b[0m`,
}

function fileIcon(fp: string): string {
	const base = fp.split("/").pop()?.toLowerCase() ?? ""
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `
	const ext = base.includes(".") ? (base.split(".").pop() ?? "") : ""
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `
}

function dirIcon(): string {
	return `${NF_DIR} `
}

function lineCount(text: string): number {
	if (!text) return 0
	return text.split("\n").length
}

function padToWidth(line: string, width: number): string {
	const padding = Math.max(0, width - visibleWidth(line))
	return `${line}${" ".repeat(padding)}`
}

function markedContinuationPrefix(prefix: string): string {
	const plain = stripAnsi(prefix)
	const branchMatch = /^(\s*)(│ {2}|├─ |└─ )/.exec(plain)
	if (branchMatch) {
		const connector = branchMatch[2]
		if (connector === "└─ ") return `${branchMatch[1]}   `
		return `${branchMatch[1]}${TOOL_RULE}│${TRANSPARENT_RESET}  `
	}
	return " ".repeat(visibleWidth(prefix))
}

function wrapMarkedLine(line: string, width: number): string[] {
	const markerIndex = line.indexOf(WRAP_MARK)
	if (markerIndex === -1) return wrapTextWithAnsi(line, width)
	const prefix = line.slice(0, markerIndex)
	const body = line.slice(markerIndex + WRAP_MARK.length)
	const prefixWidth = visibleWidth(prefix)
	const bodyWidth = Math.max(1, width - prefixWidth)
	const wrapped = wrapTextWithAnsi(body, bodyWidth)
	const continuation = markedContinuationPrefix(prefix)
	return wrapped.map((part, index) => (index === 0 ? `${prefix}${part}` : `${continuation}${part}`))
}

class ToolText extends Text {
	private value = ""
	private toolCachedValue?: string
	private toolCachedWidth?: number
	private toolCachedLines?: string[]

	constructor(text = "") {
		super("", 0, 0)
		this.value = text
	}

	setText(text: string): void {
		if (this.value === text) return
		this.value = text
		this.invalidate()
	}

	invalidate(): void {
		this.toolCachedValue = undefined
		this.toolCachedWidth = undefined
		this.toolCachedLines = undefined
		super.invalidate()
	}

	render(width: number): string[] {
		if (this.toolCachedLines && this.toolCachedValue === this.value && this.toolCachedWidth === width)
			return this.toolCachedLines
		if (!this.value || this.value.trim() === "") {
			this.toolCachedValue = this.value
			this.toolCachedWidth = width
			this.toolCachedLines = []
			return this.toolCachedLines
		}
		const contentWidth = Math.max(1, width)
		const lines = this.value.replace(/\t/g, "   ").split("\n")
		const rendered = lines.flatMap((line) => wrapMarkedLine(line, contentWidth)).map((line) => padToWidth(line, width))
		this.toolCachedValue = this.value
		this.toolCachedWidth = width
		this.toolCachedLines = rendered
		return rendered
	}
}

function makeText(last: unknown, text: string): Text {
	const component = last instanceof ToolText ? last : new ToolText()
	component.setText(text)
	return component
}

function previewLimit(): number {
	const value = readSettings().previewLines
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 8
}

function expandedPreviewLimit(): number {
	const value = readSettings().expandedPreviewMaxLines
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 4000
}

function bashCollapsedLimit(): number {
	const value = readSettings().bashCollapsedLines
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 10
}

function diffCollapsedLimit(): number {
	const value = readSettings().diffCollapsedLines
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 24
}

function collapsedPreviewCount(expanded: boolean, fallback: number): number {
	return expanded ? expandedPreviewLimit() : fallback
}

function buildPreviewText(lines: string[], expanded: boolean, theme: Theme, fallbackCollapsed = 8): string {
	if (lines.length === 0) return theme.fg("muted", "(no output)")
	const maxLines = collapsedPreviewCount(expanded, fallbackCollapsed)
	const shown = lines.slice(0, maxLines)
	let text = shown.join("\n")
	const remaining = lines.length - shown.length
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines${expanded ? "" : " • ctrl+o to expand"})`)}`
	}
	if (expanded && lines.length > maxLines) {
		text += `\n${theme.fg("warning", `(display capped at ${maxLines} lines)`)}`
	}
	return text
}

// ===========================================================================
// Diff rendering — adapted from /tmp/pi-diff
// ===========================================================================

interface DiffPreset {
	name: string
	description: string
	shikiTheme?: string
	bgAdd?: string
	bgDel?: string
	bgAddHighlight?: string
	bgDelHighlight?: string
	bgGutterAdd?: string
	bgGutterDel?: string
	bgEmpty?: string
	fgAdd?: string
	fgDel?: string
	fgDim?: string
	fgLnum?: string
	fgRule?: string
	fgStripe?: string
	fgSafeMuted?: string
}

interface DiffUserConfig {
	diffTheme?: string
	diffColors?: Record<string, string>
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for black backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
}

function loadDiffConfig(): DiffUserConfig {
	const settings = readSettings()
	return { diffTheme: settings.diffTheme, diffColors: settings.diffColors }
}

// 6x6x6 color cube channel values used by pi's 256color fallback.
const CUBE_VALUES = [0, 95, 135, 175, 215, 255]

function xterm256ToRgb(index: number): { r: number; g: number; b: number } | null {
	if (!Number.isInteger(index) || index < 0 || index > 255) return null
	if (index < 16) {
		// Standard 16 ANSI colors — terminal-defined, approximate with VS Code defaults.
		const basic: Array<[number, number, number]> = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		]
		const [r, g, b] = basic[index]
		return { r, g, b }
	}
	if (index < 232) {
		const i = index - 16
		return {
			r: CUBE_VALUES[Math.floor(i / 36) % 6],
			g: CUBE_VALUES[Math.floor(i / 6) % 6],
			b: CUBE_VALUES[i % 6],
		}
	}
	const level = 8 + (index - 232) * 10
	return { r: level, g: level, b: level }
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	if (!ansi) return null
	const esc = "\u001b"
	// Truecolor: \e[38;2;R;G;Bm or \e[48;2;R;G;Bm
	const tc = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`))
	if (tc) return { r: +tc[1], g: +tc[2], b: +tc[3] }
	// 256-color: \e[38;5;Nm or \e[48;5;Nm — happens on Apple Terminal, screen, etc.
	const idx = ansi.match(new RegExp(`${esc}\\[(?:38|48);5;(\\d+)m`))
	if (idx) return xterm256ToRgb(+idx[1])
	return null
}

function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return ""
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)
	return `\x1b[48;2;${r};${g};${b}m`
}

function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return ""
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)
	return `\x1b[38;2;${r};${g};${b}m`
}

// ---------------------------------------------------------------------------
// Theme palette extraction — pull RGB from the active pi theme so our
// hardcoded greys and accent colors track the user's selected theme.
//
// `theme.getFgAnsi(name)` / `theme.getBgAnsi(name)` return raw ANSI escapes
// (either truecolor or 256color depending on the terminal). We parse those
// back into RGB so we can mix tints for diff backgrounds.
// ---------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number }

function safeFgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getFgAnsi?.(key)
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null
	} catch {
		return null
	}
}

function safeBgAnsi(theme: any, key: string): string | null {
	try {
		const ansi = theme?.getBgAnsi?.(key)
		return typeof ansi === "string" && ansi.length > 0 ? ansi : null
	} catch {
		return null
	}
}

function themeFgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeFgAnsi(theme, key)
	return ansi ? parseAnsiRgb(ansi) : null
}

function themeBgRgb(theme: any, key: string): Rgb | null {
	const ansi = safeBgAnsi(theme, key)
	return ansi ? parseAnsiRgb(ansi) : null
}

// Cache theme identity so we only recompute on theme change. The Theme
// object is reused across renders within a single session unless the user
// switches themes via the picker.
let _themePaletteCacheTheme: unknown = null

function themeAdaptiveEnabled(): boolean {
	const settings = readSettings()
	return settings.themeAdaptive !== false
}

let DIFF_THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark"
let codeToAnsiLoader: Promise<any> | null = null

const SPLIT_MIN_WIDTH = 150
const SPLIT_MIN_CODE_WIDTH = 60
const SPLIT_MAX_WRAP_RATIO = 0.2
const SPLIT_MAX_WRAP_LINES = 8
const MAX_TERM_WIDTH = 210
const DEFAULT_TERM_WIDTH = 200
const MAX_PREVIEW_LINES = 60
const MAX_RENDER_LINES = 150
const MAX_HL_CHARS = 32_000
const CACHE_LIMIT = 48
const WORD_DIFF_MIN_SIM = 0.15
const MAX_WRAP_ROWS_WIDE = 3
const MAX_WRAP_ROWS_MED = 2
const MAX_WRAP_ROWS_NARROW = 1

let D_RST = "\x1b[0m"
const D_BOLD = "\x1b[1m"
const D_DIM = "\x1b[2m"

// Diff backgrounds — defaults are transparent; autoDeriveBgFromTheme fills them
// using pi-tool-display's mix ratios against the theme's toolSuccessBg.
let BG_ADD = "\x1b[49m"
let BG_DEL = "\x1b[49m"
let BG_ADD_W = "\x1b[49m"
let BG_DEL_W = "\x1b[49m"
let BG_GUTTER_ADD = "\x1b[49m"
let BG_GUTTER_DEL = "\x1b[49m"
let BG_EMPTY = "\x1b[49m"
let BG_BASE = "\x1b[49m"

let FG_ADD = "\x1b[38;2;100;180;120m"
let FG_DEL = "\x1b[38;2;200;100;100m"
let FG_DIM = "\x1b[38;2;80;80;80m"
let FG_LNUM = "\x1b[38;2;100;100;100m"
let FG_RULE = "\x1b[38;2;50;50;50m"
let TOOL_RULE = "\x1b[38;2;153;153;153m"
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m"
let FG_STRIPE = "\x1b[38;2;40;40;40m"

let DIVIDER = `${FG_RULE}│${D_RST}`

interface DiffColors {
	fgAdd: string
	fgDel: string
	fgCtx: string
}

let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM }
let autoDerivePending = true
let hasExplicitBgConfig = false

// pi-tool-display tint targets for diff palette derivation
const ADDITION_TINT_TARGET = { r: 84, g: 190, b: 118 }
const DELETION_TINT_TARGET = { r: 232, g: 95, b: 122 }
// Fallback base that matches most dark themes (NOT black)
const FALLBACK_BASE_BG = { r: 32, g: 35, b: 42 }
const UNIVERSAL_DIFF_ADD_FG = { r: 110, g: 210, b: 130 }
const UNIVERSAL_DIFF_DEL_FG = { r: 225, g: 110, b: 110 }

function mixRgb(
	a: { r: number; g: number; b: number },
	b: { r: number; g: number; b: number },
	ratio: number,
): { r: number; g: number; b: number } {
	return {
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	}
}

function rgbToBgAnsi(c: { r: number; g: number; b: number }): string {
	return `\x1b[48;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`
}

function autoDeriveBgFromTheme(theme: any): void {
	// Diff palette derivation.
	//
	// `toolDiffAdded` / `toolDiffRemoved` from the active pi theme give us the
	// fg accents. The base background is taken from `toolSuccessBg` (close to
	// the panel color the row will sit on) so the tinted backgrounds blend in
	// instead of forcing a hardcoded dark hue. Falls back to the universal
	// dark palette when the theme is unavailable or themeAdaptive=false.
	const useTheme = themeAdaptiveEnabled() && theme
	const addFgRgb = (useTheme && themeFgRgb(theme, "toolDiffAdded")) || UNIVERSAL_DIFF_ADD_FG
	const delFgRgb = (useTheme && themeFgRgb(theme, "toolDiffRemoved")) || UNIVERSAL_DIFF_DEL_FG
	const base = (useTheme && themeBgRgb(theme, "toolSuccessBg")) || FALLBACK_BASE_BG

	const addTint = mixRgb(addFgRgb, ADDITION_TINT_TARGET, 0.35)
	const delTint = mixRgb(delFgRgb, DELETION_TINT_TARGET, 0.65)

	FG_ADD = `\x1b[38;2;${Math.round(addFgRgb.r)};${Math.round(addFgRgb.g)};${Math.round(addFgRgb.b)}m`
	FG_DEL = `\x1b[38;2;${Math.round(delFgRgb.r)};${Math.round(delFgRgb.g)};${Math.round(delFgRgb.b)}m`
	BG_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.24))
	BG_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.12))
	BG_ADD_W = rgbToBgAnsi(mixRgb(base, addTint, 0.44))
	BG_DEL_W = rgbToBgAnsi(mixRgb(base, delTint, 0.26))
	BG_GUTTER_ADD = rgbToBgAnsi(mixRgb(base, addTint, 0.14))
	BG_GUTTER_DEL = rgbToBgAnsi(mixRgb(base, delTint, 0.08))
	BG_EMPTY = TRANSPARENT_BG
	BG_BASE = TRANSPARENT_BG
	D_RST = TRANSPARENT_RESET
	DIVIDER = `${FG_RULE}│${D_RST}`
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM }
}

// Track which palette fields the user explicitly set so theme-derived
// updates don't clobber their config.
const _explicitFgFields = new Set<"fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted">()

// Original Claude-Code-style palette captured at module-load so we can
// restore it when the user toggles themeAdaptive off at runtime.
const _claudeStyleDefaults = {
	BORDER_COLOR: "\x1b[38;5;238m",
	WORKED_LINE_FG: "\x1b[38;2;140;140;140m",
	TOOL_RULE: "\x1b[38;2;153;153;153m",
	FG_DIM: "\x1b[38;2;80;80;80m",
	FG_LNUM: "\x1b[38;2;100;100;100m",
	FG_RULE: "\x1b[38;2;50;50;50m",
	FG_STRIPE: "\x1b[38;2;40;40;40m",
	FG_SAFE_MUTED: "\x1b[38;2;139;148;158m",
	FG_ADD: "\x1b[38;2;100;180;120m",
	FG_DEL: "\x1b[38;2;200;100;100m",
}

function resetThemePalette(): void {
	BORDER_COLOR = _claudeStyleDefaults.BORDER_COLOR
	WORKED_LINE_FG = _claudeStyleDefaults.WORKED_LINE_FG
	TOOL_RULE = _claudeStyleDefaults.TOOL_RULE
	if (!_explicitFgFields.has("fgDim")) FG_DIM = _claudeStyleDefaults.FG_DIM
	if (!_explicitFgFields.has("fgLnum")) FG_LNUM = _claudeStyleDefaults.FG_LNUM
	if (!_explicitFgFields.has("fgRule")) FG_RULE = _claudeStyleDefaults.FG_RULE
	if (!_explicitFgFields.has("fgStripe")) FG_STRIPE = _claudeStyleDefaults.FG_STRIPE
	if (!_explicitFgFields.has("fgSafeMuted")) FG_SAFE_MUTED = _claudeStyleDefaults.FG_SAFE_MUTED
	if (!_explicitFgFields.has("fgAdd")) FG_ADD = _claudeStyleDefaults.FG_ADD
	if (!_explicitFgFields.has("fgDel")) FG_DEL = _claudeStyleDefaults.FG_DEL
	DIVIDER = `${FG_RULE}│${D_RST}`
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM }
}

function applyThemePaletteIfNeeded(theme: any): void {
	if (!theme) return
	if (!themeAdaptiveEnabled()) return
	if (_themePaletteCacheTheme === theme) return // already applied for this theme instance
	_themePaletteCacheTheme = theme

	// Borders (top/bottom outlines, user-message frame, branch rule).
	const borderMuted = safeFgAnsi(theme, "borderMuted")
	if (borderMuted) BORDER_COLOR = borderMuted

	// "Worked for Ns" line + thinking-block italics share pi's `muted` color.
	const muted = safeFgAnsi(theme, "muted")
	if (muted) WORKED_LINE_FG = muted

	// Tool branch rule (├─ / └─ connectors). Use `dim` if present, else `muted`.
	const dim = safeFgAnsi(theme, "dim") ?? muted
	if (dim) TOOL_RULE = dim

	// Diff support text colors. These are user-overridable via diffColors.* so
	// we only touch the ones not explicitly set.
	if (!_explicitFgFields.has("fgDim") && muted) FG_DIM = muted
	if (!_explicitFgFields.has("fgLnum") && muted) FG_LNUM = muted
	if (!_explicitFgFields.has("fgRule") && borderMuted) FG_RULE = borderMuted
	if (!_explicitFgFields.has("fgStripe") && borderMuted) FG_STRIPE = borderMuted
	if (!_explicitFgFields.has("fgSafeMuted") && muted) FG_SAFE_MUTED = muted

	DIVIDER = `${FG_RULE}│${D_RST}`

	// Re-trigger background derivation against the new theme unless the user
	// set explicit bg overrides via diffTheme/diffColors.
	if (!hasExplicitBgConfig) {
		autoDeriveBgFromTheme(theme)
		autoDerivePending = false
	}
}

function applyDiffPalette(): void {
	const config = loadDiffConfig()
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null
	if (preset) hasExplicitBgConfig = true
	const overrides = config.diffColors ?? {}
	if (Object.keys(overrides).length > 0) hasExplicitBgConfig = true
	_explicitFgFields.clear()

	const applyBg = (key: string, presetValue: string | undefined, set: (value: string) => void) => {
		const hex = overrides[key] ?? presetValue
		if (!hex) return
		const ansi = hexToBgAnsi(hex)
		if (ansi) set(ansi)
	}
	const applyFg = (
		key: "fgAdd" | "fgDel" | "fgDim" | "fgLnum" | "fgRule" | "fgStripe" | "fgSafeMuted",
		presetValue: string | undefined,
		set: (value: string) => void,
	) => {
		const hex = overrides[key] ?? presetValue
		if (!hex) return
		const ansi = hexToFgAnsi(hex)
		if (!ansi) return
		set(ansi)
		_explicitFgFields.add(key)
	}

	applyBg("bgAdd", preset?.bgAdd, (v) => {
		BG_ADD = v
	})
	applyBg("bgDel", preset?.bgDel, (v) => {
		BG_DEL = v
	})
	applyBg("bgAddHighlight", preset?.bgAddHighlight, (v) => {
		BG_ADD_W = v
	})
	applyBg("bgDelHighlight", preset?.bgDelHighlight, (v) => {
		BG_DEL_W = v
	})
	applyBg("bgGutterAdd", preset?.bgGutterAdd, (v) => {
		BG_GUTTER_ADD = v
	})
	applyBg("bgGutterDel", preset?.bgGutterDel, (v) => {
		BG_GUTTER_DEL = v
	})
	applyBg("bgEmpty", preset?.bgEmpty, (v) => {
		BG_EMPTY = v
	})

	applyFg("fgAdd", preset?.fgAdd, (v) => {
		FG_ADD = v
	})
	applyFg("fgDel", preset?.fgDel, (v) => {
		FG_DEL = v
	})
	applyFg("fgDim", preset?.fgDim, (v) => {
		FG_DIM = v
	})
	applyFg("fgLnum", preset?.fgLnum, (v) => {
		FG_LNUM = v
	})
	applyFg("fgRule", preset?.fgRule, (v) => {
		FG_RULE = v
	})
	applyFg("fgStripe", preset?.fgStripe, (v) => {
		FG_STRIPE = v
	})
	applyFg("fgSafeMuted", preset?.fgSafeMuted, (v) => {
		FG_SAFE_MUTED = v
	})

	const shiki = overrides.shikiTheme ?? preset?.shikiTheme
	if (shiki) DIFF_THEME = shiki as BundledTheme

	DIVIDER = `${FG_RULE}│${D_RST}`
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM }
	// Only trigger auto-derive when the user did NOT supply an explicit
	// preset or per-color override; otherwise we would overwrite their config
	// with the hardcoded dark palette on first render.
	autoDerivePending = !hasExplicitBgConfig
}

function resolveDiffColors(theme?: any): DiffColors {
	applyThemePaletteIfNeeded(theme)
	if (autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme)
		autoDerivePending = false
	}
	return DEFAULT_DIFF_COLORS
}

interface DiffLine {
	type: "add" | "del" | "ctx" | "sep"
	oldNum: number | null
	newNum: number | null
	content: string
}

interface ParsedDiff {
	lines: DiffLine[]
	added: number
	removed: number
	chars: number
}

function diffStrip(value: string): string {
	return value.replace(ANSI_RE, "")
}

function tabs(text: string): string {
	return text.replace(/\t/g, "  ")
}

function termW(): number {
	const raw =
		process.stdout.columns ||
		(process.stderr as any).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		DEFAULT_TERM_WIDTH
	return Math.max(40, Math.min(raw - 4, MAX_TERM_WIDTH))
}

function branchDiffWidth(): number {
	return Math.max(40, termW() - 8)
}

function adaptiveWrapRows(tw?: number): number {
	const width = tw ?? termW()
	if (width >= 180) return MAX_WRAP_ROWS_WIDE
	if (width >= 120) return MAX_WRAP_ROWS_MED
	return MAX_WRAP_ROWS_NARROW
}

function fit(value: string, width: number): string {
	if (width <= 0) return ""
	const plain = diffStrip(value)
	if (plain.length <= width) return value + " ".repeat(width - plain.length)
	const showWidth = width > 2 ? width - 1 : width
	let vis = 0
	let i = 0
	while (i < value.length && vis < showWidth) {
		if (value[i] === "\x1b") {
			const end = value.indexOf("m", i)
			if (end !== -1) {
				i = end + 1
				continue
			}
		}
		vis++
		i++
	}
	return width > 2 ? `${value.slice(0, i)}${D_RST}${FG_DIM}›${D_RST}` : `${value.slice(0, i)}${D_RST}`
}

function ansiState(text: string): string {
	const matches = text.match(/\x1b\[[0-9;]*m/g) ?? []
	let fg = ""
	let bg = ""
	for (const seq of matches) {
		const params = seq.slice(2, -1)
		if (params === "0") {
			fg = ""
			bg = ""
		} else if (params === "39") {
			fg = ""
		} else if (params.startsWith("38;")) {
			fg = seq
		} else if (params.startsWith("48;")) {
			bg = seq
		}
	}
	return bg + fg
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
		if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return FG_SAFE_MUTED
		if (!params.startsWith("38;2;")) return seq
		const parts = params.split(";").map(Number)
		if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return seq
		const [, , r, g, b] = parts
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
		return luminance < 72 ? FG_SAFE_MUTED : seq
	})
}

function wrapAnsi(text: string, width: number, maxRows = adaptiveWrapRows(), fillBg = ""): string[] {
	if (width <= 0) return [""]
	const plain = diffStrip(text)
	if (plain.length <= width) {
		const pad = width - plain.length
		return pad > 0 ? [text + fillBg + " ".repeat(pad) + (fillBg ? D_RST : "")] : [text]
	}

	const rows: string[] = []
	let row = ""
	let vis = 0
	let i = 0
	let onLastRow = false
	let effectiveWidth = width

	while (i < text.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true
			effectiveWidth = width > 2 ? width - 1 : width
		}
		if (text[i] === "\x1b") {
			const end = text.indexOf("m", i)
			if (end !== -1) {
				row += text.slice(i, end + 1)
				i = end + 1
				continue
			}
		}
		if (vis >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false
				for (let j = i; j < text.length; j++) {
					if (text[j] === "\x1b") {
						const e2 = text.indexOf("m", j)
						if (e2 !== -1) {
							j = e2
							continue
						}
					}
					hasMore = true
					break
				}
				if (hasMore && width > 2) row += `${D_RST}${FG_DIM}›${D_RST}`
				else row += fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST
				rows.push(row)
				return rows
			}
			const state = ansiState(row)
			rows.push(row + D_RST)
			row = state + fillBg
			vis = 0
			if (rows.length >= maxRows - 1) {
				onLastRow = true
				effectiveWidth = width > 2 ? width - 1 : width
			}
		}
		row += text[i]
		vis++
		i++
	}

	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST)
	}
	return rows
}

function lnum(n: number | null, width: number, fg = FG_LNUM): string {
	if (n === null) return " ".repeat(width)
	const value = String(n)
	return `${fg}${" ".repeat(Math.max(0, width - value.length))}${value}${D_RST}`
}

function stripes(width: number): string {
	return BG_BASE + FG_STRIPE + "╱".repeat(width) + D_RST
}

function renderDiffStatBar(added: number, removed: number, width = termW()): string {
	const total = added + removed
	if (total === 0 || width < 20) return ""
	const slots = Math.max(8, Math.min(20, Math.floor(width / 14)))
	let addSlots = Math.max(0, Math.min(slots, Math.round((added / total) * slots)))
	if (added > 0 && addSlots === 0) addSlots = 1
	if (removed > 0 && addSlots >= slots) addSlots = slots - 1
	const removeSlots = Math.max(0, slots - addSlots)
	const addBar = addSlots > 0 ? `${FG_ADD}${"━".repeat(addSlots)}${D_RST}` : ""
	const removeBar = removeSlots > 0 ? `${FG_DEL}${"━".repeat(removeSlots)}${D_RST}` : ""
	return `${FG_DIM}[${D_RST}${addBar}${removeBar}${FG_DIM}]${D_RST}`
}

function summarizeDiff(added: number, removed: number): string {
	const parts: string[] = []
	if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`)
	if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`)
	if (!parts.length) return `${FG_DIM}no changes${D_RST}`
	const bar = renderDiffStatBar(added, removed)
	return bar ? `${parts.join(" ")} ${bar}` : parts.join(" ")
}

function diffSummaryWithMeta(added: number, removed: number, hunks: number, mode: string): string {
	const base = summarizeDiff(added, removed)
	const extras: string[] = []
	if (hunks > 0) extras.push(`${FG_DIM}${hunks} hunk${hunks === 1 ? "" : "s"}${D_RST}`)
	if (mode) extras.push(`${FG_DIM}${mode}${D_RST}`)
	return extras.length ? `${base} ${FG_DIM}•${D_RST} ${extras.join(` ${FG_DIM}•${D_RST} `)}` : base
}

function collapsedDiffHint(remainingLines: number, hiddenHunks: number): string {
	const width = termW()
	const candidates = [
		`… (${remainingLines} more diff lines${hiddenHunks > 0 ? ` • ${hiddenHunks} more hunks` : ""} • ctrl+o to expand)`,
		`… (${remainingLines} more lines${hiddenHunks > 0 ? ` • ${hiddenHunks} hunks` : ""})`,
		`… (+${remainingLines}${hiddenHunks > 0 ? ` • +${hiddenHunks}h` : ""})`,
		"…",
	]
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate
	}
	return truncateToWidth("…", width, "")
}

function diffRule(width: number): string {
	return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${D_RST}`
}

function shouldUseSplit(diff: ParsedDiff, tw: number, maxRows = MAX_PREVIEW_LINES): boolean {
	if (!diff.lines.length) return false
	if (tw < SPLIT_MIN_WIDTH) return false
	const nw = Math.max(2, String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length)
	const half = Math.floor((tw - 1) / 2)
	const gw = nw + 5
	const cw = Math.max(12, half - gw)
	if (cw < SPLIT_MIN_CODE_WIDTH) return false
	const vis = diff.lines.slice(0, maxRows)
	let contentLines = 0
	let wrapCandidates = 0
	for (const line of vis) {
		if (line.type === "sep") continue
		contentLines++
		if (tabs(line.content).length > cw) wrapCandidates++
	}
	if (contentLines === 0) return true
	const wrapRatio = wrapCandidates / contentLines
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false
	return true
}

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
}

function lang(filePath: string): BundledLanguage | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()]
}

async function codeToAnsiLazy(code: string, language: BundledLanguage, theme: BundledTheme): Promise<string> {
	if (!codeToAnsiLoader) {
		codeToAnsiLoader = import("@shikijs/cli").then((mod) => mod.codeToANSI)
	}
	const codeToAnsi = await codeToAnsiLoader
	return codeToAnsi(code, language, theme)
}

const hlCache = new Map<string, string[]>()

function clearHighlightCache(): void {
	hlCache.clear()
}

function touchCache(key: string, value: string[]): string[] {
	hlCache.delete(key)
	hlCache.set(key, value)
	while (hlCache.size > CACHE_LIMIT) {
		const first = hlCache.keys().next().value
		if (first === undefined) break
		hlCache.delete(first)
	}
	return value
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""]
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n")
	const key = `${DIFF_THEME}\0${language}\0${code}`
	const hit = hlCache.get(key)
	if (hit) return touchCache(key, hit)
	try {
		const ansi = normalizeShikiContrast(await codeToAnsiLazy(code, language, DIFF_THEME))
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n")
		return touchCache(key, out)
	} catch {
		return code.split("\n")
	}
}

function parseDiff(oldContent: string, newContent: string, ctxLines = 3): ParsedDiff {
	const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", { context: ctxLines })
	const lines: DiffLine[] = []
	let added = 0
	let removed = 0
	for (let hi = 0; hi < patch.hunks.length; hi++) {
		if (hi > 0) {
			const prev = patch.hunks[hi - 1]
			const gap = patch.hunks[hi].oldStart - (prev.oldStart + prev.oldLines)
			lines.push({ type: "sep", oldNum: null, newNum: gap > 0 ? gap : null, content: "" })
		}
		const hunk = patch.hunks[hi]
		let oldLine = hunk.oldStart
		let newLine = hunk.newStart
		for (const raw of hunk.lines) {
			if (raw === "\\ No newline at end of file") continue
			const ch = raw[0]
			const text = raw.slice(1)
			if (ch === "+") {
				lines.push({ type: "add", oldNum: null, newNum: newLine++, content: text })
				added++
			} else if (ch === "-") {
				lines.push({ type: "del", oldNum: oldLine++, newNum: null, content: text })
				removed++
			} else {
				lines.push({ type: "ctx", oldNum: oldLine++, newNum: newLine++, content: text })
			}
		}
	}
	return { lines, added, removed, chars: oldContent.length + newContent.length }
}

function getCachedParsedDiff(ctx: any, key: string, oldContent: string, newContent: string): ParsedDiff {
	if (ctx.state?._parsedDiffKey === key && ctx.state._parsedDiff) {
		return ctx.state._parsedDiff as ParsedDiff
	}
	const diff = parseDiff(oldContent, newContent)
	if (ctx.state) {
		ctx.state._parsedDiffKey = key
		ctx.state._parsedDiff = diff
	}
	return diff
}

function wordDiffAnalysis(
	oldText: string,
	newText: string,
): { similarity: number; oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
	if (!oldText && !newText) return { similarity: 1, oldRanges: [], newRanges: [] }
	const parts = Diff.diffWords(oldText, newText)
	const oldRanges: Array<[number, number]> = []
	const newRanges: Array<[number, number]> = []
	let oldPos = 0
	let newPos = 0
	let same = 0
	for (const part of parts) {
		if (part.removed) {
			oldRanges.push([oldPos, oldPos + part.value.length])
			oldPos += part.value.length
		} else if (part.added) {
			newRanges.push([newPos, newPos + part.value.length])
			newPos += part.value.length
		} else {
			const len = part.value.length
			same += len
			oldPos += len
			newPos += len
		}
	}
	const maxLen = Math.max(oldText.length, newText.length)
	return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges }
}

function injectBg(ansiLine: string, ranges: Array<[number, number]>, baseBg: string, hlBg: string): string {
	if (!ranges.length) return baseBg + ansiLine + D_RST
	let out = baseBg
	let vis = 0
	let inHL = false
	let rangeIndex = 0
	let i = 0
	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const end = ansiLine.indexOf("m", i)
			if (end !== -1) {
				const seq = ansiLine.slice(i, end + 1)
				out += seq
				if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg
				i = end + 1
				continue
			}
		}
		while (rangeIndex < ranges.length && vis >= ranges[rangeIndex][1]) rangeIndex++
		const want = rangeIndex < ranges.length && vis >= ranges[rangeIndex][0] && vis < ranges[rangeIndex][1]
		if (want !== inHL) {
			inHL = want
			out += inHL ? hlBg : baseBg
		}
		out += ansiLine[i]
		vis++
		i++
	}
	return out + D_RST
}

function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText)
	let oldOut = ""
	let newOut = ""
	for (const part of parts) {
		if (part.removed) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`
		else if (part.added) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`
		else {
			oldOut += part.value
			newOut += part.value
		}
	}
	return { old: oldOut, new: newOut }
}

async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_RENDER_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): Promise<string> {
	if (!diff.lines.length) return ""
	const vis = diff.lines.slice(0, max)
	const tw = width
	const nw = Math.max(2, String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length)
	const gw = nw + 5
	const cw = Math.max(20, tw - gw)
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES

	const oldSrc: string[] = []
	const newSrc: string[] = []
	for (const line of vis) {
		if (line.type === "ctx" || line.type === "del") oldSrc.push(line.content)
		if (line.type === "ctx" || line.type === "add") newSrc.push(line.content)
	}
	const [oldHL, newHL] = canHL
		? await Promise.all([hlBlock(oldSrc.join("\n"), language), hlBlock(newSrc.join("\n"), language)])
		: [oldSrc, newSrc]

	let oldIndex = 0
	let newIndex = 0
	let index = 0
	const out: string[] = [diffRule(tw)]

	function emitRow(
		num: number | null,
		sign: string,
		gutterBg: string,
		signFg: string,
		body: string,
		bodyBg = "",
	): void {
		const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : ""
		const border = borderFg ? `${borderFg}▌${D_RST}` : `${BG_BASE} `
		const numFg = borderFg || FG_LNUM
		const gutter = `${border}${gutterBg}${lnum(num, nw, numFg)}${signFg}${sign}${D_RST} ${DIVIDER} `
		const cont = `${border}${gutterBg}${" ".repeat(nw + 1)}${D_RST} ${DIVIDER} `
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), bodyBg)
		out.push(`${gutter}${rows[0]}${D_RST}`)
		for (let r = 1; r < rows.length; r++) out.push(`${cont}${rows[r]}${D_RST}`)
	}

	while (index < vis.length) {
		const line = vis[index]
		if (line.type === "sep") {
			const gap = line.newNum
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : "···"
			const totalW = Math.min(tw, 72)
			const pad = Math.max(0, totalW - label.length - 2)
			const half1 = Math.floor(pad / 2)
			const half2 = pad - half1
			out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half1)}${label}${"─".repeat(half2)}${D_RST}`)
			index++
			continue
		}
		if (line.type === "ctx") {
			const hl = oldHL[oldIndex] ?? line.content
			emitRow(line.newNum, " ", BG_BASE, dc.fgCtx, `${BG_BASE}${D_DIM}${hl}`, BG_BASE)
			oldIndex++
			newIndex++
			index++
			continue
		}

		const dels: Array<{ l: DiffLine; hl: string }> = []
		while (index < vis.length && vis[index].type === "del") {
			dels.push({ l: vis[index], hl: oldHL[oldIndex] ?? vis[index].content })
			oldIndex++
			index++
		}
		const adds: Array<{ l: DiffLine; hl: string }> = []
		while (index < vis.length && vis[index].type === "add") {
			adds.push({ l: vis[index], hl: newHL[newIndex] ?? vis[index].content })
			newIndex++
			index++
		}

		const isPaired = dels.length === 1 && adds.length === 1
		const wd = isPaired ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			emitRow(
				dels[0].l.oldNum,
				"-",
				BG_GUTTER_DEL,
				`${dc.fgDel}${D_BOLD}`,
				injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W),
				BG_DEL,
			)
			emitRow(
				adds[0].l.newNum,
				"+",
				BG_GUTTER_ADD,
				`${dc.fgAdd}${D_BOLD}`,
				injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W),
				BG_ADD,
			)
			continue
		}
		if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content)
			emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, `${dc.fgDel}${D_BOLD}`, `${BG_DEL}${pwd.old}`, BG_DEL)
			emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, `${dc.fgAdd}${D_BOLD}`, `${BG_ADD}${pwd.new}`, BG_ADD)
			continue
		}
		for (const d of dels)
			emitRow(d.l.oldNum, "-", BG_GUTTER_DEL, `${dc.fgDel}${D_BOLD}`, `${BG_DEL}${canHL ? d.hl : d.l.content}`, BG_DEL)
		for (const a of adds)
			emitRow(a.l.newNum, "+", BG_GUTTER_ADD, `${dc.fgAdd}${D_BOLD}`, `${BG_ADD}${canHL ? a.hl : a.l.content}`, BG_ADD)
	}

	out.push(diffRule(tw))
	if (diff.lines.length > vis.length)
		out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(diff.lines.length - vis.length, 0)}${D_RST}`)
	return out.join("\n")
}

async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_PREVIEW_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
	width = termW(),
): Promise<string> {
	const tw = width
	if (!shouldUseSplit(diff, tw, max)) return renderUnified(diff, language, max, dc, width)
	if (!diff.lines.length) return ""

	type Row = { left: DiffLine | null; right: DiffLine | null }
	const rows: Row[] = []
	let i = 0
	while (i < diff.lines.length) {
		const line = diff.lines[i]
		if (line.type === "sep" || line.type === "ctx") {
			rows.push({ left: line, right: line })
			i++
			continue
		}
		const dels: DiffLine[] = []
		const adds: DiffLine[] = []
		while (i < diff.lines.length && diff.lines[i].type === "del") dels.push(diff.lines[i++])
		while (i < diff.lines.length && diff.lines[i].type === "add") adds.push(diff.lines[i++])
		const n = Math.max(dels.length, adds.length)
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null })
	}

	const vis = rows.slice(0, max)
	const half = Math.floor((tw - 1) / 2)
	const nw = Math.max(2, String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length)
	const gw = nw + 5
	const cw = Math.max(12, half - gw)
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= MAX_RENDER_LINES * 2

	const leftSrc: string[] = []
	const rightSrc: string[] = []
	for (const row of vis) {
		if (row.left && row.left.type !== "sep") leftSrc.push(row.left.content)
		if (row.right && row.right.type !== "sep") rightSrc.push(row.right.content)
	}
	const [leftHL, rightHL] = canHL
		? await Promise.all([hlBlock(leftSrc.join("\n"), language), hlBlock(rightSrc.join("\n"), language)])
		: [leftSrc, rightSrc]

	let leftIndex = 0
	let rightIndex = 0

	type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] }
	function halfBuild(
		line: DiffLine | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gPat = FG_STRIPE + "╱".repeat(nw + 2) + D_RST
			const gutter = ` ${gPat}${FG_RULE}│${D_RST} `
			return { gutter, contGutter: gutter, bodyRows: [stripes(cw)] }
		}
		if (line.type === "sep") {
			const gap = line.newNum
			const label = gap && gap > 0 ? `··· ${gap} lines ···` : "···"
			const gutter = `${BG_BASE} ${FG_DIM}${fit("", nw + 2)}${D_RST}${FG_RULE}│${D_RST} `
			return { gutter, contGutter: gutter, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${D_RST}`] }
		}
		const isDel = line.type === "del"
		const isAdd = line.type === "add"
		const gBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE
		const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE
		const sFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : dc.fgCtx
		const sign = isDel ? "-" : isAdd ? "+" : " "
		const num = isDel ? line.oldNum : isAdd ? line.newNum : side === "left" ? line.oldNum : line.newNum
		const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : ""
		const border = borderFg ? `${borderFg}▌${D_RST}` : ` ${BG_BASE}`
		const numFg = borderFg || FG_LNUM
		let body: string
		if (ranges && ranges.length > 0) body = injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W)
		else if (isDel || isAdd) body = `${cBg}${hl}`
		else body = `${BG_BASE}${D_DIM}${hl}`
		const gutter = `${border}${gBg}${lnum(num, nw, numFg)}${sFg}${D_BOLD}${sign}${D_RST} ${FG_RULE}│${D_RST} `
		const contGutter = `${border}${gBg}${" ".repeat(nw + 1)}${D_RST} ${FG_RULE}│${D_RST} `
		return { gutter, contGutter, bodyRows: wrapAnsi(tabs(body), cw, adaptiveWrapRows(), cBg) }
	}

	const out: string[] = []
	const hdrOld = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgDel}${D_DIM}old${D_RST}`
	const hdrNew = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgAdd}${D_DIM}new${D_RST}`
	out.push(`${BG_BASE}${hdrOld}${" ".repeat(Math.max(0, half - nw - 1))}${FG_RULE}┊${D_RST}${hdrNew}`)
	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`)

	for (const row of vis) {
		const leftLine = row.left
		const rightLine = row.right
		const paired = Boolean(leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add")
		const wd = paired && leftLine && rightLine ? wordDiffAnalysis(leftLine.content, rightLine.content) : null
		let leftResult: HalfResult
		let rightResult: HalfResult
		if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			leftResult = halfBuild(leftLine, leftHL[leftIndex++] ?? leftLine.content, wd.oldRanges, "left")
			rightResult = halfBuild(rightLine, rightHL[rightIndex++] ?? rightLine.content, wd.newRanges, "right")
		} else if (paired && wd && leftLine && rightLine && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(leftLine.content, rightLine.content)
			leftIndex++
			rightIndex++
			leftResult = halfBuild(leftLine, pwd.old, null, "left")
			rightResult = halfBuild(rightLine, pwd.new, null, "right")
		} else {
			leftResult = halfBuild(
				row.left,
				row.left && row.left.type !== "sep" ? (leftHL[leftIndex++] ?? row.left.content) : "",
				null,
				"left",
			)
			rightResult = halfBuild(
				row.right,
				row.right && row.right.type !== "sep" ? (rightHL[rightIndex++] ?? row.right.content) : "",
				null,
				"right",
			)
		}
		const maxRows = Math.max(leftResult.bodyRows.length, rightResult.bodyRows.length)
		for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
			const lg = rowIndex === 0 ? leftResult.gutter : leftResult.contGutter
			const rg = rowIndex === 0 ? rightResult.gutter : rightResult.contGutter
			const lb = leftResult.bodyRows[rowIndex] ?? (!row.left ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`)
			const rb = rightResult.bodyRows[rowIndex] ?? (!row.right ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`)
			out.push(`${lg}${lb}${DIVIDER}${rg}${rb}`)
		}
	}

	out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`)
	if (rows.length > vis.length)
		out.push(`${BG_BASE}${FG_DIM}  ${collapsedDiffHint(rows.length - vis.length, 0)}${D_RST}`)
	return out.join("\n")
}

function getEditOperations(input: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit: any) => ({
				oldText:
					typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText:
					typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit: { oldText: string; newText: string }) => edit.oldText && edit.oldText !== edit.newText)
	}
	const oldText =
		typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : ""
	const newText =
		typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : ""
	return oldText && oldText !== newText ? [{ oldText, newText }] : []
}

function summarizeEditOperations(operations: Array<{ oldText: string; newText: string }>) {
	const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText))
	const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0)
	const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0)
	const totalLines = diffs.reduce((sum, diff) => sum + diff.lines.length, 0)
	const totalHunks = diffs.reduce(
		(sum, diff) => sum + diff.lines.filter((l) => l.type === "sep").length + (diff.lines.length ? 1 : 0),
		0,
	)
	return { diffs, totalAdded, totalRemoved, totalLines, totalHunks, summary: summarizeDiff(totalAdded, totalRemoved) }
}

type EditOperationSummary = ReturnType<typeof summarizeEditOperations>

function getCachedEditOperationSummary(
	ctx: any,
	key: string,
	operations: Array<{ oldText: string; newText: string }>,
): EditOperationSummary {
	if (ctx.state?._editSummaryKey === key && ctx.state._editSummary) {
		return ctx.state._editSummary as EditOperationSummary
	}
	const summary = summarizeEditOperations(operations)
	if (ctx.state) {
		ctx.state._editSummaryKey = key
		ctx.state._editSummary = summary
	}
	return summary
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function stripBomText(text: string): string {
	return text.startsWith("\uFEFF") ? text.slice(1) : text
}

function normalizeTextForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
}

function findEditMatch(
	content: string,
	oldText: string,
): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
	const exactIndex = content.indexOf(oldText)
	if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false }
	const fuzzyContent = normalizeTextForFuzzyMatch(content)
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText)
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
	return fuzzyIndex === -1
		? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false }
		: { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true }
}

function countFuzzyOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeTextForFuzzyMatch(content)
	const fuzzyOldText = normalizeTextForFuzzyMatch(oldText)
	return fuzzyContent.split(fuzzyOldText).length - 1
}

function lineNumberAtIndex(text: string, index: number): number {
	return text.slice(0, Math.max(0, index)).split("\n").length
}

function countLineBreaks(text: string): number {
	return (text.match(/\n/g) ?? []).length
}

function offsetParsedDiff(diff: ParsedDiff, oldOffset: number, newOffset = oldOffset): ParsedDiff {
	return {
		...diff,
		lines: diff.lines.map((line) =>
			line.type === "sep"
				? line
				: {
						...line,
						oldNum: line.oldNum === null ? null : line.oldNum + oldOffset,
						newNum: line.newNum === null ? null : line.newNum + newOffset,
					},
		),
	}
}

function getFirstChangedNewLine(diff: ParsedDiff): number {
	let currentNewLine = 0
	for (let i = 0; i < diff.lines.length; i++) {
		const line = diff.lines[i]
		if (line.type === "sep") {
			currentNewLine = 0
			continue
		}
		if (line.type === "ctx") {
			currentNewLine = (line.newNum ?? currentNewLine) + 1
			continue
		}
		if (line.type === "add") return line.newNum ?? currentNewLine
		if (currentNewLine > 0) return currentNewLine
		const next = diff.lines.slice(i + 1).find((entry) => entry.type !== "sep" && entry.newNum !== null)
		if (next && next.newNum !== null) return next.newNum
		return line.oldNum ?? 0
	}
	return 0
}

interface LocalizedEditDiff {
	diff: ParsedDiff
	line: number
}

async function computeLocalizedEditDiffs(
	filePath: string,
	operations: Array<{ oldText: string; newText: string }>,
	cwd: string,
): Promise<LocalizedEditDiff[] | null> {
	if (!filePath || operations.length === 0) return null
	try {
		const rawContent = await readFileAsync(resolve(cwd, filePath), "utf8")
		const normalizedContent = normalizeToLf(stripBomText(rawContent))
		const normalizedOps = operations.map((edit) => ({
			oldText: normalizeToLf(edit.oldText),
			newText: normalizeToLf(edit.newText),
		}))
		const baseContent = normalizedOps.some((edit) => findEditMatch(normalizedContent, edit.oldText).usedFuzzyMatch)
			? normalizeTextForFuzzyMatch(normalizedContent)
			: normalizedContent
		const matches = normalizedOps.map((edit, editIndex) => {
			const match = findEditMatch(baseContent, edit.oldText)
			if (!match.found || countFuzzyOccurrences(baseContent, edit.oldText) !== 1) return null
			return { editIndex, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText }
		})
		if (matches.some((match) => match === null)) return null
		const ordered = [
			...(matches as Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }>),
		].sort((a, b) => a.matchIndex - b.matchIndex)
		for (let i = 1; i < ordered.length; i++) {
			const prev = ordered[i - 1]
			const current = ordered[i]
			if (prev.matchIndex + prev.matchLength > current.matchIndex) return null
		}
		const localized: Array<LocalizedEditDiff | null> = Array(operations.length).fill(null)
		let lineDelta = 0
		for (const match of ordered) {
			const oldChunk = baseContent.slice(match.matchIndex, match.matchIndex + match.matchLength)
			const oldStartLine = lineNumberAtIndex(baseContent, match.matchIndex)
			const newStartLine = oldStartLine + lineDelta
			const diff = offsetParsedDiff(parseDiff(oldChunk, match.newText), oldStartLine - 1, newStartLine - 1)
			localized[match.editIndex] = { diff, line: getFirstChangedNewLine(diff) }
			lineDelta += countLineBreaks(match.newText) - countLineBreaks(oldChunk)
		}
		return localized.every(Boolean) ? (localized as LocalizedEditDiff[]) : null
	} catch {
		return null
	}
}

function renderEditPreviewBody(
	ctx: any,
	key: string,
	theme: Theme,
	language: BundledLanguage | undefined,
	operations: Array<{ oldText: string; newText: string }>,
	diffs: ParsedDiff[],
	lines: number[],
	summary: string,
): void {
	const dc = resolveDiffColors(theme)
	const branchWidth = branchDiffWidth()
	if (operations.length === 1) {
		const [diff] = diffs
		const line = lines[0] ?? getFirstChangedNewLine(diff)
		renderSplit(diff, language, ctx.expanded ? MAX_PREVIEW_LINES : 32, dc, branchWidth)
			.then((rendered) => {
				if (ctx.state._pk !== key) return
				ctx.state._ptBody = `${summarizeDiff(diff.added, diff.removed)}${formatLineMeta(line, theme)}\n${rendered}`
				ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true))
				ctx.invalidate()
			})
			.catch(() => {
				if (ctx.state._pk !== key) return
				ctx.state._ptBody = `${summarizeDiff(diff.added, diff.removed)}${formatLineMeta(line, theme)}`
				ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true))
				ctx.invalidate()
			})
		return
	}
	const maxShown = ctx.expanded ? operations.length : Math.min(operations.length, 3)
	const previewLines = ctx.expanded
		? Math.max(6, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown)))
		: Math.max(8, Math.floor(MAX_PREVIEW_LINES / Math.max(1, maxShown)))
	void Promise.all(
		diffs.slice(0, maxShown).map((diff, index) => {
			const line = lines[index] ?? getFirstChangedNewLine(diff)
			return renderSplit(diff, language, previewLines, dc, branchWidth)
				.then((rendered) => `Edit ${index + 1}/${operations.length}${formatLineMeta(line, theme)}\n${rendered}`)
				.catch(
					() =>
						`Edit ${index + 1}/${operations.length}${formatLineMeta(line, theme)} ${summarizeDiff(diff.added, diff.removed)}`,
				)
		}),
	)
		.then((sections) => {
			if (ctx.state._pk !== key) return
			const remainder = operations.length - maxShown
			const suffix =
				remainder > 0
					? `\n${theme.fg("muted", `… ${remainder} more edit blocks${ctx.expanded ? "" : " • ctrl+o to expand"}`)}`
					: ""
			ctx.state._ptBody = `${operations.length} edits ${summary}\n\n${sections.join("\n\n")}${suffix}`
			ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true))
			ctx.invalidate()
		})
		.catch(() => {
			if (ctx.state._pk !== key) return
			ctx.state._ptBody = `${operations.length} edits ${summary}`
			ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true))
			ctx.invalidate()
		})
}

function stripThinkingPresentationArtifacts(text: string): string {
	if (!ANSI_PRESENT_RE.test(text) && !/^\s*thinking:\s*/i.test(text)) return text
	let current = ANSI_PRESENT_RE.test(text) ? text.replace(ANSI_RE, "") : text
	while (true) {
		const next = current.replace(/^(?:thinking:\s*)+/i, "").trimStart()
		if (next === current) return current
		current = next
	}
}

function prefixThinkingLine(text: string, _theme: Theme | undefined): string {
	if (!ANSI_PRESENT_RE.test(text) && text.startsWith("Thinking: ") && !/^Thinking:\s*thinking:\s*/i.test(text)) {
		return text
	}
	const normalized = stripThinkingPresentationArtifacts(text).trim()
	if (!normalized) return text
	// Plain text — no ANSI colors, no theme. The ThinkingParagraph handles styling.
	return `Thinking: ${normalized}`
}

function registerThinkingLabels(pi: ExtensionAPI): void {
	const patchMessage = (event: any, theme?: Theme) => {
		// Keep theme-derived border / dim text colors in sync with the
		// active pi theme. Cheap when the theme hasn't changed (identity check).
		if (theme) applyThemePaletteIfNeeded(theme)
		const message = event?.message
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return
		for (const block of message.content) {
			if (block && block.type === "thinking" && typeof block.thinking === "string") {
				block.thinking = prefixThinkingLine(block.thinking, theme)
			}
		}
	}
	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages can be
		// injected while the agent is already active; those must not reset the
		// request timer.
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now()
		}
		currentAssistantMessageStartMs = undefined
	})
	pi.on("agent_start", async () => {
		if (currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now()
		}
		currentAssistantMessageStartMs = undefined
	})
	pi.on("message_start", async (event: any) => {
		const message = event?.message
		if (message?.role === "user" && currentAgentWorkStartMs === undefined) {
			currentAgentWorkStartMs = Date.now()
		}
		if (message?.role === "assistant") {
			currentAssistantMessageStartMs = Date.now()
			;(message as any)[WORKED_START_KEY] = currentAssistantMessageStartMs
		}
	})
	pi.on("message_update", async (event, ctx) => patchMessage(event, ctx.ui?.theme))
	pi.on("message_end", async (event, ctx) => {
		const message = (event as any)?.message
		if (message?.role === "assistant") {
			const started =
				typeof currentAgentWorkStartMs === "number"
					? currentAgentWorkStartMs
					: typeof (message as any)[WORKED_START_KEY] === "number"
						? (message as any)[WORKED_START_KEY]
						: currentAssistantMessageStartMs
			const isFinalAssistantMessage = message.stopReason !== "toolUse"
			if (started !== undefined && isFinalAssistantMessage) {
				const durationMs = Date.now() - started
				// Store duration as metadata on the message object. The patched
				// AssistantMessageComponent.render() reads it and appends the widget
				// line outside of the message content blocks — never injected into
				// the text that gets sent to the model.
				;(message as any)[WORKED_DURATION_KEY] = durationMs
				// Persist the duration as a sidecar entry in the JSONL session file
				// (type: "custom", does not participate in LLM context).
				pi.appendEntry("turn_duration", { durationMs })
			}
			currentAssistantMessageStartMs = undefined
		}
		patchMessage(event, ctx.ui?.theme)
	})
	pi.on("agent_end", async () => {
		currentAgentWorkStartMs = undefined
		currentAssistantMessageStartMs = undefined
	})
	pi.on("context", async (event) => {
		if (!Array.isArray((event as any).messages)) return
		for (const msg of (event as any).messages) {
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
			for (const block of msg.content) {
				if (block && block.type === "thinking" && typeof block.thinking === "string") {
					block.thinking = stripThinkingPresentationArtifacts(block.thinking)
				}
					// Legacy sessions written before this change may have the duration
				// text injected directly into content blocks. Strip it so it doesn't
				// appear twice alongside the widget.
				if (block && block.type === "text" && typeof block.text === "string") {
					const marker = "Worked for"
					if (block.text.includes(marker)) {
						block.text = block.text
							.split(/\r?\n/)
							.filter((l: string) => !(l.includes(marker) && /^✻ Worked for [^\r\n]+$/.test(l.replace(/\x1b\[[0-9;]*m/g, "").trim())))
							.join("\n")
							.replace(/\n{3,}/g, "\n\n")
					}
				}
			}
		}
	})
}

function getMode<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const CORE_TOOL_OVERRIDES = new Set(["read", "bash", "grep", "find", "ls", "write", "edit", "set_phase"])

const OPENAI_STYLE_TOOL_NAMES = new Set([
	"apply_patch",
	"webfetch",
	"question",
	"questionnaire",
	"context_tag",
	"context_log",
	"context_checkout",
	"annotate",
	"web_search",
	"code_search",
	"fetch_content",
	"get_search_content",
	"alpha_search",
	"alpha_get_paper",
	"alpha_ask_paper",
	"alpha_annotate_paper",
	"alpha_list_annotations",
	"alpha_read_code",
	"Skill",
	"EnterPlanMode",
	"ExitPlanMode",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
])

function isMcpToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined
	const name = typeof rec?.name === "string" ? rec.name : ""
	const description = typeof rec?.description === "string" ? rec.description : ""
	return name === "mcp" || /\bmcp\b/i.test(description)
}

function isOpenAiToolCandidate(tool: unknown): boolean {
	const rec = tool as Record<string, unknown> | undefined
	const name = typeof rec?.name === "string" ? rec.name : ""
	if (!name || CORE_TOOL_OVERRIDES.has(name) || isMcpToolCandidate(tool)) return false
	return OPENAI_STYLE_TOOL_NAMES.has(name)
}

function humanizeToolName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase())
}

export function isMcpToolName(name: string): boolean {
	return name === "mcp" || /^mcp[_:-]/i.test(name) || /[_:-]mcp[_:-]/i.test(name)
}

function shouldUseGenericToolRenderer(name: unknown): boolean {
	return typeof name === "string" && name.length > 0 && !CORE_TOOL_OVERRIDES.has(name)
}

function genericToolLabel(name: string): string {
	return isMcpToolName(name) ? "MCP" : humanizeToolName(name)
}

function renderGenericToolCall(name: string, args: any, theme: Theme, ctx: any): Text {
	ctx.state._openAiPatchFiles = []
	const sp = (path: string) => shortPath(ctx.cwd ?? process.cwd(), path)
	if (isMcpToolName(name)) {
		// For MCP calls the summary may already contain ANSI color codes (muted
		// for the args suffix) so we build the header line directly instead of
		// passing it through toolHeader() which would re-wrap everything in accent.
		// The cache key includes expanded state so ctrl+o triggers a full re-render.
		const expanded = !!ctx.expanded
		const cacheKey = `_mcpLabelSummary:${expanded ? 1 : 0}`
		const packed = stableCallSummary(ctx, cacheKey, () => {
			const ls = mcpCallLabelAndSummary(args, theme, expanded)
			return `${ls.label}\x00${ls.summary}`
		})
		const sepIdx = packed.indexOf("\x00")
		const mcpLabel = sepIdx >= 0 ? packed.slice(0, sepIdx) : "MCP"
		const mcpSummary = sepIdx >= 0 ? packed.slice(sepIdx + 1) : ""
		const dot = toolStatusDot(ctx, theme)
		const labelPart = theme.fg("toolTitle", theme.bold(mcpLabel))
		const header = mcpSummary ? `${dot}${labelPart} ${WRAP_MARK}${mcpSummary}` : `${dot}${labelPart}`
		return makeText(ctx.lastComponent, header)
	}
	const summary = stableCallSummary(ctx, "_callSummary", () => summarizeGenericToolCall(name, args, theme, sp))
	const timer = formatToolTimer(getToolElapsedMs(ctx))
	return makeText(ctx.lastComponent, toolHeader(genericToolLabel(name), summary, theme, toolStatusDot(ctx, theme), timer))
}

function renderGenericToolResult(name: string, result: any, options: any, theme: Theme, ctx: any): Text {
	if (isMcpToolName(name)) {
		return renderMcpToolResult(result, !!options?.expanded, !!options?.isPartial, theme, ctx)
	}
	return renderOpenAiToolResult(
		name,
		{ content: result.content, details: result.details },
		!!options?.expanded,
		!!options?.isPartial,
		theme,
		ctx,
	)
}

function getTextContent(result: any): string {
	if (!Array.isArray(result?.content)) return ""
	return result.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n")
}

function getStringArg(args: any, ...keys: string[]): string {
	for (const key of keys) {
		const value = args?.[key]
		if (typeof value === "string" && value.trim()) return value.trim()
	}
	return ""
}

function getStringArrayArg(args: any, ...keys: string[]): string[] {
	for (const key of keys) {
		const value = args?.[key]
		if (!Array.isArray(value)) continue
		const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		if (items.length > 0) return items
	}
	return []
}

function extractApplyPatchFiles(patchText: string): string[] {
	if (!patchText) return []
	const files = new Set<string>()
	for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
		const filePath = match[1]?.trim()
		if (filePath) files.add(filePath)
	}
	return [...files]
}

interface ApplyPatchChangePreview {
	kind: "add" | "update" | "delete"
	path: string
	displayPath: string
	moveTo?: string
	diff: ParsedDiff
	language: BundledLanguage | undefined
	hunks: number
	summary: string
	line: number
}

interface ApplyPatchPreview {
	changes: ApplyPatchChangePreview[]
	totalAdded: number
	totalRemoved: number
	totalHunks: number
	totalLines: number
	summary: string
}

interface ApplyPatchResultMeta {
	changeCount: number
	totalAdded: number
	totalRemoved: number
	totalHunks: number
	totalLines: number
	firstChange?: {
		displayPath: string
		kind: ApplyPatchChangePreview["kind"]
		hunks: number
		line: number
		added: number
		removed: number
	}
}

function buildApplyPatchResultMeta(preview: ApplyPatchPreview): ApplyPatchResultMeta {
	const firstChange = preview.changes[0]
	return {
		changeCount: preview.changes.length,
		totalAdded: preview.totalAdded,
		totalRemoved: preview.totalRemoved,
		totalHunks: preview.totalHunks,
		totalLines: preview.totalLines,
		firstChange: firstChange
			? {
					displayPath: firstChange.displayPath,
					kind: firstChange.kind,
					hunks: firstChange.hunks,
					line: firstChange.line,
					added: firstChange.diff.added,
					removed: firstChange.diff.removed,
				}
			: undefined,
	}
}

function countDiffHunks(diff: ParsedDiff): number {
	return diff.lines.length === 0 ? 0 : diff.lines.filter((line) => line.type === "sep").length + 1
}

function getApplyPatchLine(diff: ParsedDiff, kind: ApplyPatchChangePreview["kind"]): number {
	if (kind === "add") {
		return diff.lines.find((line) => line.type === "add" && line.newNum !== null)?.newNum ?? 1
	}
	if (kind === "delete") {
		return diff.lines.find((line) => line.type === "del" && line.oldNum !== null)?.oldNum ?? 1
	}
	for (const line of diff.lines) {
		if (line.type === "add" && line.newNum !== null) return line.newNum
		if (line.type === "del" && line.oldNum !== null) return line.oldNum
	}
	return 0
}

function parsePatchBodyLine(rawLine: string): { marker: "+" | "-" | " "; content: string } {
	const marker = rawLine[0]
	if (marker === "+" || marker === "-" || marker === " ") return { marker, content: rawLine.slice(1) }
	return { marker: " ", content: rawLine }
}

function findLineSequence(haystack: string[], needle: string[], fromIndex = 0): number {
	if (needle.length === 0) return Math.max(0, fromIndex)
	outer: for (let i = Math.max(0, fromIndex); i <= haystack.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer
		}
		return i
	}
	return -1
}

function inferApplyPatchHunkStarts(
	lines: string[],
	sourceContent: string,
): Array<{ oldStart: number | null; newStart: number | null }> {
	const sourceLines = normalizeToLf(sourceContent).split("\n")
	const hunks: string[][] = []
	let currentHunk: string[] | null = null
	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue
		if (rawLine.startsWith("@@")) {
			if (currentHunk) hunks.push(currentHunk)
			currentHunk = []
			continue
		}
		if (!currentHunk) currentHunk = []
		currentHunk.push(rawLine)
	}
	if (currentHunk) hunks.push(currentHunk)

	const starts: Array<{ oldStart: number | null; newStart: number | null }> = []
	let searchFrom = 0
	let lineDelta = 0
	for (const hunk of hunks) {
		const oldLines = hunk
			.map((rawLine) => parsePatchBodyLine(rawLine))
			.filter((line) => line.marker !== "+")
			.map((line) => line.content)
		let matchIndex = findLineSequence(sourceLines, oldLines, searchFrom)
		if (matchIndex === -1) matchIndex = findLineSequence(sourceLines, oldLines, 0)
		const oldStart = matchIndex === -1 ? null : matchIndex + 1
		const newStart = oldStart === null ? null : oldStart + lineDelta
		starts.push({ oldStart, newStart })
		if (matchIndex === -1) continue
		searchFrom = matchIndex + oldLines.length
		const added = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "+").length
		const removed = hunk.filter((rawLine) => parsePatchBodyLine(rawLine).marker === "-").length
		lineDelta += added - removed
	}
	return starts
}

function stripPatchLinePrefix(line: string, prefix: "+" | "-"): string {
	return line.startsWith(prefix) ? line.slice(1) : line
}

function trimDiffSeparators(lines: DiffLine[]): DiffLine[] {
	const trimmed = [...lines]
	while (trimmed[0]?.type === "sep") trimmed.shift()
	while (trimmed[trimmed.length - 1]?.type === "sep") trimmed.pop()
	return trimmed
}

function parseApplyPatchUpdateDiff(lines: string[], sourceContent?: string): ParsedDiff {
	const diffLines: DiffLine[] = []
	let added = 0
	let removed = 0
	let chars = 0
	let oldLine: number | null = null
	let newLine: number | null = null
	let inHunk = false
	const inferredStarts = sourceContent ? inferApplyPatchHunkStarts(lines, sourceContent) : []
	let hunkIndex = 0

	for (const rawLine of lines) {
		if (rawLine.startsWith("*** Move to: ")) continue
		if (rawLine.startsWith("@@")) {
			if (diffLines.length > 0 && diffLines[diffLines.length - 1]?.type !== "sep") {
				diffLines.push({ type: "sep", oldNum: null, newNum: null, content: "" })
			}
			const match = rawLine.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/)
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null }
			oldLine = match ? Number.parseInt(match[1], 10) : inferred.oldStart
			newLine = match ? Number.parseInt(match[2], 10) : inferred.newStart
			hunkIndex++
			inHunk = true
			continue
		}
		if (rawLine === "\\ No newline at end of file") continue
		if (!inHunk) {
			const inferred = inferredStarts[hunkIndex] ?? { oldStart: null, newStart: null }
			oldLine = inferred.oldStart
			newLine = inferred.newStart
			hunkIndex++
			inHunk = true
		}

		const { marker, content } = parsePatchBodyLine(rawLine)

		chars += content.length
		if (marker === "+") {
			diffLines.push({ type: "add", oldNum: null, newNum: newLine, content })
			added++
			if (newLine !== null) newLine++
			continue
		}
		if (marker === "-") {
			diffLines.push({ type: "del", oldNum: oldLine, newNum: null, content })
			removed++
			if (oldLine !== null) oldLine++
			continue
		}
		diffLines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content })
		if (oldLine !== null) oldLine++
		if (newLine !== null) newLine++
	}

	return {
		lines: trimDiffSeparators(diffLines),
		added,
		removed,
		chars,
	}
}

function parseApplyPatchPreview(
	patchText: string,
	sp: (path: string) => string,
	cwd = process.cwd(),
): ApplyPatchPreview {
	const normalized = patchText.replace(/\r\n/g, "\n")
	const lines = normalized.split("\n")
	const changes: ApplyPatchChangePreview[] = []
	let index = 0

	const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/
	const endHeader = /^\*\*\* End Patch$/

	while (index < lines.length) {
		const line = lines[index]
		if (!line || line === "*** Begin Patch") {
			index++
			continue
		}
		if (endHeader.test(line)) break
		const header = line.match(fileHeader)
		if (!header) {
			index++
			continue
		}

		const kind = header[1].toLowerCase() as ApplyPatchChangePreview["kind"]
		const path = header[2].trim()
		index++

		let moveTo: string | undefined
		const body: string[] = []
		while (index < lines.length && !fileHeader.test(lines[index]) && !endHeader.test(lines[index])) {
			if (lines[index].startsWith("*** Move to: ")) {
				moveTo = lines[index].slice("*** Move to: ".length).trim()
				index++
				continue
			}
			body.push(lines[index])
			index++
		}

		const displayPath = moveTo ? `${sp(path)} ${BORDER_COLOR}→${TRANSPARENT_RESET} ${sp(moveTo)}` : sp(path)
		let sourceContent: string | undefined
		if (kind === "update") {
			try {
				sourceContent = readFileSync(resolve(cwd, path), "utf8")
			} catch {
				sourceContent = undefined
			}
		}
		const diff =
			kind === "add"
				? parseDiff("", body.map((entry) => stripPatchLinePrefix(entry, "+")).join("\n"))
				: kind === "delete"
					? parseDiff(body.map((entry) => stripPatchLinePrefix(entry, "-")).join("\n"), "")
					: parseApplyPatchUpdateDiff(body, sourceContent)
		changes.push({
			kind,
			path,
			displayPath,
			moveTo,
			diff,
			language: lang(moveTo || path),
			hunks: countDiffHunks(diff),
			summary: summarizeDiff(diff.added, diff.removed),
			line: getApplyPatchLine(diff, kind),
		})
	}

	const totalAdded = changes.reduce((sum, change) => sum + change.diff.added, 0)
	const totalRemoved = changes.reduce((sum, change) => sum + change.diff.removed, 0)
	const totalHunks = changes.reduce((sum, change) => sum + change.hunks, 0)
	const totalLines = changes.reduce((sum, change) => sum + change.diff.lines.length, 0)
	return {
		changes,
		totalAdded,
		totalRemoved,
		totalHunks,
		totalLines,
		summary: summarizeDiff(totalAdded, totalRemoved),
	}
}

function describeApplyPatchChange(change: ApplyPatchChangePreview): string {
	if (change.moveTo) return `Rename ${change.displayPath}`
	if (change.kind === "add") return `Create ${change.displayPath}`
	if (change.kind === "delete") return `Delete ${change.displayPath}`
	return `Update ${change.displayPath}`
}

function formatLineMeta(line: number, theme: Theme): string {
	return line > 0 ? ` ${theme.fg("muted", `at line ${line}`)}` : ""
}

function formatApplyPatchLine(change: ApplyPatchChangePreview, theme: Theme): string {
	return formatLineMeta(change.line, theme)
}

function getCachedApplyPatchPreview(
	patchText: string,
	sp: (path: string) => string,
	ctx: any,
): ApplyPatchPreview | null {
	if (!patchText) return null
	const key = `apply-meta:${ctx.cwd ?? process.cwd()}:${hashText(patchText)}`
	if (ctx.state?._applyPatchMetaKey === key && ctx.state._applyPatchPreview) {
		return ctx.state._applyPatchPreview as ApplyPatchPreview
	}
	try {
		const preview = parseApplyPatchPreview(patchText, sp, ctx.cwd ?? process.cwd())
		if (ctx.state) {
			ctx.state._applyPatchMetaKey = key
			ctx.state._applyPatchPreview = preview
			ctx.state._applyPatchMeta = buildApplyPatchResultMeta(preview)
		}
		return preview
	} catch {
		return null
	}
}

function getApplyPatchResultMeta(args: any, ctx: any, sp: (path: string) => string): ApplyPatchResultMeta | null {
	const patchText = getStringArg(args ?? ctx?.args, "patchText", "patch_text")
	if (!patchText) return null
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx)
	return preview && ctx.state?._applyPatchMeta ? (ctx.state._applyPatchMeta as ApplyPatchResultMeta) : null
}

function renderApplyPatchCall(args: any, theme: Theme, ctx: any, sp: (path: string) => string): Text {
	const patchText = getStringArg(args, "patchText", "patch_text")
	const summary = stableCallSummary(ctx, "_callSummary", () => summarizeOpenAiToolCall("apply_patch", args, theme, sp))
	const timer = formatToolTimer(getToolElapsedMs(ctx))
	const hdr = toolHeader("Apply Patch", summary, theme, toolStatusDot(ctx, theme), timer)

	if (!ctx.argsComplete) return makeText(ctx.lastComponent, hdr)
	const preview = getCachedApplyPatchPreview(patchText, sp, ctx)
	if (!preview || preview.changes.length === 0) {
		ctx.state._openAiPatchFiles = []
		return makeText(ctx.lastComponent, hdr)
	}
	ctx.state._openAiPatchFiles = preview.changes.map((change) => change.displayPath)

	const diffWidth = branchDiffWidth()
	const key = `apply-preview:${ctx.state._applyPatchMetaKey ?? hashText(patchText)}:${diffWidth}:${ctx.expanded ? 1 : 0}`
	if (ctx.state._applyPatchPreviewKey !== key) {
		ctx.state._applyPatchPreviewKey = key
		ctx.state._applyPatchPreviewBody = theme.fg("muted", "(rendering…)")
		ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true)
		const dc = resolveDiffColors(theme)
		if (preview.changes.length === 1) {
			const [change] = preview.changes
			renderSplit(change.diff, change.language, ctx.expanded ? MAX_PREVIEW_LINES : 32, dc, diffWidth)
				.then((rendered) => {
					if (ctx.state._applyPatchPreviewKey !== key) return
					ctx.state._applyPatchPreviewBody = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}\n${rendered}`
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true)
					ctx.invalidate()
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return
					ctx.state._applyPatchPreviewBody = `${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true)
					ctx.invalidate()
				})
		} else {
			const maxShown = ctx.expanded ? preview.changes.length : Math.min(preview.changes.length, 3)
			const previewLines = ctx.expanded
				? Math.max(6, Math.floor(MAX_RENDER_LINES / Math.max(1, maxShown)))
				: Math.max(8, Math.floor(MAX_PREVIEW_LINES / Math.max(1, maxShown)))
			Promise.all(
				preview.changes.slice(0, maxShown).map((change, index) =>
					renderSplit(change.diff, change.language, previewLines, dc, diffWidth)
						.then(
							(rendered) =>
								`${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}\n${rendered}`,
						)
						.catch(
							() =>
								`${index + 1}. ${describeApplyPatchChange(change)} ${change.summary}${formatApplyPatchLine(change, theme)}`,
						),
				),
			)
				.then((sections) => {
					if (ctx.state._applyPatchPreviewKey !== key) return
					const remainder = preview.changes.length - maxShown
					const suffix =
						remainder > 0
							? `\n${theme.fg("muted", `… ${remainder} more file patches${ctx.expanded ? "" : " • ctrl+o to expand"}`)}`
							: ""
					const summary = `${preview.changes.length} files ${preview.summary}`
					ctx.state._applyPatchPreviewBody = `${summary}\n\n${sections.join("\n\n")}${suffix}`
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true)
					ctx.invalidate()
				})
				.catch(() => {
					if (ctx.state._applyPatchPreviewKey !== key) return
					ctx.state._applyPatchPreviewBody = `${preview.changes.length} files ${preview.summary}`
					ctx.state._applyPatchPreviewDisplay = withBranch(ctx.state._applyPatchPreviewBody, theme, false, true)
					ctx.invalidate()
				})
		}
	}

	const body = ctx.state._applyPatchPreviewDisplay as string | undefined
	return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr)
}

function renderApplyPatchResult(result: any, isPartial: boolean, theme: Theme, ctx: any): Text {
	if (isPartial) {
		setupBlinkTimer(ctx)
		return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Applying Patch..."), theme))
	}
	clearBlinkTimer(ctx)

	if (ctx.isError) {
		const raw = getTextContent(result).trim()
		const firstLine = raw ? raw.split("\n")[0] : "Apply patch failed"
		return makeText(ctx.lastComponent, withBranch(theme.fg("error", firstLine), theme))
	}

	const meta = getApplyPatchResultMeta(ctx.args, ctx, (path: string) => shortPath(ctx.cwd ?? process.cwd(), path))
	if (!meta || meta.changeCount === 0) {
		return makeText(ctx.lastComponent, withBranch(theme.fg("success", "Applied"), theme))
	}

	if (meta.changeCount === 1 && meta.firstChange) {
		const change = meta.firstChange
		const summary = diffSummaryWithMeta(
			change.added,
			change.removed,
			change.hunks,
			change.kind === "add" ? "new file" : change.kind === "delete" ? "delete" : "",
		)
		return makeText(
			ctx.lastComponent,
			withBranch(
				`${theme.fg("success", "Applied")} ${theme.fg("muted", change.displayPath)} ${summary}${formatLineMeta(change.line, theme)}`,
				theme,
			),
		)
	}

	const summary = diffSummaryWithMeta(meta.totalAdded, meta.totalRemoved, meta.totalHunks, "")
	return makeText(
		ctx.lastComponent,
		withBranch(
			`${theme.fg("success", "Applied")} ${meta.changeCount} files ${summary}${meta.totalLines ? ` ${theme.fg("muted", `(${meta.totalLines} diff lines)`)}` : ""}`,
			theme,
		),
	)
}

/** Max chars shown for a single arg value before truncation. */
const MCP_ARG_VALUE_MAX = 60
/** Max total chars for the entire (key=val, …) suffix. */
const MCP_ARGS_SUFFIX_MAX = 120

/**
 * Keys whose values are typically long blobs (file paths list, prompt text,
 * raw content). These get truncated more aggressively or skipped when many
 * other keys are present.
 */

/**
 * For an MCP gateway call whose args contain `tool`, parse the nested args
 * JSON and return a compact `(key=val, key=val)` style plain string (no ANSI),
 * matching the style used by the `read` tool for offset/limit.
 *
 * When `expanded` is false (collapsed view) long values are truncated and the
 * whole suffix is capped at MCP_ARGS_SUFFIX_MAX chars so the header stays on
 * one line. When `expanded` is true all values are shown in full.
 */
export function summarizeMcpToolInvocationArgs(args: any, expanded = false): string {
	const rawArgs = getStringArg(args, "args")
	if (!rawArgs) return ""
	try {
		const parsed = JSON.parse(rawArgs)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""

		const parts: string[] = []
		// Always use original key order — collapsed mode just stops at the cap.
		const ordered = Object.entries(parsed as Record<string, unknown>)
		for (const [key, val] of ordered) {
			if (val === undefined || val === null) continue
			let display: string
			if (Array.isArray(val)) {
				if (val.length === 0) continue
				if (expanded) {
					display = val.map((v) => String(v)).join(", ")
				} else {
					const first = String(val[0])
					display =
						val.length === 1
							? summarizeText(first, MCP_ARG_VALUE_MAX)
							: `${summarizeText(first, 30)} +${val.length - 1}`
				}
			} else if (typeof val === "object") {
				continue // skip nested objects
			} else {
				display = expanded ? String(val) : summarizeText(String(val), MCP_ARG_VALUE_MAX)
			}
			const part = `${key}=${display}`
			// In collapsed mode stop adding parts if we'd exceed the suffix cap.
			if (!expanded) {
				const currentLen = parts.reduce((n, p) => n + p.length + 2, 0)
				if (currentLen + part.length > MCP_ARGS_SUFFIX_MAX) break
			}
			parts.push(part)
		}

		if (parts.length === 0) return ""
		return `(${parts.join(", ")})`
	} catch {
		// not valid JSON — ignore
	}
	return ""
}

function summarizeMcpToolCall(args: any, theme: Theme, expanded = false): string {
	const tool = getStringArg(args, "tool")
	if (tool) {
		const argsSummary = summarizeMcpToolInvocationArgs(args, expanded)
		return argsSummary ? theme.fg("muted", argsSummary) : ""
	}
	const connect = getStringArg(args, "connect")
	if (connect) return connect
	const search = getStringArg(args, "search", "describe", "server", "action")
	if (search) return summarizeText(search, 72)
	return theme.fg("muted", "status")
}

/**
 * Returns the display label and summary for an MCP gateway call.
 * - Tool invocation (`args.tool` present): label = humanized tool name, summary = args preview
 * - Discovery (`args.search` / `args.describe` / …): label = "Tool search" / "Tool describe" / …
 * - Connect: label = "Tool connect"
 */
export function mcpCallLabelAndSummary(
	args: any,
	theme: Theme,
	expanded = false,
): { label: string; summary: string } {
	const tool = getStringArg(args, "tool")
	if (tool) {
		const server = getStringArg(args, "server")
		const toolDisplay = tool.replace(/_/g, " ")
		const label = server ? `${server} - ${toolDisplay}` : toolDisplay
		const rawSuffix = summarizeMcpToolInvocationArgs(args, expanded)
		const summary = rawSuffix ? theme.fg("muted", rawSuffix) : ""
		return { label, summary }
	}
	if (getStringArg(args, "connect")) {
		return { label: "Tool connect", summary: theme.fg("muted", `(server=${getStringArg(args, "connect")})`) }
	}
	if (getStringArg(args, "describe")) {
		return { label: "Tool describe", summary: theme.fg("muted", `(tool=${summarizeText(getStringArg(args, "describe"), 60)})`) }
	}
	if (getStringArg(args, "search")) {
		return { label: "Tool search", summary: theme.fg("muted", `(query=${summarizeText(getStringArg(args, "search"), 60)})`) }
	}
	if (getStringArg(args, "server")) {
		return { label: "Tool search", summary: theme.fg("muted", `(server=${summarizeText(getStringArg(args, "server"), 60)})`) }
	}
	if (getStringArg(args, "action")) {
		return { label: "Tool action", summary: theme.fg("muted", `(action=${summarizeText(getStringArg(args, "action"), 60)})`) }
	}
	return { label: "MCP", summary: theme.fg("muted", "(status)") }
}

function summarizeGenericToolCall(name: string, args: any, theme: Theme, sp: (path: string) => string): string {
	if (isMcpToolName(name)) return summarizeMcpToolCall(args, theme)
	return summarizeOpenAiToolCall(name, args, theme, sp)
}

function renderMcpToolResult(result: any, expanded: boolean, isPartial: boolean, theme: Theme, ctx: any): Text {
	if (isPartial) {
		setupBlinkTimer(ctx)
		return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "MCP running..."), theme))
	}
	clearBlinkTimer(ctx)

	const mode = getMode(readSettings().mcpOutputMode, ["hidden", "summary", "preview"] as const, "preview")
	if (mode === "hidden") return makeText(ctx.lastComponent, "")

	const raw = getTextContent(result).trim()
	const lines = raw ? raw.split("\n") : []
	if (lines.length === 0) {
		return makeText(
			ctx.lastComponent,
			withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme),
		)
	}

	const statusText = ctx.isError
		? theme.fg("error", lines[0])
		: theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`)
	if (mode === "summary") return makeText(ctx.lastComponent, withBranch(statusText, theme))
	if (!expanded && !ctx.isError)
		return makeText(ctx.lastComponent, withBranch(`${statusText}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
	const preview = buildPreviewText(
		lines.map((line) => theme.fg(ctx.isError ? "error" : "toolOutput", line || " ")),
		true,
		theme,
		previewLimit(),
	)
	return makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme))
}

export function summarizeOpenAiToolCall(name: string, args: any, theme: Theme, sp: (path: string) => string): string {
	switch (name) {
		case "apply_patch": {
			const patchText = getStringArg(args, "patchText", "patch_text")
			const files = extractApplyPatchFiles(patchText)
			if (files.length === 0) return theme.fg("muted", "patch")
			if (files.length === 1) return sp(files[0])
			return `${sp(files[0])} ${theme.fg("muted", `(+${files.length - 1} files)`)}`
		}
		case "webfetch":
			return getStringArg(args, "url") || theme.fg("muted", "fetch page")
		case "fetch_content": {
			const url = getStringArg(args, "url")
			if (url) return url
			const urls = getStringArrayArg(args, "urls")
			if (urls.length === 0) return theme.fg("muted", "fetch content")
			if (urls.length === 1) return urls[0]
			return `${urls[0]} ${theme.fg("muted", `(+${urls.length - 1} urls)`)}`
		}
		case "get_search_content":
			return getStringArg(args, "responseId", "response_id") || theme.fg("muted", "load cached content")
		case "web_search": {
			const query = getStringArg(args, "query")
			if (query) return summarizeText(query, 72)
			const queries = getStringArrayArg(args, "queries")
			if (queries.length === 0) return theme.fg("muted", "search web")
			if (queries.length === 1) return summarizeText(queries[0], 72)
			return `${summarizeText(queries[0], 48)} ${theme.fg("muted", `(+${queries.length - 1} queries)`)}`
		}
		case "code_search":
			return summarizeText(getStringArg(args, "query") || "search code", 72)
		case "question":
			return summarizeText(getStringArg(args, "question") || "ask user", 72)
		case "questionnaire": {
			const qs = Array.isArray(args?.questions) ? (args.questions as Array<Record<string, unknown>>) : []
			if (qs.length === 0) return theme.fg("muted", "questionnaire")
			let firstText = ""
			for (const key of ["question", "prompt", "text"]) {
				const value = qs[0]?.[key]
				if (typeof value === "string") {
					firstText = value
					break
				}
			}
			if (!firstText) return `${qs.length} question${qs.length === 1 ? "" : "s"}`
			if (qs.length === 1) return summarizeText(firstText, 72)
			return `${summarizeText(firstText, 48)} ${theme.fg("muted", `(+${qs.length - 1} more)`)}`
		}
		case "context_tag":
			return getStringArg(args, "name") || theme.fg("muted", "save point")
		case "context_log":
			return theme.fg("muted", "history")
		case "context_checkout":
			return getStringArg(args, "target") || theme.fg("muted", "checkout context")
		case "annotate":
			return getStringArg(args, "url") || theme.fg("muted", "current tab")
		case "alpha_search":
			return summarizeText(getStringArg(args, "query") || "search papers", 72)
		case "alpha_get_paper":
		case "alpha_ask_paper":
		case "alpha_annotate_paper":
			return getStringArg(args, "paper") || theme.fg("muted", "paper")
		case "alpha_read_code":
			return getStringArg(args, "githubUrl", "github_url") || theme.fg("muted", "repository")
		case "Skill":
			// SkillToolSchema accepts both 'skill' (primary) and 'name' (alias for Claude Code compat).
			// The adapter passes 'skill'; direct tool calls may pass either. Check both before falling back.
			return getStringArg(args, "skill") || getStringArg(args, "name") || theme.fg("muted", "run skill")
		case "EnterPlanMode":
			return theme.fg("muted", "enable read-only planning")
		case "ExitPlanMode":
			return theme.fg("muted", "present plan")
		case "set_phase":
			return getStringArg(args, "phase") || theme.fg("muted", "set phase")
		case "Agent":
			return summarizeText(getStringArg(args, "description", "prompt") || "launch agent", 72)
		case "get_subagent_result":
			return getStringArg(args, "agent_id") || theme.fg("muted", "agent result")
		case "steer_subagent":
			return getStringArg(args, "agent_id") || theme.fg("muted", "steer agent")
		case "TaskCreate":
			return summarizeText(getStringArg(args, "subject") || "create task", 72)
		case "TaskList":
			return theme.fg("muted", "task list")
		case "TaskGet":
		case "TaskUpdate":
			return getStringArg(args, "taskId", "task_id") || theme.fg("muted", "task")
		case "TaskOutput":
		case "TaskStop":
			return getStringArg(args, "task_id", "taskId") || theme.fg("muted", "background task")
		case "TaskExecute": {
			const taskIds = getStringArrayArg(args, "task_ids", "taskIds")
			if (taskIds.length === 0) return theme.fg("muted", "start tasks")
			return taskIds.length === 1 ? taskIds[0] : `${taskIds[0]} ${theme.fg("muted", `(+${taskIds.length - 1} tasks)`)}`
		}
		default:
			return summarizeText(
				getStringArg(args, "path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt") ||
					humanizeToolName(name),
				72,
			)
	}
}

interface ParsedTaskListLine {
	id: string
	status: string
	subject: string
}

function parseTaskListLine(line: string): ParsedTaskListLine | null {
	const match = line.match(/^#(\d+) \[([^\]]+)\] (.+)$/)
	if (!match) return null
	return {
		id: match[1],
		status: match[2],
		subject: match[3],
	}
}

function formatTaskStatus(status: string, theme: Theme): string {
	if (status === "completed") return theme.fg("success", status)
	if (status === "in_progress") return theme.fg("warning", status)
	return theme.fg("muted", status)
}

function formatOpenAiSuccessLine(name: string, line: string, theme: Theme): string {
	const trimmed = line.trim()
	if (!trimmed) return theme.fg("success", "Done")

	if (name === "TaskCreate") {
		const match = trimmed.match(/^Task #(\d+) created successfully: (.+)$/)
		if (match) {
			return `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`
		}
	}

	if (name === "TaskUpdate") {
		const match = trimmed.match(/^Updated task #(\d+) (.+)$/)
		if (match) {
			return `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`
		}
	}

	if (name === "TaskExecute") {
		return `${theme.fg("success", "Started")} ${theme.fg("muted", trimmed)}`
	}

	if (name === "context_tag") {
		const match = trimmed.match(/^Created tag '([^']+)' at (.+)$/)
		if (match) {
			return `${theme.fg("success", "Created tag")} ${theme.fg("accent", match[1])} ${theme.fg("muted", match[2])}`
		}
	}

	if (name === "context_checkout") {
		return `${theme.fg("success", "Checked out")} ${theme.fg("muted", trimmed.replace(/^Checked out\s*/i, ""))}`
	}

	if (name === "TaskStop") {
		return `${theme.fg("success", "Stopped")} ${theme.fg("muted", trimmed)}`
	}

	return theme.fg("muted", trimmed)
}

function renderTaskListResult(lines: string[], expanded: boolean, theme: Theme, ctx: any): Text {
	const tasks = lines.map(parseTaskListLine).filter((task): task is ParsedTaskListLine => task !== null)
	if (tasks.length === 0) {
		const text =
			lines.length === 0
				? theme.fg("muted", "no tasks")
				: buildPreviewText(
						lines.map((line) => theme.fg("dim", line)),
						expanded,
						theme,
						previewLimit(),
					)
		return makeText(ctx.lastComponent, withBranch(text, theme))
	}

	const pending = tasks.filter((task) => task.status === "pending").length
	const inProgress = tasks.filter((task) => task.status === "in_progress").length
	const completed = tasks.filter((task) => task.status === "completed").length
	let summary = theme.fg("muted", `${tasks.length} tasks`)
	const parts: string[] = []
	if (inProgress > 0) parts.push(`${theme.fg("warning", String(inProgress))} in progress`)
	if (pending > 0) parts.push(`${theme.fg("muted", String(pending))} pending`)
	if (completed > 0) parts.push(`${theme.fg("success", String(completed))} completed`)
	if (parts.length > 0) summary += ` ${theme.fg("muted", "•")} ${parts.join(` ${theme.fg("muted", "•")} `)}`

	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${summary}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
	}

	const shown = tasks.slice(0, previewLimit())
	const preview = shown.map(
		(task) =>
			`${theme.fg("accent", `#${task.id}`)} ${formatTaskStatus(task.status, theme)} ${theme.fg("dim", task.subject)}`,
	)
	const remaining = tasks.length - shown.length
	if (remaining > 0) preview.push(theme.fg("muted", `… ${remaining} more tasks`))
	return makeText(ctx.lastComponent, withBranch(`${summary}\n${preview.join("\n")}`, theme))
}

function getFirstImageBlock(result: any): { data: string; mimeType: string } | undefined {
	if (!Array.isArray(result?.content)) return undefined
	return result.content.find(
		(block: any) => block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	)
}

function getReadImageFallback(result: any, ctx: any): string {
	const image = getFirstImageBlock(result)
	if (!image) return ""
	let dimensions
	try {
		dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined
	} catch {
		dimensions = undefined
	}
	const path = getStringArg(ctx.args, "path", "file_path")
	const filename = path ? shortPath(ctx.cwd ?? process.cwd(), path) : undefined
	return imageFallback(image.mimeType, dimensions, filename)
}

function renderReadImageResult(result: any, expanded: boolean, theme: Theme, ctx: any): Text {
	const image = getFirstImageBlock(result)
	const mimeType = image?.mimeType ?? "image"
	const summary = `${theme.fg("success", "Image loaded")} ${theme.fg("muted", `[${mimeType}]`)}`
	if (!expanded) {
		return makeText(ctx.lastComponent, withBranch(`${summary}${theme.fg("muted", " • ctrl+o to show")}`, theme))
	}

	const noteLines = getTextContent(result)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^Read image file\b/i.test(line))
	const lines = [summary, ...noteLines.map((line) => theme.fg("dim", line))]
	if (!getCapabilities().images || !ctx.showImages) {
		const fallback = getReadImageFallback(result, ctx)
		if (fallback) lines.push(theme.fg("toolOutput", fallback))
	}
	return makeText(ctx.lastComponent, withBranch(lines.join("\n"), theme))
}

function renderOpenAiToolResult(
	name: string,
	result: any,
	expanded: boolean,
	isPartial: boolean,
	theme: Theme,
	ctx: any,
): Text {
	if (isPartial) {
		setupBlinkTimer(ctx)
		return makeText(ctx.lastComponent, withBranch(theme.fg("dim", `${humanizeToolName(name)}...`), theme))
	}
	clearBlinkTimer(ctx)

	const raw = getTextContent(result).trim()
	const lines = raw ? raw.split("\n") : []
	const patchFiles = Array.isArray(ctx.state?._openAiPatchFiles) ? ctx.state._openAiPatchFiles : []

	if (lines.length === 0) {
		if (patchFiles.length > 0) {
			const suffix = patchFiles.length === 1 ? patchFiles[0] : `${patchFiles.length} files`
			return makeText(
				ctx.lastComponent,
				withBranch(
					`${theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Applied")} ${theme.fg("muted", suffix)}`,
					theme,
				),
			)
		}
		return makeText(
			ctx.lastComponent,
			withBranch(theme.fg(ctx.isError ? "error" : "success", ctx.isError ? "Failed" : "Done"), theme),
		)
	}

	if (!ctx.isError && name === "TaskList") {
		return renderTaskListResult(lines, expanded, theme, ctx)
	}

	const statusText = ctx.isError
		? theme.fg("error", lines[0])
		: theme.fg("muted", `${lines.length} line${lines.length === 1 ? "" : "s"} returned`)
	if (!expanded && !ctx.isError) {
		return makeText(ctx.lastComponent, withBranch(`${statusText}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
	}

	if (!ctx.isError && lines.length === 1) {
		return makeText(ctx.lastComponent, withBranch(formatOpenAiSuccessLine(name, lines[0], theme), theme))
	}

	const preview =
		lines.length === 1
			? theme.fg(ctx.isError ? "error" : "dim", lines[0])
			: buildPreviewText(
					lines.map((line) => theme.fg(ctx.isError ? "error" : "dim", line || " ")),
					true,
					theme,
					previewLimit(),
				)
	return makeText(ctx.lastComponent, withBranch(`${statusText}\n${preview}`, theme))
}

// ===========================================================================
// Extension
// ===========================================================================

export default function (pi: ExtensionAPI) {
	patchToolRenderCacheInvalidation()
	patchReadImageExpansion()
	patchGlobalToolBorders()
	patchToolExecutionRenderers()
	patchUserMessageRender()
	patchAssistantMessageRender()
	applyDiffPalette()
	registerThinkingLabels(pi)

	// /cc-tools command — toggle tool border style at runtime
	const TOOL_MODES = ["outlines", "transparent", "default"] as const
	pi.registerCommand("cc-tools", {
		description:
			"Switch tool display style: outlines (lines around tools), transparent (no chrome), default (pi built-in backgrounds)",
		getArgumentCompletions(prefix) {
			return TOOL_MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
				value: m,
				label: m,
				description:
					m === "outlines"
						? "Horizontal rules around each tool (default)"
						: m === "transparent"
							? "No borders or backgrounds"
							: "Pi built-in tool backgrounds",
			}))
		},
		async handler(args, ctx) {
			const mode = args.trim().toLowerCase()
			if (!mode) {
				if (ctx.hasUI) ctx.ui.notify(`Tool style: ${toolBackgroundMode}`, "info")
				return
			}
			if (!(TOOL_MODES as readonly string[]).includes(mode)) {
				if (ctx.hasUI) ctx.ui.notify(`Unknown mode "${mode}". Options: ${TOOL_MODES.join(", ")}`, "error")
				return
			}
			toolBackgroundOverride = mode as typeof toolBackgroundMode
			toolBackgroundMode = toolBackgroundOverride
			writeSettingsKey("toolBackground", mode)
			if (ctx.hasUI) {
				applyToolBackgroundMode(ctx.ui.theme)
				ctx.ui.notify(`Tool style → ${mode}`, "info")
			}
		},
	})

	// /cc-theme command — toggle pi-theme-adaptive coloring at runtime.
	const THEME_MODES = ["on", "off", "toggle", "status"] as const
	pi.registerCommand("cc-theme", {
		description: "Toggle whether tool borders / branch rules / diff colors follow the active pi theme",
		getArgumentCompletions(prefix) {
			return THEME_MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
				value: m,
				label: m,
				description:
					m === "on"
						? "Derive borders, branch rules, dim text and diff tints from the active pi theme (default)"
						: m === "off"
							? "Keep the fixed Claude-style palette regardless of theme"
							: m === "toggle"
								? "Flip between on and off"
								: "Show the current setting and a preview of the derived colors",
			}))
		},
		async handler(args, ctx) {
			const raw = args.trim().toLowerCase()
			const current = themeAdaptiveEnabled()

			if (!raw || raw === "status") {
				if (!ctx.hasUI) return
				const theme = ctx.ui.theme as any
				const themeName = theme?.name ?? "unknown"
				const state = current ? "on" : "off"
				if (raw === "status" && current) {
					const settings = readSettings()
					const verbKey = settings.spinnerVerbColor || "borderAccent"
					const statusKey = settings.spinnerStatusColor || "muted"
					const verbAnsi = safeFgAnsi(theme, verbKey) ?? safeFgAnsi(theme, "accent")
					const statusAnsi = safeFgAnsi(theme, statusKey) ?? safeFgAnsi(theme, "muted")
					// Print a short preview of what we derived.
					const preview = [
						`borders     : ${safeFgAnsi(theme, "borderMuted") ? `${safeFgAnsi(theme, "borderMuted")}────\x1b[39m` : "(unchanged)"}`,
						`branches    : ${(safeFgAnsi(theme, "dim") ?? safeFgAnsi(theme, "muted")) ? `${safeFgAnsi(theme, "dim") ?? safeFgAnsi(theme, "muted")}├─ └─\x1b[39m` : "(unchanged)"}`,
						`muted text  : ${safeFgAnsi(theme, "muted") ? `${safeFgAnsi(theme, "muted")}example dim text\x1b[39m` : "(unchanged)"}`,
						`diff add    : ${safeFgAnsi(theme, "toolDiffAdded") ? `${safeFgAnsi(theme, "toolDiffAdded")}+ added line\x1b[39m` : "(unchanged)"}`,
						`diff del    : ${safeFgAnsi(theme, "toolDiffRemoved") ? `${safeFgAnsi(theme, "toolDiffRemoved")}- removed line\x1b[39m` : "(unchanged)"}`,
						`spinner verb: ${verbAnsi ? `${verbAnsi}Cooking…\x1b[39m` : "(unchanged)"} (key: ${verbKey})`,
						`spinner stat: ${statusAnsi ? `${statusAnsi}(thinking · ↓ 10 tokens · 2s)\x1b[39m` : "(unchanged)"} (key: ${statusKey})`,
					].join("\n  ")
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")\n  ${preview}`, "info")
				} else {
					ctx.ui.notify(`Theme adaptive: ${state} (theme "${themeName}")`, "info")
				}
				return
			}

			let next: boolean
			if (raw === "on") next = true
			else if (raw === "off") next = false
			else if (raw === "toggle") next = !current
			else {
				if (ctx.hasUI) ctx.ui.notify(`Unknown option "${raw}". Options: ${THEME_MODES.join(", ")}`, "error")
				return
			}

			writeSettingsKey("themeAdaptive", next)
			bustSpinnerSettingsCache()
			// Invalidate caches so the next render re-derives from the active
			// theme (or falls back to the fixed Claude palette).
			_themePaletteCacheTheme = null
			autoDerivePending = true
			if (next) {
				if (ctx.hasUI) applyThemePaletteIfNeeded(ctx.ui.theme)
			} else {
				resetThemePalette()
			}
			if (ctx.hasUI) {
				const label = next ? "on — colors follow pi theme" : "off — fixed Claude palette"
				ctx.ui.notify(`Theme adaptive: ${label}`, "info")
			}
		},
	})

	// /cc-spinner command — pick which theme color keys drive the spinner verb
	// and status suffix.
	const COMMON_COLOR_KEYS: readonly string[] = [
		"accent",
		"borderAccent",
		"success",
		"error",
		"warning",
		"muted",
		"dim",
		"text",
		"thinkingText",
		"toolTitle",
		"mdHeading",
		"mdCode",
		"mdLink",
		"mdListBullet",
		"bashMode",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"syntaxKeyword",
		"syntaxFunction",
		"syntaxString",
		"syntaxType",
	]
	pi.registerCommand("cc-spinner", {
		description: "Set the spinner verb or status theme color, or preview current values",
		getArgumentCompletions(prefix) {
			const subCommands = ["verb", "status", "reset", "preview"]
			const parts = prefix.split(/\s+/)
			if (parts.length <= 1) {
				return subCommands
					.filter((c) => c.startsWith(parts[0] ?? ""))
					.map((c) => ({
						value: c,
						label: c,
						description:
							c === "verb"
								? "Set the color key used for the spinner verb (e.g. 'Cooking…')"
								: c === "status"
									? "Set the color key used for the spinner status suffix"
									: c === "reset"
										? "Reset both verb and status to defaults (borderAccent, muted)"
										: "Preview every theme color key with its current sample",
					}))
			}
			// Second arg: color key completions for verb/status.
			if (parts[0] === "verb" || parts[0] === "status") {
				const keyPrefix = (parts[1] ?? "").toLowerCase()
				return COMMON_COLOR_KEYS.filter((k) => k.toLowerCase().startsWith(keyPrefix)).map((k) => ({
					value: k,
					label: k,
					description: `theme.fg("${k}", …)`,
				}))
			}
			return []
		},
		async handler(args, ctx) {
			const parts = args
				.trim()
				.split(/\s+/)
				.filter((p) => p.length > 0)
			const sub = (parts[0] ?? "").toLowerCase()
			const theme = ctx.hasUI ? (ctx.ui.theme as any) : null
			const settings = readSettings()
			const currentVerb = settings.spinnerVerbColor || "borderAccent"
			const currentStatus = settings.spinnerStatusColor || "muted"

			if (!sub || sub === "preview") {
				if (!ctx.hasUI) return
				if (!theme) {
					ctx.ui.notify(`Spinner verb: ${currentVerb}, status: ${currentStatus} (no theme)`, "info")
					return
				}
				const lines: string[] = [
					`Current: verb=${currentVerb}, status=${currentStatus}`,
					"",
					"Preview of common theme keys (pick one for verb or status):",
				]
				for (const key of COMMON_COLOR_KEYS) {
					const ansi = safeFgAnsi(theme, key)
					const marker = key === currentVerb ? "(verb)" : key === currentStatus ? "(status)" : ""
					const sample = ansi ? `${ansi}Cooking…\x1b[39m` : "(unmapped)"
					lines.push(`  ${key.padEnd(16)} ${sample} ${marker}`)
				}
				ctx.ui.notify(lines.join("\n"), "info")
				return
			}

			if (sub === "reset") {
				writeSettingsKey("spinnerVerbColor", undefined)
				writeSettingsKey("spinnerStatusColor", undefined)
				bustSpinnerSettingsCache()
				if (ctx.hasUI) ctx.ui.notify("Spinner colors reset to defaults (verb=borderAccent, status=muted)", "info")
				return
			}

			if (sub !== "verb" && sub !== "status") {
				if (ctx.hasUI) ctx.ui.notify(`Usage: /cc-spinner verb <key> | status <key> | reset | preview`, "error")
				return
			}

			const key = parts[1]
			if (!key) {
				if (ctx.hasUI) ctx.ui.notify(`Missing color key. Try /cc-spinner preview to see available keys.`, "error")
				return
			}

			// Validate the key resolves to *some* color in the active theme;
			// accept anyway if the user insists so themes with custom keys work.
			const ansi = theme ? safeFgAnsi(theme, key) : null
			const settingKey = sub === "verb" ? "spinnerVerbColor" : "spinnerStatusColor"
			writeSettingsKey(settingKey, key)
			bustSpinnerSettingsCache()
			if (ctx.hasUI) {
				const sample = ansi ? `${ansi}sample\x1b[39m` : "(key unmapped in current theme)"
				ctx.ui.notify(`Spinner ${sub} → ${key} ${sample}`, "info")
			}
		},
	})

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return
		applyToolBackgroundMode(ctx.ui.theme)
		applyThemePaletteIfNeeded(ctx.ui.theme)
	})

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return
		applyToolBackgroundMode(ctx.ui.theme)
		applyThemePaletteIfNeeded(ctx.ui.theme)
	})

	const cwd = process.cwd()
	const sp = (path: string) => shortPath(cwd, path)

	const readTool = createReadTool(cwd)
	pi.registerTool({
		name: "read",
		label: "read",
		description: readTool.description,
		parameters: readTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return readTool.execute(toolCallId, params, signal, onUpdate)
		},
		renderCall(args, theme, ctx) {
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = sp(args.path ?? "")
				if (args.offset || args.limit) {
					const parts: string[] = []
					if (args.offset) parts.push(`offset=${args.offset}`)
					if (args.limit) parts.push(`limit=${args.limit}`)
					value += ` ${theme.fg("muted", `(${parts.join(", ")})`)}`
				}
				return value
			})
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			return makeText(ctx.lastComponent, toolHeader("Read", summary, theme, toolStatusDot(ctx, theme), timer))
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Reading..."), theme))
			}
			clearBlinkTimer(ctx)
			if (getFirstImageBlock(result)) return renderReadImageResult(result, expanded, theme, ctx)
			const details = result.details as ReadToolDetails | undefined
			const content = result.content.find((block: any) => block?.type === "text")
			if (content?.type !== "text")
				return makeText(ctx.lastComponent, withBranch(theme.fg("error", "No text content"), theme))
			const lines = content.text.split("\n")
			if (ctx.isError) {
				const header = theme.fg("muted", `${lines.length} lines loaded`)
				const body = lines.map((line) => theme.fg("error", line || " ")).join("\n")
				return makeText(ctx.lastComponent, withBranch(`${header}\n${body}`, theme))
			}
			let text = theme.fg("muted", `${lines.length} lines loaded`)
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)")
			if (!expanded)
				return makeText(ctx.lastComponent, withBranch(`${text}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
			const shown = lines.slice(0, previewLimit())
			text += `\n${buildPreviewText(
				shown.map((line) => theme.fg("dim", line || " ")),
				false,
				theme,
				previewLimit(),
			)}`
			return makeText(ctx.lastComponent, withBranch(text, theme))
		},
	})

	const bashTool = createBashTool(cwd)
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return bashTool.execute(toolCallId, params, signal, onUpdate)
		},
		renderCall(args, theme, ctx) {
			const command = getBashCommandForDisplay(args.command) ?? args.command
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			if (ctx.expanded && command) {
				// Expanded: show the tool name + timer on line 1, then the full
				// command (with real newlines) as a continued branch block below.
				const hdr = toolHeader("Bash", "", theme, toolStatusDot(ctx, theme), timer)
				const cmdBlock = withBranch(command.split("\n").map((l) => theme.fg("accent", l)).join("\n"), theme, false, true)
				return makeText(ctx.lastComponent, `${hdr}\n${cmdBlock}`)
			}
			const summary = summarizeText(command, 72)
			return makeText(ctx.lastComponent, toolHeader("Bash", summary, theme, toolStatusDot(ctx, theme), timer))
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const details = result.details as BashToolDetails | undefined
			const output = result.content[0]?.type === "text" ? result.content[0].text : ""
			const nonEmpty = output.split("\n").filter((line) => line.trim().length > 0)
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(
					ctx.lastComponent,
					withBranch(theme.fg("warning", `Running... (${nonEmpty.length} lines)`), theme),
				)
			}
			clearBlinkTimer(ctx)
			const exitMatch = output.match(/exit code: (\d+)/)
			const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null
			const isExitError = exitCode !== null && exitCode !== 0
			const isError = ctx.isError || isExitError
			let text = isError
				? theme.fg("error", exitCode != null ? `Exit ${exitCode}` : "Failed")
				: theme.fg("success", "Done")
			text += theme.fg("muted", ` (${nonEmpty.length} lines)`)
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]")
			if (!expanded && !isError && nonEmpty.length > 0)
				return makeText(ctx.lastComponent, withBranch(`${text}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
			if (!expanded && !isError) return makeText(ctx.lastComponent, withBranch(text, theme))
			const collapsed = bashCollapsedLimit()
			text += `\n${buildPreviewText(
				nonEmpty.map((line) => theme.fg("dim", line)),
				expanded,
				theme,
				collapsed,
			)}`
			return makeText(ctx.lastComponent, withBranch(text, theme))
		},
	})

	const grepTool = createGrepTool(cwd)
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: grepTool.description,
		parameters: grepTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return grepTool.execute(toolCallId, params, signal, onUpdate)
		},
		renderCall(args, theme, ctx) {
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = `\"${summarizeText(args.pattern, 40)}\"`
				if (args.path) value += ` in ${args.path}`
				return value
			})
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			return makeText(ctx.lastComponent, toolHeader("Grep", summary, theme, toolStatusDot(ctx, theme), timer))
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Searching..."), theme))
			}
			clearBlinkTimer(ctx)
			const details = result.details as GrepToolDetails | undefined
			const matches = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0)
			if (matches.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "no matches"), theme))
			let text = theme.fg("muted", `${matches.length} matches`)
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)")
			if (!expanded)
				return makeText(ctx.lastComponent, withBranch(`${text}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
			text += `\n${buildPreviewText(
				matches.map((line) => theme.fg("dim", line)),
				false,
				theme,
				previewLimit(),
			)}`
			return makeText(ctx.lastComponent, withBranch(text, theme))
		},
	})

	const findTool = createFindTool(cwd)
	pi.registerTool({
		name: "find",
		label: "find",
		description: findTool.description,
		parameters: findTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return findTool.execute(toolCallId, params, signal, onUpdate)
		},
		renderCall(args, theme, ctx) {
			const summary = stableCallSummary(ctx, "_callSummary", () => {
				let value = `\"${summarizeText(args.pattern, 40)}\"`
				if (args.path) value += ` in ${args.path}`
				return value
			})
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			return makeText(ctx.lastComponent, toolHeader("Find", summary, theme, toolStatusDot(ctx, theme), timer))
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Finding..."), theme))
			}
			clearBlinkTimer(ctx)
			const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0)
			if (items.length === 0) return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "no files found"), theme))
			let text = theme.fg("muted", `${items.length} files`)
			if (!expanded)
				return makeText(ctx.lastComponent, withBranch(`${text}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
			// Expanded: grouped find results with icons
			const maxShow = previewLimit()
			const shown = items.slice(0, maxShow)
			const findLines: string[] = []
			for (let i = 0; i < shown.length; i++) {
				const item = shown[i].trim()
				const icon = fileIcon(item)
				findLines.push(`  ${icon}${theme.fg("dim", item)}`)
			}
			const remaining = items.length - shown.length
			if (remaining > 0) {
				findLines.push(`  ${theme.fg("muted", `… ${remaining} more files`)}`)
			}
			text += `\n${findLines.join("\n")}`
			return makeText(ctx.lastComponent, withBranch(text, theme))
		},
	})

	const lsTool = createLsTool(cwd)
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: lsTool.description,
		parameters: lsTool.parameters,
		async execute(toolCallId, params, signal, onUpdate) {
			return lsTool.execute(toolCallId, params, signal, onUpdate)
		},
		renderCall(args, theme, ctx) {
			const summary = stableCallSummary(ctx, "_callSummary", () => sp(args.path ?? "."))
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			return makeText(ctx.lastComponent, toolHeader("List", summary, theme, toolStatusDot(ctx, theme), timer))
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Listing..."), theme))
			}
			clearBlinkTimer(ctx)
			const items = (result.content[0]?.type === "text" ? result.content[0].text : "")
				.split("\n")
				.filter((line) => line.trim().length > 0)
			if (items.length === 0)
				return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "empty directory"), theme))
			let text = theme.fg("muted", `${items.length} entries`)
			if (!expanded)
				return makeText(ctx.lastComponent, withBranch(`${text}${theme.fg("muted", " • ctrl+o to expand")}`, theme))
			// Expanded: tree-view with icons
			const maxShow = previewLimit()
			const shown = items.slice(0, maxShow)
			const treeLines: string[] = []
			for (let i = 0; i < shown.length; i++) {
				const item = shown[i]
				const isDir = item.endsWith("/")
				const isLast = i === shown.length - 1 && items.length <= maxShow
				const prefix = isLast ? `${FG_RULE}\u2514\u2500\u2500${D_RST} ` : `${FG_RULE}\u251c\u2500\u2500${D_RST} `
				const icon = isDir ? dirIcon() : fileIcon(item)
				const name = isDir ? theme.fg("accent", theme.bold(item)) : theme.fg("dim", item)
				treeLines.push(`${prefix}${icon}${name}`)
			}
			const remaining = items.length - shown.length
			if (remaining > 0) {
				treeLines.push(`${FG_RULE}\u2514\u2500\u2500${D_RST} ${theme.fg("muted", `\u2026 ${remaining} more entries`)}`)
			}
			text += `\n${treeLines.join("\n")}`
			return makeText(ctx.lastComponent, withBranch(text, theme))
		},
	})

	const writeTool = createWriteTool(cwd)
	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const fp = params.path ?? (params as any).file_path ?? ""
			const fullPath = fp ? resolve(cwd, fp) : ""
			const existedBefore = !!fullPath && fileExistsForTool(cwd, fp)
			WRITE_EXISTED_BEFORE.set(toolCallId, existedBefore)
			let old: string | null = null
			try {
				if (fullPath && existedBefore) old = readFileSync(fullPath, "utf-8")
			} catch {
				old = null
			}
			const result = await writeTool.execute(toolCallId, params, signal, onUpdate)
			const content = params.content ?? ""
			if (old !== null && old !== content) {
				const diff = parseDiff(old, content)
				;(result as any).details = {
					_type: "diff",
					summary: summarizeDiff(diff.added, diff.removed),
					diff,
					language: lang(fp),
				}
			} else if (old === null) {
				;(result as any).details = { _type: "new", lines: lineCount(content), filePath: fp }
			} else if (old === content) {
				;(result as any).details = { _type: "noChange" }
			}
			return result
		},
		renderCall(args, theme, ctx) {
			const fp = args?.path ?? (args as any)?.file_path ?? ""
			const revealSummary = shouldRevealCallArgs(ctx) || (!!fp && hasOwnArg(args, "content"))
			const wasNew = getWriteWasNewFile(ctx, cwd, fp, revealSummary)
			const label = wasNew === true ? "Create" : "Write"
			const summary = stableCallSummary(
				ctx,
				"_callSummary",
				() => {
					const base = sp(fp)
					return shouldRevealCallArgs(ctx)
						? `${base} ${theme.fg("muted", `(${lineCount(args.content ?? "")} lines)`)}`
						: base
				},
				revealSummary,
			)
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			const hdr = toolHeader(label, summary, theme, toolStatusDot(ctx, theme), timer)
			return makeText(ctx.lastComponent, hdr)
		},
		renderResult(result, { isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, withBranch(theme.fg("dim", "Writing..."), theme))
			}
			clearBlinkTimer(ctx)
			if (typeof ctx?.toolCallId === "string") WRITE_EXISTED_BEFORE.delete(ctx.toolCallId)
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error"
				return makeText(ctx.lastComponent, withBranch(theme.fg("error", e), theme))
			}
			const d = (result as any).details
			if (d?._type === "diff") {
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit()
				const hunks = d.diff?.lines?.filter((l: any) => l.type === "sep").length + (d.diff?.lines?.length ? 1 : 0)
				const diffWidth = branchDiffWidth()
				const mode = shouldUseSplit(d.diff, diffWidth, previewLines) ? "split" : "unified"
				const richSummary = diffSummaryWithMeta(d.diff.added, d.diff.removed, hunks, mode)
				const key = `wd:${diffWidth}:${d.summary}:${d.diff?.lines?.length ?? 0}:${d.language ?? ""}:${ctx.expanded ? 1 : 0}`
				if (ctx.state._wdk !== key) {
					ctx.state._wdk = key
					ctx.state._wdt = withFinalBranchBlock(`${richSummary}\n${theme.fg("muted", "rendering diff…")}`)
					const dc = resolveDiffColors(theme)
					renderSplit(d.diff, d.language, previewLines, dc, diffWidth)
						.then((rendered) => {
							if (ctx.state._wdk !== key) return
							ctx.state._wdt = withFinalBranchBlock(`${richSummary}\n${rendered}`)
							ctx.invalidate()
						})
						.catch(() => {
							if (ctx.state._wdk !== key) return
							ctx.state._wdt = withBranch(richSummary, theme)
							ctx.invalidate()
						})
				}
				return makeText(ctx.lastComponent, ctx.state._wdt ?? withBranch(richSummary, theme))
			}
			if (d?._type === "noChange")
				return makeText(ctx.lastComponent, withBranch(theme.fg("muted", "✓ no changes"), theme))
			if (d?._type === "new") {
				const content = typeof ctx.args?.content === "string" ? ctx.args.content : ""
				const lineTotal = typeof d.lines === "number" ? d.lines : lineCount(content)
				const contentHash = hashText(content)
				const syntheticDiff = getCachedParsedDiff(ctx, `nf-diff:${d.filePath}:${contentHash}`, "", content)
				const richSummary = diffSummaryWithMeta(syntheticDiff.added, 0, 1, "new file")
				const previewLines = ctx.expanded ? MAX_RENDER_LINES : diffCollapsedLimit()
				const diffWidth = branchDiffWidth()
				const pk = `nf:${d.filePath}:${contentHash}:${diffWidth}:${ctx.expanded ? 1 : 0}`
				if (ctx.state._nfk !== pk) {
					ctx.state._nfk = pk
					ctx.state._nft = withFinalBranchBlock(`${richSummary}\n${theme.fg("muted", "rendering diff…")}`)
					const dc = resolveDiffColors(theme)
					renderUnified(syntheticDiff, lang(d.filePath), previewLines, dc, diffWidth)
						.then((rendered) => {
							if (ctx.state._nfk !== pk) return
							ctx.state._nft = withFinalBranchBlock(`${richSummary}\n${rendered}`)
							ctx.invalidate()
						})
						.catch(() => {
							if (ctx.state._nfk !== pk) return
							ctx.state._nft = withBranch(`${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`, theme)
							ctx.invalidate()
						})
				}
				return makeText(
					ctx.lastComponent,
					ctx.state._nft ?? withBranch(`${richSummary} ${theme.fg("muted", `(${lineTotal} lines)`)}`, theme),
				)
			}
			return makeText(ctx.lastComponent, withBranch(theme.fg("success", "Written"), theme))
		},
	})

	const editTool = createEditTool(cwd)
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, _ctx) {
			const fp = params.path ?? (params as any).file_path ?? ""
			const operations = getEditOperations(params)
			const localizedDiffs = operations.length === 1 ? await computeLocalizedEditDiffs(fp, operations, cwd) : null
			const result = await editTool.execute(toolCallId, params, signal, onUpdate)
			if (operations.length === 0) return result
			const { diffs, summary, totalLines, totalHunks } = summarizeEditOperations(operations)
			const baseDetails = ((result as any).details ?? {}) as Record<string, unknown>
			if (operations.length === 1) {
				const localized = localizedDiffs?.[0]
				const editLine =
					localized?.line ?? (typeof baseDetails.firstChangedLine === "number" ? baseDetails.firstChangedLine : 0)
				const diff = localized?.diff ?? diffs[0]
				;(result as any).details = {
					...baseDetails,
					_type: "editInfo",
					summary,
					editLine,
					hunks: countDiffHunks(diff),
					added: diff?.added ?? 0,
					removed: diff?.removed ?? 0,
				}
				return result
			}
			;(result as any).details = {
				...baseDetails,
				_type: "multiEditInfo",
				summary,
				editCount: operations.length,
				diffLineCount: totalLines,
				hunks: totalHunks,
				totalAdded: diffs.reduce((sum, diff) => sum + diff.added, 0),
				totalRemoved: diffs.reduce((sum, diff) => sum + diff.removed, 0),
			}
			return result
		},
		renderCall(args, theme, ctx) {
			const fp = args?.path ?? (args as any)?.file_path ?? ""
			const operations = getEditOperations(args)
			const revealSummary = shouldRevealCallArgs(ctx) || (!!fp && hasOwnArg(args, "edits"))
			const summary = stableCallSummary(
				ctx,
				"_callSummary",
				() =>
					shouldRevealCallArgs(ctx) && operations.length > 1
						? `${sp(fp)} ${theme.fg("muted", `(${operations.length} edits)`)}`
						: sp(fp),
				revealSummary,
			)
			const timer = formatToolTimer(getToolElapsedMs(ctx))
			const hdr = toolHeader("Edit", summary, theme, ` ${toolStatusDot(ctx, theme)}`, timer)
			if (!(ctx.argsComplete && operations.length > 0)) return makeText(ctx.lastComponent, hdr)
			const diffWidth = branchDiffWidth()
			const key = `edit:${fp}:${hashText(operations.map((edit) => `${edit.oldText}\u0000${edit.newText}`).join("\u0001"))}:${diffWidth}:${ctx.expanded ? 1 : 0}`
			const { diffs: fallbackDiffs, summary: editSummary } = getCachedEditOperationSummary(ctx, key, operations)
			if (ctx.state._pk !== key) {
				ctx.state._pk = key
				ctx.state._ptBody = theme.fg("muted", "(rendering…)")
				ctx.state._ptDisplay = indentBranchBlock(withBranch(ctx.state._ptBody, theme, false, true))
				const lg = lang(fp)
				void computeLocalizedEditDiffs(fp, operations, cwd)
					.then((localizedDiffs) => {
						if (ctx.state._pk !== key) return
						const diffs = localizedDiffs?.map((entry) => entry.diff) ?? fallbackDiffs
						const lines =
							localizedDiffs?.map((entry) => entry.line) ?? diffs.map((diff) => getFirstChangedNewLine(diff))
						renderEditPreviewBody(ctx, key, theme, lg, operations, diffs, lines, editSummary)
					})
					.catch(() => {
						if (ctx.state._pk !== key) return
						renderEditPreviewBody(
							ctx,
							key,
							theme,
							lg,
							operations,
							fallbackDiffs,
							fallbackDiffs.map((diff) => getFirstChangedNewLine(diff)),
							editSummary,
						)
					})
			}
			const body = ctx.state._ptDisplay as string | undefined
			return makeText(ctx.lastComponent, body ? `${hdr}\n${body}` : hdr)
		},
		renderResult(result, { isPartial }, theme, ctx) {
			if (isPartial) {
				setupBlinkTimer(ctx)
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("dim", "Editing..."), theme)))
			}
			clearBlinkTimer(ctx)
			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error"
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("error", e), theme)))
			}
			if ((result as any).details?._type === "editInfo") {
				const { editLine, hunks, added, removed } = (result as any).details
				const loc = formatLineMeta(editLine ?? 0, theme)
				const summary = diffSummaryWithMeta(added ?? 0, removed ?? 0, hunks ?? 0, "")
				return makeText(ctx.lastComponent, indentBranchBlock(withBranch(`${summary}${loc}`, theme)))
			}
			if ((result as any).details?._type === "multiEditInfo") {
				const { editCount, diffLineCount, hunks, totalAdded, totalRemoved } = (result as any).details
				const summary = diffSummaryWithMeta(totalAdded ?? 0, totalRemoved ?? 0, hunks ?? 0, "")
				return makeText(
					ctx.lastComponent,
					indentBranchBlock(
						withBranch(
							`${editCount} edits ${summary}${typeof diffLineCount === "number" ? ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}` : ""}`,
							theme,
						),
					),
				)
			}
			return makeText(ctx.lastComponent, indentBranchBlock(withBranch(theme.fg("success", "Applied"), theme)))
		},
	})

	const wrappedOpenAiTools = new Set<string>()
	const registerOpenAiToolOverrides = (): void => {
		let allTools: unknown[] = []
		try {
			allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : []
		} catch {
			allTools = []
		}
		for (const tool of allTools) {
			if (!isOpenAiToolCandidate(tool)) continue
			const record = tool as Record<string, unknown>
			const name = typeof record.name === "string" ? record.name : ""
			if (!name || wrappedOpenAiTools.has(name)) continue
			const execute = typeof record.execute === "function" ? (record.execute as any) : null
			if (!execute) continue
			const rawLabel = typeof record.label === "string" ? record.label.trim() : ""
			const label = rawLabel && rawLabel !== name && !rawLabel.includes("_") ? rawLabel : humanizeToolName(name)
			const description = typeof record.description === "string" ? record.description : label
			;(pi as any).registerTool({
				name,
				label,
				description,
				parameters: record.parameters,
				prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
					return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx))
				},
				renderCall(args: any, theme: Theme, ctx: any) {
					if (name === "apply_patch") return renderApplyPatchCall(args, theme, ctx, sp)
					ctx.state._openAiPatchFiles = []
					const summary = stableCallSummary(ctx, "_callSummary", () => summarizeOpenAiToolCall(name, args, theme, sp))
					const timer = formatToolTimer(getToolElapsedMs(ctx))
					return makeText(ctx.lastComponent, toolHeader(label, summary, theme, toolStatusDot(ctx, theme), timer))
				},
				renderResult(result: any, { expanded, isPartial }: any, theme: Theme, ctx: any) {
					if (name === "apply_patch") return renderApplyPatchResult(result, isPartial, theme, ctx)
					return renderOpenAiToolResult(name, result, expanded, isPartial, theme, ctx)
				},
			})
			wrappedOpenAiTools.add(name)
		}
	}

	const wrappedMcpTools = new Set<string>()
	const registerMcpToolOverrides = (): void => {
		let allTools: unknown[] = []
		try {
			allTools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : []
		} catch {
			allTools = []
		}
		for (const tool of allTools) {
			if (!isMcpToolCandidate(tool)) continue
			const record = tool as Record<string, unknown>
			const name = typeof record.name === "string" ? record.name : ""
			if (!name || wrappedMcpTools.has(name)) continue
			const execute = typeof record.execute === "function" ? (record.execute as any) : null
			if (!execute) continue
			const label = typeof record.label === "string" ? record.label : name === "mcp" ? "MCP" : `MCP ${name}`
			const description = typeof record.description === "string" ? record.description : "MCP tool"
			;(pi as any).registerTool({
				name,
				label,
				description,
				parameters: record.parameters,
				prepareArguments: typeof record.prepareArguments === "function" ? record.prepareArguments : undefined,
				async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
					return await Promise.resolve(execute(toolCallId, params, signal, onUpdate, ctx))
				},
				renderCall(args: any, theme: Theme, ctx: any) {
					return renderGenericToolCall(name, args, theme, ctx)
				},
				renderResult(result: any, { expanded, isPartial }: any, theme: Theme, ctx: any) {
					return renderMcpToolResult(result, expanded, isPartial, theme, ctx)
				},
			})
			wrappedMcpTools.add(name)
		}
	}

	pi.on("session_start", async () => {
		registerOpenAiToolOverrides()
		registerMcpToolOverrides()
	})
	pi.on("before_agent_start", async () => {
		registerOpenAiToolOverrides()
		registerMcpToolOverrides()
	})

	// Safety net: clear all blink timers on turn/session boundaries
	pi.on("turn_end", async () => {
		for (const entry of _blinkContexts.values()) {
			entry.key._blinkActive = false
		}
		_blinkContexts.clear()
		clearHighlightCache()
		if (_globalBlinkTimer) {
			clearTimeout(_globalBlinkTimer)
			_globalBlinkTimer = null
		}
	})
	pi.on("session_shutdown", async () => {
		for (const entry of _blinkContexts.values()) {
			entry.key._blinkActive = false
		}
		_blinkContexts.clear()
		clearHighlightCache()
		if (_globalBlinkTimer) {
			clearTimeout(_globalBlinkTimer)
			_globalBlinkTimer = null
		}
	})
}
