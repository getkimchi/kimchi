import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import {
	AssistantMessageComponent,
	SettingsSelectorComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent"
import { Container, MouseRegion, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { formatToolTimer } from "./tool-rendering.js"
import {
	type CollapseWorkMode,
	isCollapseWorkOverriddenByProject,
	readCollapseWorkMode,
	resolveCollapseWorkProjectTrust,
	writeCollapseWorkMode,
} from "./work-collapse-settings.js"

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

// The prototype patches below are installed process-wide, so every global in
// this module assumes a SINGLE interactive session per process: `session_start`
// resets all of them (cwd, settings cache, muted-colour calibration, turn
// boundary) so a new session can never inherit the previous one's state.

/** Session cwd captured at `session_start`; `process.cwd()` only before that. */
let sessionCwd: string | undefined

/** `ctx.ui.notify`, captured at `session_start` for `/settings` write failures. */
let sessionNotify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined

/** Live theme captured at `session_start` and refreshed whenever a render sees a different one. */
let collapseWorkTheme: Theme | undefined

/** Muted colour calibrated against `collapseWorkTheme` (see `resolveMutedFg`). */
let mutedFgCalibrated: string | null | undefined

interface CollapseWorkModeCache {
	cwd: string
	projectTrusted: boolean
	mode: CollapseWorkMode
	timestamp: number
}

/** Resolved mode — keeps the render path free of per-component settings reads. */
let collapseWorkModeCache: CollapseWorkModeCache | undefined
let collapseWorkTrustCache: { cwd: string; trusted: boolean } | undefined

/**
 * Mirrors the settings module's own file TTL: after this window we re-resolve
 * (at worst one synchronous read per window, never per component per frame).
 */
const COLLAPSE_WORK_MODE_TTL_MS = 5_000

function currentSessionCwd(): string {
	return sessionCwd ?? process.cwd()
}

function projectTrustedFor(cwd: string): boolean {
	if (collapseWorkTrustCache?.cwd === cwd) return collapseWorkTrustCache.trusted
	const trusted = resolveCollapseWorkProjectTrust(cwd)
	collapseWorkTrustCache = { cwd, trusted }
	return trusted
}

/**
 * Effective collapse mode for the current session.
 *
 * Memoized per (cwd, project-trust). Every tool/assistant component asks for it
 * on every frame, but only the first caller in a TTL window — or the first
 * after a write / `session_start` — reads the settings files.
 */
export function getCollapseWorkMode(): CollapseWorkMode {
	const cwd = currentSessionCwd()
	const projectTrusted = projectTrustedFor(cwd)
	const now = Date.now()
	const cached = collapseWorkModeCache
	if (
		cached &&
		cached.cwd === cwd &&
		cached.projectTrusted === projectTrusted &&
		now - cached.timestamp < COLLAPSE_WORK_MODE_TTL_MS
	) {
		return cached.mode
	}
	const mode = readCollapseWorkMode(cwd, { projectTrusted })
	collapseWorkModeCache = { cwd, projectTrusted, mode, timestamp: now }
	return mode
}

/** Drop every memoized settings value — call after a write or a cwd change. */
export function invalidateCollapseWorkModeCache(): void {
	collapseWorkModeCache = undefined
}

/** Reset every session-scoped global. Called from `session_start` (and tests). */
export function resetToolGroupingSessionState(cwd?: string): void {
	sessionCwd = cwd
	sessionNotify = undefined
	collapseWorkModeCache = undefined
	collapseWorkTrustCache = undefined
	mutedFgCalibrated = undefined
	mutedLinesCache = new WeakMap()
}

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
	operation: (n) => `ran ${n} ${n === 1 ? "operation" : "operations"}`,
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

/**
 * True when a later tool of the SAME run follows `selfIdx` — interleaved text and
 * spacers don't block, but a run breaker (user message, images, …) does. Matching
 * `findRunSpan`'s forward walk keeps the two scans consistent: a lone tool from a
 * previous turn is never "superseded" by the next turn's tools.
 */
export function isSupersededByLaterTool(children: object[], selfIdx: number): boolean {
	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (isToolLike(child)) return true
		if (breaksRun(child)) return false
	}
	return false
}

export interface AssistantFoldDecision {
	/** Fold only when strictly between two tools of the same run. */
	fold: boolean
	/** Nearest later tool — its `expanded` flag controls the group's expand state. */
	expandController: object | undefined
	/** Nearest earlier tool, so callers can keep narration visible while work runs. */
	prevTool: object | undefined
}

export function decideAssistantTextFold(children: object[], selfIdx: number): AssistantFoldDecision {
	let prevTool: object | undefined
	for (let i = selfIdx - 1; i >= 0; i--) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (isToolLike(child)) {
			prevTool = child
			break
		}
		if (breaksRun(child)) break
	}
	if (!prevTool) return { fold: false, expandController: undefined, prevTool: undefined }

	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		if (isToolLike(child)) {
			return { fold: true, expandController: child, prevTool }
		}
	}
	return { fold: false, expandController: undefined, prevTool }
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

export function buildGroupView(run: object[], theme: any): ToolBlockView {
	const view = new ToolBlockView()
	const running = run.find((member) => (member as any).isPartial === true) as any
	const isInProgress = running !== undefined
	const summaryText = buildGroupSummaryText(run, isInProgress)

	// "Worked for Xs" spans the whole run: first start → last end. While any member
	// is still running the run has no end yet, so the timer must advance live —
	// otherwise a finished member's `_executionEndedAt` would freeze the clock.
	const { startedAt, endedAt } = runTimeBounds(run)
	const end = isInProgress ? Date.now() : (endedAt ?? Date.now())
	const elapsedMs = startedAt !== undefined ? end - startedAt : 0
	const timer = formatToolTimer(elapsedMs)
	const failedCount = countFailedTools(run)
	const failedText = failedCount > 0 ? `${failedCount} failed ${failedCount === 1 ? "call" : "calls"}` : ""
	// Failures must not read as success: the suffix is error-coloured so it never
	// blends into the muted counts, and the glyph below changes with it.
	const failedSuffix = failedText ? ` · ${theme?.fg?.("error", failedText) ?? failedText}` : ""

	const right = theme?.fg?.("dim", "(ctrl+o to expand)") ?? "(ctrl+o to expand)"

	if (isInProgress) {
		const icon = theme?.fg?.("accent", "⟳") ?? "⟳"
		const duration = timer ? `Working for ${timer}` : "Working…"
		const counts = summaryText ? ` · ${summaryText}` : ""
		view.setHeader(`${icon} ${duration}${counts}${failedSuffix}`, right)
		view.setBranchMode((s: string) => theme?.fg?.("borderMuted", s) ?? s)
		// The running tool renders its own live output below the row.
		view.setExtra([])
	} else {
		// A failed run gets an error glyph: a green ✓ next to "1 failed call" is
		// the one signal a user scans for when something went wrong.
		const icon = failedCount > 0 ? (theme?.fg?.("error", "✗") ?? "✗") : (theme?.fg?.("success", "✓") ?? "✓")
		const duration = timer ? `Worked for ${timer}` : "Done"
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

// Original contentBox cosmetics captured when a fold swap is applied, so they can
// be restored when the fold no longer applies to this tool. Also the ownership
// marker for a contentBox whose children were swapped by a fold (group row or
// header-only row).
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
 * The fold swap persists between frames (so mouse hit-testing, which
 * re-renders the CURRENT contentBox children, can reach its MouseRegion).
 * If the fold no longer applies but no updateDisplay ran (e.g. the mode was
 * switched off, or the group was expanded), rebuild the real call/result
 * regions once.
 *
 * This helper owns the ownership check, so every call site just calls it:
 * there is no separately-readable "is a swap applied?" state afterwards.
 */
export function ensureOriginalChildren(self: any): void {
	// Self-shell path: upstream rebuilds selfRenderContainer.children on every
	// updateDisplay(), so dropping the swap marker is enough. If the rebuild
	// fails, re-arm so a later frame retries instead of latching the fold.
	const selfContainer = self?.selfRenderContainer
	if (selfContainer && groupSwapOriginals.has(selfContainer)) {
		const saved = groupSwapOriginals.get(selfContainer)
		groupSwapOriginals.delete(selfContainer)
		if (typeof self.updateDisplay === "function") {
			try {
				self.updateDisplay()
			} catch {
				if (saved) groupSwapOriginals.set(selfContainer, saved)
			}
		}
		return
	}

	const contentBox = self?.contentBox
	if (!contentBox) return
	const saved = groupSwapOriginals.get(contentBox)
	if (!saved) return
	restoreGroupCosmetics(self) // deletes the entry
	try {
		if (typeof self.updateDisplay === "function") self.updateDisplay()
	} catch {
		// Re-arm the marker so a later frame retries the rebuild instead of
		// leaving the folded shape latched forever.
		groupSwapOriginals.set(contentBox, saved)
	}
}

export function patchToolGroupRendering(): void {
	const proto = ToolExecutionComponent.prototype as any
	if (proto[GROUP_RENDER_PATCH_FLAG]) return

	// Clicking anywhere on a tool that is currently showing the folded group row
	// toggles the whole group. (A MouseRegion inside contentBox is unreachable
	// here: Box hit-testing yields click offsets past the single-row child range,
	// so region handlers never fire — clicks must be handled at the tool.)
	const originalHandleMouse = proto.handleMouse
	if (typeof originalHandleMouse !== "function") return // retried by the next registration
	proto.handleMouse = function patchedGroupHandleMouse(event: { type?: string; button?: string | number }) {
		// Self-shell groups swap selfRenderContainer.children; the regular path
		// swaps contentBox.children. Both register in groupSwapOriginals.
		const selfContainer = (this as any)?.selfRenderContainer
		const contentBox = (this as any)?.contentBox
		const showingGroupRow =
			(selfContainer && groupSwapOriginals.has(selfContainer)) || (contentBox && groupSwapOriginals.has(contentBox))
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

	const patchedGroupRenderInner = function (this: any, width: number): string[] {
		const parent = getParent(this)
		if (!parent) {
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}
		const mode = getCollapseWorkMode()
		if (mode === "off") {
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		const children = parent.children as object[]
		const run = findToolGroup(this, children)

		// A lone completed tool renders normally until the next tool call arrives:
		// that call becomes a run member above, so the whole completed run folds
		// into the usual group row. There is no distinct singleton fold to reach,
		// and user messages already bound runs, so previous turns stay intact.
		if (run.length < 2) {
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		// ctrl+o wires to component.setExpanded() on ALL tools globally.
		// Use the last tool's .expanded field as the group's expand state.
		const lastTool = run[run.length - 1] as any
		if (lastTool.expanded === true) {
			ensureOriginalChildren(this)
			return originalRender.call(this, width)
		}

		// The folded row renders through the first completed tool of the run so
		// that, in "tools" mode, the summary leads the visible narration. A
		// still-running tool keeps rendering its own live output below the row
		// (watching a long command must never require expanding the group).
		// While EVERY member is still running there is nothing completed to
		// summarize — show the real rows instead of a folded shell.
		const firstNonPartial = run.find((member) => (member as any).isPartial !== true)
		if (!firstNonPartial) return originalRender.call(this, width)
		const rowTool = firstNonPartial
		if (rowTool !== this) {
			if ((this as any).isPartial === true) return originalRender.call(this, width)
			return []
		}

		const theme = (this as any).ui?.theme
		const groupView = buildGroupView(run, theme)

		// Inject groupView into contentBox so the full render pipeline applies the
		// ▍ stroke (Box) and spacing/border wrapper (patchedContainerRender).
		const contentBox = (this as any).contentBox
		const usingSelf = typeof (this as any).getRenderShell === "function" && (this as any).getRenderShell() === "self"

		if (!contentBox || usingSelf) {
			// Self-shell renderers (e.g. MCP's compact default) draw their own
			// chrome, so substitute a framed group row there too: a spacer line up
			// top (the spinner must not be glued to its label), the group view with
			// a MouseRegion, and the swap markers the tool-level click handler and
			// `ensureOriginalChildren` use. contentBox ALWAYS exists but must not be
			// used here — upstream takes its self path, not contentBox.
			const selfContainer = (this as any).selfRenderContainer
			if (!usingSelf || !selfContainer || !Array.isArray(selfContainer.children)) {
				return ["", ...groupView.render(width)]
			}

			const selfState = selfContainer
			if (!groupSwapOriginals.has(selfState)) {
				groupSwapOriginals.set(selfState, { bgFn: (selfState as any).bgFn, paddingY: 0 })
			}
			selfState.children = [
				new MouseRegion(groupView, (event: any) => {
					if (!lastTool.result || event.type !== "click" || event.button !== "left") return undefined
					lastTool.setExpanded(!lastTool.expanded)
					return { handled: true }
				}),
			]
			const lines = originalRender.call(this, width)
			delete (this as any)[TOOL_RENDER_CACHE_KEY]
			return ["", ...lines]
		}

		const isInProgress = run.some((member) => (member as any).isPartial === true)

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
		const failedInRun = run.some((member) => isFailedTool(member))
		contentBox.bgFn = isInProgress
			? (s: string) => theme?.fg?.("accent", s) ?? s
			: failedInRun
				? (s: string) => theme?.fg?.("error", s) ?? s
				: (s: string) => theme?.fg?.("success", s) ?? s
		contentBox.paddingY = 0

		// The folded row is rebuilt from live state every frame (the timer
		// advances), so exactly one bust before rendering is enough — the next
		// frame busts again and can never be served a stale cache entry.
		delete (this as any)[TOOL_RENDER_CACHE_KEY]
		contentBox.invalidate()

		// The upstream self path already emits a leading spacer line before its
		// tool chrome; without it the spinner ends up flush against the header
		// ("▍ ⟳Working for…" reads as if there were no space after ⟳).
		return ["", ...originalRender.call(this, width)]
	}

	proto.render = function patchedGroupRender(width: number): string[] {
		try {
			return patchedGroupRenderInner.call(this, width)
		} catch {
			try {
				ensureOriginalChildren(this)
			} catch {
				/* ignore */
			}
			return originalRender.call(this, width)
		}
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

const ANSI_DEFAULT_FG = "\x1b[39m"
const OSC133_LEADING_RE = /^(?:\x1b\]133;[ABC]\x07)+/
const OSC133_TRAILING_RE = /(?:\x1b\]133;[ABC]\x07)+$/
const ANSI_FG_RESET_RE = /(\x1b\[0m|\x1b\[39m)/g

/** Memo for {@link muteAssistantLines} — re-muting the same rendered lines is wasted work. */
let mutedLinesCache = new WeakMap<string[], { fg: string; lines: string[] }>()

function themeForeground(theme: Theme | undefined): string | null {
	for (const key of ["dim", "muted"] as const) {
		try {
			const ansi = theme?.getFgAnsi?.(key as Parameters<Theme["getFgAnsi"]>[0])
			if (typeof ansi === "string" && ansi.length > 0) return ansi
		} catch {
			/* try the next key */
		}
	}
	return null
}

/**
 * The "Thought for Xs" label colour for assistant commentary in "tools" mode.
 *
 * The live theme is authoritative: `getFgAnsi("dim")` follows the current
 * palette, so a theme switch is picked up on the next render. The rendered-label
 * sniff below is only a fallback for themes that expose no ANSI colour, and its
 * value is dropped whenever the theme instance changes (a dark grey calibrated
 * on a dark theme is invisible on a light one).
 */
function resolveMutedFg(lines: string[], liveTheme?: Theme): string | null {
	const theme = liveTheme ?? collapseWorkTheme
	if (theme !== collapseWorkTheme) {
		// Theme switched (or first seen) — recalibrate against the new palette.
		collapseWorkTheme = theme
		mutedFgCalibrated = undefined
		mutedLinesCache = new WeakMap()
	}
	const themeFg = themeForeground(theme)
	if (themeFg) return themeFg
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
	const cached = mutedLinesCache.get(lines)
	if (cached && cached.fg === fg) return cached.lines
	const muted = lines.map((line) => {
		if (line.trim() === "") return line
		const leading = line.match(OSC133_LEADING_RE)?.[0] ?? ""
		const trailing = line.match(OSC133_TRAILING_RE)?.[0] ?? ""
		let core = line.slice(leading.length, line.length - trailing.length)
		if (core.trim() === "") return line
		core = core.replace(ANSI_FG_RESET_RE, `$1${fg}`)
		return `${leading}${fg}${core}${ANSI_DEFAULT_FG}${trailing}`
	})
	mutedLinesCache.set(lines, { fg, lines: muted })
	return muted
}

function patchAssistantTextFolding(): void {
	const proto = AssistantMessageComponent.prototype as any
	if (proto[ASSISTANT_FOLD_PATCH_FLAG]) return
	const originalRender = proto.render
	if (typeof originalRender !== "function") return
	proto.render = function patchedAssistantTextFoldRender(width: number): string[] {
		const lines = originalRender.call(this, width)
		if (!Array.isArray(lines) || lines.length === 0) return lines
		const mode = getCollapseWorkMode()
		if (mode === "off") return lines
		// Resolved once per render: this is both the opportunistic calibration
		// pass (the label shows up in any message's thinking widget, fold-eligible
		// or not) and the muted colour this frame uses.
		const mutedFg = resolveMutedFg(lines, (this as any).ui?.theme)
		const parent = getParent(this)
		if (!parent) return lines
		const children = parent.children as object[]
		const selfIdx = children.indexOf(this)
		if (selfIdx === -1) return lines

		// Only interstitial commentary between two completed tools of the same
		// run folds. User messages already break runs, so previous turns' final
		// answers are safe without a wall-clock cutoff (turn_start fires for
		// every model/tool cycle, which would wrongly exclude live commentary).
		const decision = decideAssistantTextFold(children, selfIdx)
		if (!decision.fold) return lines
		// Live narration while work is still running must stay visible — keeping
		// the user oriented matters more than compressing in-flight steps.
		if ((decision.prevTool as any)?.isPartial === true) return lines
		const controller = decision.expandController as any
		if (controller?.expanded === true) return lines
		if (controller?.isPartial === true) return lines

		// "all": fold commentary away entirely. "tools": keep it in the timeline
		// but mute it to the thinking-label color so it reads as secondary.
		if (mode === "tools") {
			return muteAssistantLines(lines, mutedFg ?? "")
		}
		return markersOnlyLines(lines)
	}
	proto[ASSISTANT_FOLD_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// Expand propagation (click on a folded row toggles the whole group)
// ---------------------------------------------------------------------------

const SET_EXPANDED_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-set-expanded")
const propagationGuard = new WeakSet<object>()

function patchSetExpandedPropagation(): void {
	const proto = ToolExecutionComponent.prototype as any
	if (proto[SET_EXPANDED_PATCH_FLAG]) return
	const original = proto.setExpanded
	if (typeof original !== "function") return

	proto.setExpanded = function patchedSetExpanded(expanded: boolean): void {
		original.call(this, expanded)
		if (propagationGuard.has(this)) return
		if (getCollapseWorkMode() === "off") return
		const parent = getParent(this)
		if (!parent) return
		const run = findToolGroup(this, parent.children as object[])
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
	proto[SET_EXPANDED_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// /settings entry — "Collapse work" in the upstream settings selector
// ---------------------------------------------------------------------------

const SETTINGS_ENTRY_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-settings-selector")
const COLLAPSE_WORK_ITEM_ID = "collapse-work"
const COLLAPSE_WORK_DESCRIPTION =
	"Fold finished tool calls into one summary row. 'all': also hide the notes the agent writes between calls. 'tools': fold tool calls but keep those notes. 'off': show every step in full."
const COLLAPSE_WORK_OVERRIDE_SUFFIX = " (overridden by .kimchi/settings.json)"
const COLLAPSE_WORK_VALUES = ["all", "tools", "off"] as const

interface SettingsListItem {
	id: string
	label: string
	description: string
	currentValue: string
	values: string[]
}

let writeErrorReported = false

function reportCollapseWorkWriteError(error: string): void {
	if (sessionNotify) {
		try {
			sessionNotify(`Could not save "Collapse work": ${error}`, "error")
			return
		} catch {
			/* fall through to the console */
		}
	}
	if (writeErrorReported) return
	writeErrorReported = true
	console.error(`[kimchi] could not save "collapseWork": ${error}`)
}

/**
 * Append the "Collapse work" row to an upstream `SettingsList` and wrap its
 * change callback so the value is persisted. Returns whether the row was added.
 *
 * Duck-typed on `{ items, onChange }` (which a real `SettingsList` satisfies) so
 * the injection can be unit-tested without constructing the whole
 * `SettingsSelectorComponent`. The `instanceof SettingsSelectorComponent` check
 * lives in the addChild patch below.
 */
export function maybeInjectCollapseWorkSetting(list: unknown): boolean {
	if (!list || typeof list !== "object") return false
	const candidate = list as { items?: unknown; onChange?: unknown }
	if (!Array.isArray(candidate.items) || typeof candidate.onChange !== "function") return false

	const items = candidate.items as SettingsListItem[]
	if (items.some((item) => item?.id === COLLAPSE_WORK_ITEM_ID)) return false

	const cwd = currentSessionCwd()
	const projectTrusted = projectTrustedFor(cwd)
	// A project override wins over the global file: say so, otherwise the row
	// looks like a control that does nothing.
	const overridden = isCollapseWorkOverriddenByProject(cwd, { projectTrusted })

	items.push({
		id: COLLAPSE_WORK_ITEM_ID,
		label: "Collapse work",
		description: overridden
			? `${COLLAPSE_WORK_DESCRIPTION}${COLLAPSE_WORK_OVERRIDE_SUFFIX}`
			: COLLAPSE_WORK_DESCRIPTION,
		currentValue: getCollapseWorkMode(),
		values: [...COLLAPSE_WORK_VALUES],
	})

	const originalOnChange = candidate.onChange as (id: string, newValue: string) => void
	candidate.onChange = (id: string, newValue: string) => {
		if (id !== COLLAPSE_WORK_ITEM_ID) {
			originalOnChange(id, newValue)
			return
		}
		if (newValue !== "all" && newValue !== "tools" && newValue !== "off") return
		// The write path lands in the project file when it already overrides the
		// mode and the project is trusted, so cycling is never a silent no-op.
		const result = writeCollapseWorkMode(newValue, { cwd, projectTrusted })
		invalidateCollapseWorkModeCache()
		if (!result.ok) {
			// SettingsList.activateItem() already flipped currentValue to the unsaved
			// choice; pin it back to the mode that is actually still in effect.
			const failedItem = items.find((item) => item?.id === COLLAPSE_WORK_ITEM_ID)
			if (failedItem) failedItem.currentValue = getCollapseWorkMode()
			reportCollapseWorkWriteError(result.error)
		} else {
			writeErrorReported = false
		}
	}
	return true
}

function patchSettingsSelectorEntry(): void {
	const proto = Container.prototype as any
	if (proto[SETTINGS_ENTRY_PATCH_FLAG]) return
	const original = proto.addChild
	if (typeof original !== "function") return

	proto.addChild = function patchedAddChildSettingsEntry(child: object) {
		const result = original.call(this, child)
		try {
			if (this instanceof SettingsSelectorComponent) maybeInjectCollapseWorkSetting(child)
		} catch {
			// Settings injection must never break rendering.
		}
		return result
	}
	proto[SETTINGS_ENTRY_PATCH_FLAG] = true
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
		// The patches are process-wide, so session-scoped state is reset here (and
		// documented as single-session) instead of being keyed by session id.
		resetToolGroupingSessionState(ctx.cwd)
		collapseWorkTheme = ctx.hasUI ? ctx.ui.theme : undefined
		sessionNotify = ctx.hasUI ? (message, type) => ctx.ui.notify(message, type) : undefined
		writeErrorReported = false
	})
}
