import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import {
	AssistantMessageComponent,
	SettingsSelectorComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent"
import { Container, MouseRegion, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { formatToolTimer } from "./tool-rendering.js"
import { readCollapseWorkMode, writeCollapseWorkMode } from "./work-collapse-settings.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = "file" | "pattern" | "directory" | "edit" | "command" | "operation"

// ---------------------------------------------------------------------------
// classifyTool
// ---------------------------------------------------------------------------

const BASH_DIRECTORY_CMDS = new Set(["ls", "fd", "find"])
const BASH_PATTERN_CMDS = new Set(["grep", "rg"])
const BASH_FILE_CMDS = new Set(["cat", "head", "tail", "read"])

export function classifyTool(toolName: string, args: Record<string, unknown>): Category {
	switch (toolName) {
		case "read":
			return "file"
		case "grep":
		case "find":
			return "pattern"
		case "ls":
			return "directory"
		case "write":
		case "edit":
		case "multiedit":
			return "edit"
		case "bash": {
			const command = typeof args.command === "string" ? args.command.trim() : ""
			const firstWord = command.split(/\s+/)[0] ?? ""
			if (BASH_DIRECTORY_CMDS.has(firstWord)) return "directory"
			if (BASH_PATTERN_CMDS.has(firstWord)) return "pattern"
			if (BASH_FILE_CMDS.has(firstWord)) return "file"
			return "operation"
		}
		default:
			return "operation"
	}
}

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

const PAST: Record<Category, (n: number) => string> = {
	file: (n) => `read ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searched for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listed ${n} ${n === 1 ? "directory" : "directories"}`,
	edit: (n) => `made ${n} ${n === 1 ? "edit" : "edits"}`,
	command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

const CONTINUOUS: Record<Category, (n: number) => string> = {
	file: (n) => `reading ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searching for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listing ${n} ${n === 1 ? "directory" : "directories"}`,
	edit: (n) => `editing ${n} ${n === 1 ? "file" : "files"}`,
	command: (n) => `running ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

export function formatSummary(counts: Map<Category, number>, isInProgress: boolean): string {
	const table = isInProgress ? CONTINUOUS : PAST
	return Array.from(counts.entries())
		.filter(([, n]) => n > 0)
		.map(([cat, n]) => table[cat](n))
		.join(", ")
}

// ---------------------------------------------------------------------------
// Parent tracking via WeakMap
// ---------------------------------------------------------------------------

const ADDCHILD_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-addchild")
const parentMap = new WeakMap<object, Container>()

export function getParent(component: object): Container | undefined {
	return parentMap.get(component)
}

export function patchAddChild(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = Container.prototype as any
	if (proto[ADDCHILD_PATCH_FLAG]) return
	const original = proto.addChild
	proto.addChild = function patchedAddChild(component: object) {
		// Only WeakMap-keyable values (objects/functions) can be recorded. A
		// primitive here means a caller broke upstream's child contract —
		// delegate anyway (upstream addChild itself tolerates it), but never
		// let parent tracking turn that into a crash.
		if (component !== null && (typeof component === "object" || typeof component === "function")) {
			parentMap.set(component, this)
		}
		return original.call(this, component)
	}
	proto[ADDCHILD_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// findToolGroup
// ---------------------------------------------------------------------------

function isToolLike(
	v: unknown,
): v is { toolName: string; toolCallId: string; isPartial: boolean; args: Record<string, unknown> } {
	if (!v || typeof v !== "object") return false
	const c = v as Record<string, unknown>
	return typeof c.toolName === "string" && typeof c.toolCallId === "string"
}

function isFailedTool(v: unknown): boolean {
	if (!isToolLike(v)) return false
	// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on unknown object
	const c = v as any
	return c.result?.isError === true
}

/**
 * Assistant text messages are run members (folded interstitial commentary),
 * not run breakers. Duck-typed so plain objects work in tests.
 */
function isAssistantTextMember(v: unknown): boolean {
	if (v instanceof AssistantMessageComponent) return true
	if (!v || typeof v !== "object") return false
	const message = (v as { lastMessage?: unknown }).lastMessage
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant")
}

/** A run breaks only at children that are neither tools, assistant text, nor spacers. */
function breaksRun(child: unknown): boolean {
	if (isToolLike(child)) return false
	if (isAssistantTextMember(child)) return false
	return !(child instanceof Spacer)
}

interface RunSpan {
	start: number
	end: number
}

function findRunSpan(children: object[], selfIdx: number): RunSpan {
	// Walk backward to find start of run
	let start = selfIdx
	for (let i = selfIdx - 1; i >= 0; i--) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		start = i
	}

	// Walk forward to find end of run
	let end = selfIdx
	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		end = i
	}

	return { start, end }
}

/** Tool members of the run containing `self`, in transcript order. */
export function findToolGroup(self: object, children: object[]): object[] {
	const selfIdx = children.indexOf(self)

	if (selfIdx === -1) {
		return isToolLike(self) ? [self] : []
	}

	const span = findRunSpan(children, selfIdx)

	const tools: object[] = []
	for (let i = span.start; i <= span.end; i++) {
		const child = children[i]
		if (isToolLike(child)) tools.push(child)
	}

	return tools
}

/** True when any tool component exists after `selfIdx` — interleaved text/spacers don't block. */
export function isSupersededByLaterTool(children: object[], selfIdx: number): boolean {
	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (isToolLike(child)) return true
	}
	return false
}

export interface AssistantFoldDecision {
	/** Fold only when strictly between two tools of the same run. */
	fold: boolean
	/** Nearest later tool — its `expanded` flag controls the group's expand state. */
	expandController: object | undefined
}

export function decideAssistantTextFold(children: object[], selfIdx: number): AssistantFoldDecision {
	let hasPrevTool = false
	for (let i = selfIdx - 1; i >= 0; i--) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (isToolLike(child)) {
			hasPrevTool = true
			break
		}
		if (breaksRun(child)) break
	}
	if (!hasPrevTool) return { fold: false, expandController: undefined }

	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		if (isToolLike(child)) {
			return { fold: true, expandController: child }
		}
	}
	return { fold: false, expandController: undefined }
}

/** Run members other than `self` whose expanded flag differs from the new value. */
export function computeExpandPropagation(run: object[], self: object, expanded: boolean): object[] {
	if (run.length < 2) return []
	return run.filter((member) => {
		if (member === self) return false
		return (member as { expanded?: boolean }).expanded !== expanded
	})
}

// ---------------------------------------------------------------------------
// buildGroupSummaryText
// ---------------------------------------------------------------------------

export function buildGroupSummaryText(run: object[], isInProgress: boolean): string {
	const order: Category[] = []
	const counts = new Map<Category, number>()
	for (const tool of run) {
		if (!isToolLike(tool)) continue
		const cat = classifyTool(tool.toolName, tool.args)
		if (!counts.has(cat)) order.push(cat)
		counts.set(cat, (counts.get(cat) ?? 0) + 1)
	}
	const orderedCounts = new Map(order.map((cat) => [cat, counts.get(cat) ?? 0]))
	return formatSummary(orderedCounts, isInProgress)
}

// ---------------------------------------------------------------------------
// buildCurrentToolLine
// ---------------------------------------------------------------------------

export function buildCurrentToolLine(tool: object): string {
	if (!isToolLike(tool)) return "…"
	const { toolName, args } = tool
	switch (toolName) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command.slice(0, 60) : ""
			return `$ ${cmd}`
		}
		case "read": {
			const path = typeof args.path === "string" ? args.path : ""
			return `reading ${path}`
		}
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : ""
			return `searching "${pattern}"`
		}
		case "ls": {
			const path = typeof args.path === "string" ? args.path : "."
			return `ls ${path}`
		}
		default:
			return `${toolName} …`
	}
}

// ---------------------------------------------------------------------------
// buildGroupView
// ---------------------------------------------------------------------------

const GROUP_RENDER_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-render")

function runTimeBounds(run: object[]): { startedAt: number | undefined; endedAt: number | undefined } {
	let startedAt: number | undefined
	let endedAt: number | undefined
	for (const tool of run) {
		// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on unknown object
		const rendererState = (tool as any)?.rendererState
		if (!rendererState || typeof rendererState !== "object") continue
		const s = rendererState._executionStartedAt
		const e = rendererState._executionEndedAt
		if (typeof s === "number" && (startedAt === undefined || s < startedAt)) startedAt = s
		if (typeof e === "number" && (endedAt === undefined || e > endedAt)) endedAt = e
	}
	return { startedAt, endedAt }
}

function countFailedTools(run: object[]): number {
	let failed = 0
	for (const tool of run) {
		if (isFailedTool(tool)) failed++
	}
	return failed
}

// biome-ignore lint/suspicious/noExplicitAny: theme comes from untyped external package
export function buildGroupView(run: object[], theme: any): ToolBlockView {
	const view = new ToolBlockView()
	// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on unknown object
	const last = run[run.length - 1] as any
	const isInProgress = last?.isPartial === true
	const summaryText = buildGroupSummaryText(run, isInProgress)

	// "Worked for Xs" spans the whole run: first start → last end (now while in progress).
	const { startedAt, endedAt } = runTimeBounds(run)
	const elapsedMs = startedAt !== undefined ? (endedAt ?? Date.now()) - startedAt : 0
	const timer = formatToolTimer(elapsedMs)
	const failedCount = countFailedTools(run)
	const failedLabel = failedCount > 0 ? `${failedCount} failed` : ""
	const failedSuffix = failedLabel ? ` · ${failedLabel}` : ""

	const right = theme?.fg?.("dim", "(ctrl+o to expand)") ?? "(ctrl+o to expand)"

	if (isInProgress) {
		const icon = theme?.fg?.("accent", "⟳") ?? "⟳"
		const duration = timer ? ` ${timer}` : ""
		const counts = summaryText ? ` · ${summaryText}` : ""
		view.setHeader(`${icon} Working…${duration}${counts}${failedSuffix}`, right)
		view.setBranchMode((s: string) => theme?.fg?.("borderMuted", s) ?? s)
		view.setExtra([theme?.fg?.("dim", buildCurrentToolLine(last)) ?? buildCurrentToolLine(last)])
	} else {
		const icon = theme?.fg?.("success", "✓") ?? "✓"
		const duration = timer ? `Worked for ${timer}` : "Worked"
		const counts = summaryText ? ` · ${summaryText}` : ""
		view.setHeader(`${icon} ${duration}${counts}${failedSuffix}`, right)
		view.hideDivider()
		view.setBottomRow("", "")
		view.setExtra([])
	}

	return view
}

// ---------------------------------------------------------------------------
// patchToolGroupRendering
// ---------------------------------------------------------------------------

// Symbol key for the render cache managed by tool-rendering.ts — we need to
// bust it when we inject a temporary group view so the real content isn't
// evicted from the cache and the injected lines don't persist across renders.
const TOOL_RENDER_CACHE_KEY = Symbol.for("pi-claude-style-tools:tool-render-cache")

// Render the tool's call (header) region only — suppress the result region —
// using the same temporary contentBox swap + cache bust as the group view.
// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
function renderHeaderOnly(self: any, originalRender: (width: number) => string[], width: number): string[] {
	const contentBox = self.contentBox
	const usingSelf = typeof self.getRenderShell === "function" && self.getRenderShell() === "self"
	if (!contentBox || usingSelf) return originalRender.call(self, width)

	const savedChildren = contentBox.children.slice() as object[]
	if (savedChildren.length === 0) return originalRender.call(self, width)

	contentBox.children = [savedChildren[0]]
	contentBox.invalidate()
	delete self[TOOL_RENDER_CACHE_KEY]
	const result = originalRender.call(self, width)

	contentBox.children = savedChildren
	contentBox.invalidate()
	delete self[TOOL_RENDER_CACHE_KEY]
	return result
}

// Original contentBox cosmetics captured when a group-row swap is applied, so
// they can be restored when the fold no longer applies to this tool.
const groupSwapOriginals = new WeakMap<object, { bgFn: unknown; paddingY: number }>()

function restoreGroupCosmetics(self: any): void {
	const contentBox = self?.contentBox
	if (!contentBox) return
	const saved = groupSwapOriginals.get(contentBox)
	if (!saved) return
	groupSwapOriginals.delete(contentBox)
	contentBox.bgFn = saved.bgFn
	contentBox.paddingY = saved.paddingY
}

/**
 * The group-row swap persists between frames (so mouse hit-testing, which
 * re-renders the CURRENT contentBox children, can reach its MouseRegion).
 * If the fold no longer applies but no updateDisplay ran (e.g. the mode was
 * switched off), rebuild the real call/result regions once.
 */
function ensureOriginalChildren(self: any): void {
	const contentBox = self?.contentBox
	if (!contentBox || !Array.isArray(contentBox.children)) return
	if (contentBox.children.length === 1 && contentBox.children[0] instanceof MouseRegion) {
		restoreGroupCosmetics(self)
		if (typeof self.updateDisplay === "function") self.updateDisplay()
	}
}

export function patchToolGroupRendering(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = ToolExecutionComponent.prototype as any
	if (proto[GROUP_RENDER_PATCH_FLAG]) return

	// Clicking anywhere on a tool that is currently showing the folded group row
	// toggles the whole group. (A MouseRegion inside contentBox is unreachable
	// here: Box hit-testing yields click offsets past the single-row child range,
	// so region handlers never fire — clicks must be handled at the tool.)
	const originalHandleMouse = proto.handleMouse
	proto.handleMouse = function patchedGroupHandleMouse(event: { type?: string; button?: string | number }) {
		const contentBox = (this as any)?.contentBox
		const showingGroupRow = contentBox && groupSwapOriginals.has(contentBox)
		if (
			showingGroupRow &&
			(this as any).result &&
			(this as any).expanded !== true &&
			event?.type === "click" &&
			event?.button === "left"
		) {
			;(this as any).setExpanded(!(this as any).expanded)
			return { handled: true }
		}
		return originalHandleMouse.call(this, event)
	}

	// originalRender resolves via the prototype chain to Container.prototype.render,
	// which has already been patched by tool-rendering.ts to apply the ▍ stroke
	// (via contentBox / Box) and the spacing/border wrapper.  Calling it with a
	// temporarily-swapped contentBox lets us reuse that full pipeline.
	const originalRender = proto.render

	proto.render = function patchedGroupRender(width: number): string[] {
		const parent = getParent(this)
		if (!parent) {
			restoreGroupCosmetics(this)
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}
		const mode = readCollapseWorkMode(process.cwd())
		if (mode === "off") {
			restoreGroupCosmetics(this)
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		const children = parent.children as object[]
		const run = findToolGroup(this, children)
		const selfIdx = children.indexOf(this)

		// A lone tool folds to its header line once a later tool call exists
		// ("collapse work when the next tool call starts").
		if (run.length < 2) {
			// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on ToolExecutionComponent instance
			const self = this as any
			if (
				run.length === 1 &&
				run[0] === this &&
				selfIdx !== -1 &&
				self.isPartial !== true &&
				self.expanded !== true &&
				isSupersededByLaterTool(children, selfIdx)
			) {
				return renderHeaderOnly(self, originalRender, width)
			}
			restoreGroupCosmetics(this)
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		// ctrl+o wires to component.setExpanded() on ALL tools globally.
		// Use the last tool's .expanded field as the group's expand state.
		// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on ToolExecutionComponent instance
		const lastTool = run[run.length - 1] as any
		if (lastTool.expanded === true) {
			restoreGroupCosmetics(this)
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		// The folded row renders through the FIRST tool of the run so that, in
		// "tools" mode, the summary leads and the visible interstitial assistant
		// commentary follows it in place.
		if (run[0] !== this) return []

		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const theme = (this as any).ui?.theme
		const groupView = buildGroupView(run, theme)

		// Inject groupView into contentBox so the full render pipeline applies the
		// ▍ stroke (Box) and spacing/border wrapper (patchedContainerRender).
		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const contentBox = (this as any).contentBox
		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const usingSelf = typeof (this as any).getRenderShell === "function" && (this as any).getRenderShell() === "self"

		if (!contentBox || usingSelf) {
			// Fallback: no contentBox available — return raw lines without stroke.
			return groupView.render(width)
		}

		const isInProgress = lastTool.isPartial === true

		// Capture the pre-fold cosmetics once. The children swap is intentionally
		// LEFT IN PLACE after rendering: the alt-screen mouse hit-test re-renders
		// the CURRENT contentBox children, so a transient swap would make the
		// folded row unclickable. updateDisplay() rebuilds the children on any
		// real mutation, which drops the swap naturally.
		if (!groupSwapOriginals.has(contentBox)) {
			groupSwapOriginals.set(contentBox, { bgFn: contentBox.bgFn, paddingY: contentBox.paddingY as number })
		}
		const groupRow = new MouseRegion(groupView, (event) => {
			if (!lastTool.result || event.type !== "click" || event.button !== "left") return undefined
			lastTool.setExpanded(!lastTool.expanded)
			return { handled: true }
		})

		// Swap in group view with the appropriate accent color and no vertical padding
		// so the group summary takes a single content line instead of three.
		contentBox.children = [groupRow]
		contentBox.bgFn = isInProgress
			? (s: string) => theme?.fg?.("accent", s) ?? s
			: (s: string) => theme?.fg?.("success", s) ?? s
		contentBox.paddingY = 0

		// Bypass render caches so the patched Container render actually runs.
		// biome-ignore lint/suspicious/noExplicitAny: Symbol-keyed cache busting on untyped prototype
		delete (this as any)[TOOL_RENDER_CACHE_KEY]
		contentBox.invalidate()

		const result = originalRender.call(this, width)

		// Bust caches again so the next frame re-renders fresh group content.
		// biome-ignore lint/suspicious/noExplicitAny: Symbol-keyed cache busting on untyped prototype
		delete (this as any)[TOOL_RENDER_CACHE_KEY]

		return result
	}

	proto[GROUP_RENDER_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// Assistant text folding
// ---------------------------------------------------------------------------

const ASSISTANT_FOLD_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-assistant-text-fold")
// OSC 133 shell-integration zone markers — built via RegExp so the control
// characters stay in string escapes (same style as tool-rendering.ts).
const OSC133_ANY_MARKER_RE = /\x1b\]133;[ABC]\x07/g

/** Keep only the shell-integration zone markers so hiding text cannot break zones. */
function markersOnlyLines(lines: string[]): string[] {
	let markers = ""
	for (const line of lines) {
		const found = line.match(OSC133_ANY_MARKER_RE)
		if (found) markers += found.join("")
	}
	return markers ? [markers] : []
}

/**
 * Live theme captured at session_start — used to derive the muted color for
 * assistant commentary in "tools" mode.
 */
let collapseWorkTheme: Theme | undefined

const ANSI_RESET = "\x1b[0m"
const ANSI_DEFAULT_FG = "\x1b[39m"
const OSC133_LEADING_RE = /^(?:\x1b\]133;[ABC]\x07)+/
const OSC133_TRAILING_RE = /(?:\x1b\]133;[ABC]\x07)+$/
const ANSI_FG_RESET_RE = /(\x1b\[0m|\x1b\[39m)/g

/**
 * The "Thought for Xs" label color — calibrated from what the thinking widget
 * actually rendered (sniffed from the label line's SGR sequence), so it matches
 * the visible label exactly regardless of which theme object produced it.
 * Falls back to theme "dim"/"muted" until a label has been seen.
 */
let mutedFgCalibrated: string | null | undefined

function resolveMutedFg(lines: string[]): string | null {
	if (mutedFgCalibrated) return mutedFgCalibrated
	for (const line of lines) {
		// Only completed "Thought for Xs" labels — the streaming "Thinking..."
		// state renders in a different (muted) color.
		const labelIdx = line.search(/Thought for/)
		if (labelIdx === -1) continue
		// The label line also carries the muted ▍ stroke before the text; take the
		// LAST foreground SGR before the label text — that is the label's color.
		const fgRe = /\x1b\[38;2;\d+;\d+;\d+m|\x1b\[38;5;\d+m|\x1b\[3[0-7]m/g
		let last: string | undefined
		for (const m of line.matchAll(fgRe)) {
			if ((m.index ?? 0) >= labelIdx) break
			last = m[0]
		}
		if (last) {
			mutedFgCalibrated = last
			return last
		}
	}
	// Theme fallback is deliberately NOT cached — once a label line shows up in
	// any later render, the sniffed exact color takes over.
	const theme = collapseWorkTheme
	try {
		const dim = theme?.getFgAnsi?.("dim" as Parameters<Theme["getFgAnsi"]>[0])
		if (typeof dim === "string" && dim.length > 0) return dim
		const muted = theme?.getFgAnsi?.("muted" as Parameters<Theme["getFgAnsi"]>[0])
		if (typeof muted === "string" && muted.length > 0) return muted
	} catch {
		/* fall through */
	}
	return null
}

/**
 * Mute assistant commentary lines to the "Thought for Xs" label color
 * (theme "dim"). Embedded ANSI from markdown styling is kept, but the muted
 * foreground is re-asserted after every full/default-fg reset so styled
 * segments return to the subtle color instead of the default one. OSC 133
 * shell-integration markers at line boundaries are preserved untouched.
 */
export function muteAssistantLines(lines: string[], fg: string): string[] {
	if (!fg) return lines
	return lines.map((line) => {
		if (line.trim() === "") return line
		const leading = line.match(OSC133_LEADING_RE)?.[0] ?? ""
		const trailing = line.match(OSC133_TRAILING_RE)?.[0] ?? ""
		let core = line.slice(leading.length, line.length - trailing.length)
		if (core.trim() === "") return line
		core = core.replace(ANSI_FG_RESET_RE, `$1${fg}`)
		return `${leading}${fg}${core}${ANSI_DEFAULT_FG}${trailing}`
	})
}

function patchAssistantTextFolding(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = AssistantMessageComponent.prototype as any
	if (proto[ASSISTANT_FOLD_PATCH_FLAG]) return
	const originalRender = proto.render
	proto[ASSISTANT_FOLD_PATCH_FLAG] = true
	if (typeof originalRender !== "function") return

	proto.render = function patchedAssistantTextFoldRender(width: number): string[] {
		const lines = originalRender.call(this, width)
		if (!Array.isArray(lines) || lines.length === 0) return lines
		const mode = readCollapseWorkMode(process.cwd())
		if (mode === "off") return lines
		// Opportunistic calibration on every assistant render — the label shows up
		// in any message's thinking widget, fold-eligible or not.
		resolveMutedFg(lines)
		const parent = getParent(this)
		if (!parent) return lines
		const children = parent.children as object[]
		const selfIdx = children.indexOf(this)
		if (selfIdx === -1) return lines

		const decision = decideAssistantTextFold(children, selfIdx)
		if (!decision.fold) return lines
		// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on ToolExecutionComponent instance
		const controller = decision.expandController as any
		if (controller?.expanded === true) return lines

		// "all": fold commentary away entirely. "tools": keep it in the timeline
		// but mute it to the thinking-label color so it reads as secondary.
		const mutedFg = resolveMutedFg(lines)
		if (readCollapseWorkMode(process.cwd()) === "tools") {
			return muteAssistantLines(lines, mutedFg ?? "")
		}
		return markersOnlyLines(lines)
	}
}

// ---------------------------------------------------------------------------
// Expand propagation (click on a folded row toggles the whole group)
// ---------------------------------------------------------------------------

const SET_EXPANDED_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-set-expanded")
const propagationGuard = new WeakSet<object>()

function patchSetExpandedPropagation(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = ToolExecutionComponent.prototype as any
	if (proto[SET_EXPANDED_PATCH_FLAG]) return
	const original = proto.setExpanded
	proto[SET_EXPANDED_PATCH_FLAG] = true
	if (typeof original !== "function") return

	proto.setExpanded = function patchedSetExpanded(expanded: boolean): void {
		original.call(this, expanded)
		if (propagationGuard.has(this)) return
		if (readCollapseWorkMode(process.cwd()) === "off") return
		const parent = getParent(this)
		if (!parent) return
		const run = findToolGroup(this, parent.children as object[])
		// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on ToolExecutionComponent instance
		const targets = computeExpandPropagation(run, this as any, expanded)
		if (targets.length === 0) return
		propagationGuard.add(this)
		try {
			for (const target of targets) {
				const t = target as { expanded?: boolean; setExpanded?: (v: boolean) => void }
				if (typeof t.setExpanded === "function" && t.expanded !== expanded) {
					t.setExpanded(expanded)
				}
			}
		} finally {
			propagationGuard.delete(this)
		}
	}
}

// ---------------------------------------------------------------------------
// /settings entry — "Collapse work" in the upstream settings selector
// ---------------------------------------------------------------------------

const SETTINGS_ENTRY_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-settings-selector")
const COLLAPSE_WORK_ITEM_ID = "collapse-work"

interface SettingsListItem {
	id: string
	label: string
	description: string
	currentValue: string
	values: string[]
}

/**
 * The upstream settings selector builds its item list and change dispatch
 * inside its constructor, then addChild()s the SettingsList. We hook the
 * global addChild (already patched for parent tracking) and, whenever a
 * SettingsList is attached to a SettingsSelectorComponent, append our entry
 * and wrap the change callback to persist the mode.
 */
function maybeInjectCollapseWorkSetting(parent: object, child: object): void {
	if (!(parent instanceof SettingsSelectorComponent)) return
	if (!child || typeof child !== "object") return
	const list = child as { items?: unknown; onChange?: unknown }
	if (!Array.isArray(list.items) || typeof list.onChange !== "function") return

	const items = list.items as SettingsListItem[]
	if (items.some((item) => item?.id === COLLAPSE_WORK_ITEM_ID)) return

	items.push({
		id: COLLAPSE_WORK_ITEM_ID,
		label: "Collapse work",
		description:
			"Fold completed tool calls into a 'Worked for Xs' row. 'all' also folds interstitial assistant commentary; 'tools' keeps text and thinking visible.",
		currentValue: readCollapseWorkMode(process.cwd()),
		values: ["all", "tools", "off"],
	})

	const originalOnChange = list.onChange as (id: string, newValue: string) => void
	list.onChange = (id: string, newValue: string) => {
		if (id === COLLAPSE_WORK_ITEM_ID) {
			if (newValue === "all" || newValue === "tools" || newValue === "off") {
				writeCollapseWorkMode(newValue)
			}
			return
		}
		originalOnChange(id, newValue)
	}
}

function patchSettingsSelectorEntry(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = Container.prototype as any
	if (proto[SETTINGS_ENTRY_PATCH_FLAG]) return
	const original = proto.addChild
	proto[SETTINGS_ENTRY_PATCH_FLAG] = true
	if (typeof original !== "function") return

	proto.addChild = function patchedAddChildSettingsEntry(child: object) {
		const result = original.call(this, child)
		try {
			maybeInjectCollapseWorkSetting(this, child)
		} catch {
			// Settings injection must never break rendering.
		}
		return result
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function registerToolGrouping(pi: ExtensionAPI): void {
	patchAddChild()
	patchToolGroupRendering()
	patchAssistantTextFolding()
	patchSetExpandedPropagation()
	patchSettingsSelectorEntry()

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) collapseWorkTheme = ctx.ui.theme
	})
}
