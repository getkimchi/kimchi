import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import {
	isKeyRelease,
	Key,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui"
import { parseTodoScopeKey } from "./scope.js"
import { GLOBAL_TODO_SCOPE, getTodoCountsForScope, getTodoState } from "./store.js"
import type { TodoCounts, TodoItem, TodoScope, TodoStatus } from "./types.js"

export const TODO_SHORTCUT = Key.f7
export const TODO_SHORTCUT_HINT = "F7"

const TODO_WIDGET_KEY = "kimchi-todos"
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const TODO_STATUS_KEY = "todos"
const SCROLL_HINT_TEXT = "scroll"
const MAX_TODO_WIDGET_LINES = 14
const TODO_WIDGET_BODY_LINES = 10
const MAX_ROLLED_CONTEXT_ROWS = 2
/** Fraction of terminal rows the expanded strip may occupy before ambient auto-collapse. */
const TODO_HEIGHT_COLLAPSE_FRACTION = 0.25
/** Match Agents strip spinner frames (avoid importing agent-widget — circular). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
/** Keep this well above tool/status spinners' cadence — each tick force-renders
 *  the whole TUI, and an 80ms loop pushed tui-e2e past the 25m job budget. */
export const SPINNER_INTERVAL_MS = 200

/** Default auto-collapse threshold: lists with more items than this render
 *  ambiently as a single status line until the user expands them. Mirrors the
 *  opencode-todolist plugin's `collapseThreshold` setting. */
const DEFAULT_TODO_AUTO_COLLAPSE_THRESHOLD = 5

/** Item count past which the ambient todo strip auto-collapses to a single
 *  status line. Configurable via KIMCHI_TODOS_COLLAPSE_THRESHOLD; values < 1
 *  fall back to the default, and a very large value effectively disables
 *  count-based auto-collapse. Height-based collapse (~25% of terminal rows)
 *  still applies. Explicit expansion (F7 / `/todos expand`) always overrides. */
export function getTodoAutoCollapseThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.KIMCHI_TODOS_COLLAPSE_THRESHOLD
	if (raw === undefined) return DEFAULT_TODO_AUTO_COLLAPSE_THRESHOLD
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TODO_AUTO_COLLAPSE_THRESHOLD
	return parsed
}

const TODO_SYMBOL: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▶",
	blocked: "!",
	completed: "✓",
}

interface TodoWidgetState {
	visible: boolean
	/** Uncapped view: show every row (`/todos expand all`). */
	expanded: boolean
	/** User override: show the list body even past the auto-collapse threshold. */
	listExpanded: boolean
	/** User override (mouse click): keep only the one-line header, even at or
	 *  below the auto-collapse threshold. Cleared by any explicit expand. */
	listCollapsed: boolean
	/** Index into the full body row list for the scrollable viewport. */
	scrollOffset: number
	/** True once the user scrolls; disables auto-follow of the active todo. */
	userScrolled: boolean
	collapsed: boolean
	registered: boolean
	registrationId: number
	spinnerFrame: number
	spinnerTimer?: ReturnType<typeof setInterval>
	ctx?: ExtensionContext
	tui?: {
		requestRender?: (force?: boolean) => void
		terminal?: { rows?: number }
	}
}

const todoWidgetStates = new Map<string, TodoWidgetState>()

/** Reasons the above-editor strip should stay collapsed (agents, questionnaire,
 *  etc.). Counted as a set so overlapping UIs don't release early. */
const todoCrowdingReasons = new Set<string>()

export function isTodoCrowdingActive(): boolean {
	return todoCrowdingReasons.size > 0
}

/** Force the todo list body closed while competing above-editor UI is visible.
 *  Clears any prior expand override so the strip shrinks immediately; the user
 *  can still F7/`/todos` expand while crowded. Call with `active: false` when
 *  the competing UI dismisses. */
export function setTodoCrowding(reason: string, active: boolean): void {
	if (!reason) return
	const wasCrowded = todoCrowdingReasons.size > 0
	if (active) todoCrowdingReasons.add(reason)
	else todoCrowdingReasons.delete(reason)
	const isCrowded = todoCrowdingReasons.size > 0
	if (wasCrowded === isCrowded) return

	for (const state of todoWidgetStates.values()) {
		if (isCrowded) {
			state.listExpanded = false
			state.expanded = false
		}
		state.tui?.requestRender?.(true)
	}
}

export async function withTodoCrowding<T>(reason: string, fn: () => Promise<T>): Promise<T> {
	setTodoCrowding(reason, true)
	try {
		return await fn()
	} finally {
		setTodoCrowding(reason, false)
	}
}

/** Test-only: clear crowding reasons between cases. */
export function __resetTodoCrowding(): void {
	todoCrowdingReasons.clear()
}

function createTodoWidgetState(): TodoWidgetState {
	return {
		visible: false,
		expanded: false,
		listExpanded: false,
		listCollapsed: false,
		scrollOffset: 0,
		userScrolled: false,
		collapsed: false,
		registered: false,
		registrationId: 0,
		spinnerFrame: 0,
	}
}

function getTodoWidgetState(ctx: ExtensionContext): TodoWidgetState {
	const sessionId = ctx.sessionManager.getSessionId()
	let state = todoWidgetStates.get(sessionId)
	if (!state) {
		state = createTodoWidgetState()
		todoWidgetStates.set(sessionId, state)
	}
	return state
}

export function summarizeTodoCounts(counts: TodoCounts): string {
	if (counts.total === 0) return "No todos"
	const blocked = counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""
	return `${counts.completed}/${counts.total} done${blocked}`
}

/** Single-line strip header:
 *  `<marker> Todos[ · <scope>] · <done>/<total>[ ✓][ · ⠋ N running][ · N blocked] (F7)`
 *  Marker mirrors the agents widget: `●` collapsed (live or not), `▼` expanded.
 *  In-progress item rows animate with the same braille spinner as the header. */
export function buildTodoHeaderLine(
	theme: Theme,
	counts: TodoCounts,
	collapsed: boolean,
	options: {
		scopeLabel?: string
		spinnerFrame?: number
	} = {},
): string {
	const chevron = collapsed ? "●" : "▼"
	const live = counts.inProgress > 0
	const title = `${chevron} Todos`
	const parts = [theme.fg(live ? "accent" : "dim", title)]
	if (options.scopeLabel) parts.push(theme.fg("dim", options.scopeLabel))
	const countsText = `${counts.completed}/${counts.total}`
	const allDone = counts.total > 0 && counts.completed === counts.total
	parts.push(theme.fg("dim", countsText) + (allDone ? ` ${theme.fg("success", "✓")}` : ""))
	let line = parts.join(" · ")
	if (live) {
		const frame = SPINNER[(options.spinnerFrame ?? 0) % SPINNER.length]
		line += theme.fg("accent", ` · ${frame} ${counts.inProgress} running`)
	}
	if (counts.blocked > 0) {
		line += theme.fg("warning", ` · ${counts.blocked} blocked`)
	}
	const verb = collapsed ? "expand" : "collapse"
	line += ` ${theme.fg("dim", `(${TODO_SHORTCUT_HINT} to ${verb})`)}`
	return line
}

interface CollapseInput {
	expanded: boolean
	listExpanded: boolean
	listCollapsed: boolean
	total: number
	/** Estimated expanded strip height in rows (header + body). */
	expandedHeight: number
	terminalRows?: number
}

/** True when the strip should render only the collapsed one-line header:
 *  competing UI is crowding the strip, the user clicked it shut, the list
 *  exceeds the item-count threshold, or the expanded height would exceed ~25%
 *  of the terminal. Explicit expand overrides ambient collapse. */
function isTodoBodyCollapsed(input: CollapseInput): boolean {
	if (input.expanded || input.listExpanded) return false
	if (isTodoCrowdingActive() || input.listCollapsed) return true
	if (input.total > getTodoAutoCollapseThreshold()) return true
	const rows = input.terminalRows
	if (rows && rows > 0) {
		const maxHeight = Math.max(1, Math.floor(rows * TODO_HEIGHT_COLLAPSE_FRACTION))
		if (input.expandedHeight > maxHeight) return true
	}
	return false
}

function hasActiveTodos(counts: TodoCounts): boolean {
	return counts.pending + counts.inProgress + counts.blocked > 0
}

export function summarizeTodos(sessionId: string): string {
	return summarizeTodoCounts(getTodoCountsForScope(GLOBAL_TODO_SCOPE, sessionId))
}

/** Render a single todo line in the widget strip. No row number: a fixed
 *  5-column indent is used so symbol + text stay in the same columns as
 *  before and truncation math is unchanged. Row numbers are still available
 *  for the notify output — see `numberedTodoLine()`. */
function todoLine(todo: TodoItem, _displayIndex: number, theme: Theme, scope: TodoScope, spinnerFrame: number): string {
	const symbol = todo.status === "in_progress" ? SPINNER[spinnerFrame % SPINNER.length] : TODO_SYMBOL[todo.status]
	const isFerment = scope.kind === "ferment"
	// Five-character indent replaces the old `" NN. "` numbering so row
	// heights and truncation stay byte-identical.
	const prefix = "     "

	// Phase header — bold accent (bridge-written: "[Phase N] Name")
	if (isFerment && todo.content.startsWith("[Phase ")) {
		if (todo.status === "completed") {
			return `${prefix} ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
		}
		return `${prefix} ${theme.fg("accent", symbol)} ${theme.fg("accent", theme.bold(todo.activeForm ?? todo.content))}`
	}

	// Ferment step item — dim the prefix arrow (bridge-written: "↳ description")
	if (isFerment && todo.content.startsWith("↳ ")) {
		const arrow = "↳ "
		const text = todo.content.slice(arrow.length)
		if (todo.status === "completed") {
			return `${prefix} ${theme.fg("success", symbol)} ${theme.fg("dim", arrow)}${theme.fg("dim", text)}`
		}
		if (todo.status === "blocked") {
			return `${prefix} ${theme.fg("warning", symbol)} ${theme.fg("dim", arrow)}${theme.fg("warning", text)}`
		}
		if (todo.status === "in_progress") {
			return `${prefix} ${theme.fg("accent", symbol)} ${theme.fg("dim", arrow)}${theme.fg("accent", todo.activeForm ?? text)}`
		}
		return `${prefix} ${theme.fg("dim", symbol)} ${theme.fg("dim", arrow)}${text}`
	}

	// All other todos (global, ferment-step sub-tasks) — standard rendering
	if (todo.status === "completed") return `${prefix} ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
	if (todo.status === "blocked") return `${prefix} ${theme.fg("warning", symbol)} ${theme.fg("warning", todo.content)}`
	if (todo.status === "in_progress") {
		return `${prefix} ${theme.fg("accent", symbol)} ${theme.fg("accent", todo.activeForm ?? todo.content)}`
	}
	return `${prefix} ${theme.fg("dim", symbol)} ${todo.content}`
}

/** Numbered row for `/todos` notify output. Applies a `N. ` prefix in place
 *  of the strip's blank indent so the `/todos done <n>` index lines stay
 *  intelligible; the positions restart per scope group. */
function numberedTodoLine(todo: TodoItem, displayIndex: number, theme: Theme, scope: TodoScope): string {
	const index = `${displayIndex + 1}`.padStart(2)
	// Notify text is static — use the first spinner frame so in_progress rows
	// stay distinguishable without the tick.
	return todoLine(todo, displayIndex, theme, scope, 0).replace(/^(\s{5})/, ` ${index}. `)
}

/** Short scope name for the one-line widget header (no "Todos · " prefix). */
function formatScopeLabel(scope: TodoScope): string {
	if (scope.kind === "ferment") {
		return `Ferment (${scope.phaseId})`
	}
	if (scope.kind === "ferment-step") {
		return `Step (${scope.phaseId}/${scope.stepId})`
	}
	return "Global"
}

/** Muted group label for multi-scope expanded body. */
function formatGroupLabel(scope: TodoScope): string {
	return `Todos · ${formatScopeLabel(scope)}`
}

interface TodoBodyRow {
	kind: "scope" | "todo"
	text: string
	status?: TodoStatus
}

function buildFullTodoBodyRows(theme: Theme, groups: WidgetScopeGroup[], spinnerFrame = 0): TodoBodyRow[] {
	const showScopeLabels = groups.length > 1 || groups[0].scope.kind !== "global"
	const rows: TodoBodyRow[] = []
	for (const group of groups) {
		if (showScopeLabels) {
			rows.push({ kind: "scope", text: theme.fg("dim", formatGroupLabel(group.scope)) })
		}
		let groupIndex = 0
		for (const todo of group.todos) {
			rows.push({
				kind: "todo",
				text: todoLine(todo, groupIndex, theme, group.scope, spinnerFrame),
				status: todo.status,
			})
			groupIndex++
		}
	}
	return rows
}

/** Prefer starting near the first in-progress (else first non-completed) todo,
 *  with a couple of completed rows of context above it. All-completed lists
 *  pin to the end (caller clamps against the real viewport size). */
function autoScrollOffset(rows: TodoBodyRow[]): number {
	const firstRunning = rows.findIndex((row) => row.kind === "todo" && row.status === "in_progress")
	if (firstRunning !== -1) return Math.max(0, firstRunning - MAX_ROLLED_CONTEXT_ROWS)
	const firstActive = rows.findIndex((row) => row.kind === "todo" && row.status !== "completed")
	if (firstActive === -1) return rows.length
	return Math.max(0, firstActive - MAX_ROLLED_CONTEXT_ROWS)
}

function clampScrollOffset(offset: number, rowCount: number, viewport: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, rowCount - viewport)))
}

/** Collect all non-empty scopes from the store, grouped by kind.
 *  Returns ferment scopes first (sorted by phaseId), then step scopes,
 *  then global. This lets the widget show the full ferment hierarchy
 *  (phase header + steps, step sub-tasks, global todos) in one view. */
interface WidgetScopeGroup {
	scope: TodoScope
	todos: TodoItem[]
}

function collectWidgetScopes(sessionId: string): WidgetScopeGroup[] {
	const state = getTodoState(sessionId)
	const scopeKeys = Object.keys(state.byScope)
	if (scopeKeys.length === 0) return []

	const fermentScopes: WidgetScopeGroup[] = []
	const stepScopes: WidgetScopeGroup[] = []
	let globalGroup: WidgetScopeGroup | undefined

	for (const scopeKey of scopeKeys) {
		let scope: TodoScope | undefined
		try {
			scope = parseTodoScopeKey(scopeKey)
		} catch {
			continue
		}
		const scopeState = state.byScope[scopeKey]
		if (!scopeState || scopeState.todos.length === 0) continue

		const todos = [...scopeState.todos].sort((a, b) => a.id - b.id)

		if (scope.kind === "global") {
			globalGroup = { scope, todos }
			continue
		}

		if (scope.kind === "ferment") {
			fermentScopes.push({ scope, todos })
			continue
		}

		if (scope.kind === "ferment-step") {
			stepScopes.push({ scope, todos })
		}
	}

	// Sort ferment scopes by phaseId for stable ordering
	fermentScopes.sort((a, b) => {
		const pa = (a.scope as { phaseId: string }).phaseId
		const pb = (b.scope as { phaseId: string }).phaseId
		return pa < pb ? -1 : pa > pb ? 1 : 0
	})
	stepScopes.sort((a, b) => {
		const pa = a.scope as { phaseId: string; stepId: string }
		const pb = b.scope as { phaseId: string; stepId: string }
		if (pa.phaseId !== pb.phaseId) return pa.phaseId < pb.phaseId ? -1 : 1
		return pa.stepId < pb.stepId ? -1 : pa.stepId > pb.stepId ? 1 : 0
	})

	return [...fermentScopes, ...stepScopes, ...(globalGroup ? [globalGroup] : [])]
}

/** Count todos across scope groups. */
function countTodosInGroups(groups: WidgetScopeGroup[]): TodoCounts {
	const allTodos = groups.flatMap((g) => g.todos)
	return {
		total: allTodos.length,
		completed: allTodos.filter((t) => t.status === "completed").length,
		pending: allTodos.filter((t) => t.status === "pending").length,
		inProgress: allTodos.filter((t) => t.status === "in_progress").length,
		blocked: allTodos.filter((t) => t.status === "blocked").length,
	}
}

function countAllActiveTodos(sessionId: string): TodoCounts {
	return countTodosInGroups(collectWidgetScopes(sessionId))
}

/** Build the notification/list text for `/todos` (not the strip). */
export function buildTodoLines(theme: Theme, sessionId: string): string[] {
	const groups = collectWidgetScopes(sessionId)
	if (groups.length === 0) {
		return [theme.fg("dim", "No todos yet. Add one with `/todos add <text>`.")]
	}

	const lines: string[] = []
	for (const group of groups) {
		const counts = {
			total: group.todos.length,
			completed: group.todos.filter((t) => t.status === "completed").length,
			pending: group.todos.filter((t) => t.status === "pending").length,
			inProgress: group.todos.filter((t) => t.status === "in_progress").length,
			blocked: group.todos.filter((t) => t.status === "blocked").length,
		}
		lines.push(theme.fg("accent", `Todos · ${formatScopeLabel(group.scope)}`))
		lines.push("")
		lines.push(theme.fg("dim", summarizeTodoCounts(counts)))
		lines.push("")
		let groupIndex = 0
		for (const todo of group.todos) {
			lines.push(numberedTodoLine(todo, groupIndex, theme, group.scope))
			groupIndex++
		}
		lines.push("")
	}

	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines
}

/** Body rows for the expanded strip. Long lists render in a fixed-height
 *  scrollable viewport with `↑ N more` / `↓ N more` marker rows (mouse wheel
 *  in fullscreen); `/todos expand all` still dumps every row.
 *
 *  Writes `state.scrollOffset` when the viewport is capped so a later wheel
 *  event can continue from the window that was just painted. */
function buildTodoBodyLines(
	theme: Theme,
	groups: WidgetScopeGroup[],
	state: Pick<TodoWidgetState, "expanded" | "scrollOffset" | "userScrolled" | "spinnerFrame">,
): { lines: string[]; scrollable: boolean } {
	const rows = buildFullTodoBodyRows(theme, groups, state.spinnerFrame)

	if (state.expanded) return { lines: rows.map((row) => row.text), scrollable: false }

	// Fits under the cap with the one-line header and the hint line.
	if (rows.length + 3 <= MAX_TODO_WIDGET_LINES) {
		return { lines: rows.map((row) => row.text), scrollable: false }
	}

	const showUpBudget = 1
	const showDownBudget = 1
	const maxContent =
		TODO_WIDGET_BODY_LINES - showUpBudget - showDownBudget > 0
			? TODO_WIDGET_BODY_LINES - showUpBudget - showDownBudget
			: TODO_WIDGET_BODY_LINES

	// Resolve the visible window in closed form by treating "pinned to bottom"
	// separately — at the bottom, the ↓ marker is hidden and the freed slot
	// makes space for one more row, so we can pin rows.length contentSlots.
	// The user's wheel-direction is irrelevant: clampScrollOffset always
	// constrains the upper bound by rows.length - contentSlots.
	let contentSlots = maxContent
	let offset = state.userScrolled ? state.scrollOffset : autoScrollOffset(rows)
	offset = clampScrollOffset(offset, rows.length, contentSlots)

	// If this clamp bottoms out, business-logic says "at bottom, no ↓ marker",
	// so recompute with one extra slot and re-clamp. The up-marker is already
	// visible at that point, so the math stays linear.
	const hiddenAfter = Math.max(0, rows.length - offset - maxContent)
	const showUpInitial = offset > 0
	if (hiddenAfter === 0 && showUpInitial) {
		contentSlots = TODO_WIDGET_BODY_LINES - 1 // ↑ only
		offset = clampScrollOffset(offset, rows.length, contentSlots)
	} else if (hiddenAfter > 0 && !showUpInitial) {
		contentSlots = TODO_WIDGET_BODY_LINES - 1 // ↓ only (offset=0)
		offset = clampScrollOffset(offset, rows.length, contentSlots)
	} else {
		// Both markers visible.
		contentSlots = TODO_WIDGET_BODY_LINES - 2
		offset = clampScrollOffset(offset, rows.length, contentSlots)
	}
	state.scrollOffset = offset

	const visible = rows.slice(offset, offset + contentSlots)
	const remainingAfter = Math.max(0, rows.length - offset - visible.length)
	const showUp = offset > 0
	const showDown = remainingAfter > 0
	const lines: string[] = []
	if (showUp) lines.push(theme.fg("dim", `↑ ${offset} more`))
	for (const row of visible) lines.push(row.text)
	if (showDown) lines.push(theme.fg("dim", `↓ ${remainingAfter} more`))
	return { lines, scrollable: showUp || showDown }
}

/** Cheap body-row count for height-based collapse (no theme / string work). */
function countTodoBodyRows(groups: WidgetScopeGroup[]): number {
	if (groups.length === 0) return 0
	const showScopeLabels = groups.length > 1 || groups[0].scope.kind !== "global"
	let rows = 0
	for (const group of groups) {
		if (showScopeLabels) rows++
		rows += group.todos.length
	}
	return rows
}

function estimateExpandedHeight(groups: WidgetScopeGroup[], expanded: boolean): number {
	const rowCount = countTodoBodyRows(groups)
	if (expanded || rowCount + 3 <= MAX_TODO_WIDGET_LINES) {
		return 1 + rowCount + 2 // header + body + blank + hint
	}
	return 1 + TODO_WIDGET_BODY_LINES + 2
}

function headerScopeLabel(groups: WidgetScopeGroup[]): string | undefined {
	// Single-scope lists put the scope name (including Global) in the header;
	// multi-scope keeps per-group labels in the body only.
	if (groups.length !== 1) return undefined
	return formatScopeLabel(groups[0].scope)
}

function buildTodoWidgetLines(theme: Theme, state: TodoWidgetState, sessionId: string): string[] {
	const groups = collectWidgetScopes(sessionId)

	if (groups.length === 0) {
		return [theme.fg("dim", "No todos yet. Add one with `/todos add <text>`.")]
	}

	const counts = countTodosInGroups(groups)
	const scopeLabel = headerScopeLabel(groups)
	const terminalRows = state.tui?.terminal?.rows
	const expandedHeight = estimateExpandedHeight(groups, state.expanded)

	if (
		isTodoBodyCollapsed({
			expanded: state.expanded,
			listExpanded: state.listExpanded,
			listCollapsed: state.listCollapsed,
			total: counts.total,
			expandedHeight,
			terminalRows,
		})
	) {
		return [
			buildTodoHeaderLine(theme, counts, true, {
				scopeLabel,
				spinnerFrame: state.spinnerFrame,
			}),
		]
	}

	const body = buildTodoBodyLines(theme, groups, state)
	const lines = [
		buildTodoHeaderLine(theme, counts, false, { scopeLabel, spinnerFrame: state.spinnerFrame }),
		...body.lines,
	]
	if (body.scrollable) lines.push("", theme.fg("dim", SCROLL_HINT_TEXT))
	return lines
}

function stopSpinner(state: TodoWidgetState): void {
	if (state.spinnerTimer) {
		clearInterval(state.spinnerTimer)
		state.spinnerTimer = undefined
	}
}

function syncSpinner(state: TodoWidgetState, sessionId: string): void {
	const inProgress = countAllActiveTodos(sessionId).inProgress
	const shouldSpin = state.visible && inProgress > 0
	if (!shouldSpin) {
		stopSpinner(state)
		return
	}
	// Keep the running glyph in CI, but skip the interval — each tick
	// force-renders the whole TUI and blew the 25m tui-e2e budget.
	if (process.env.CI === "true") {
		stopSpinner(state)
		return
	}
	if (state.spinnerTimer) return
	state.spinnerTimer = setInterval(() => {
		state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER.length
		state.tui?.requestRender?.(true)
	}, SPINNER_INTERVAL_MS)
	// Do not keep the process alive solely for the animation.
	state.spinnerTimer.unref?.()
}

export function resetTodoWidgetState(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId()
	const state = todoWidgetStates.get(sessionId)
	if (state) stopSpinner(state)
	todoWidgetStates.delete(sessionId)
}

function requestTodoRender(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = todoWidgetStates.get(sessionId)
	if (!state?.registered) return
	syncSpinner(state, sessionId)
	state.tui?.requestRender?.(true)
}

export function setTodosStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const counts = countAllActiveTodos(sessionId)
	ctx.ui.setStatus(TODO_STATUS_KEY, hasActiveTodos(counts) ? `${summarizeTodoCounts(counts)} -> F7` : undefined)
}

export function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	mountTodoWidget(ctx, state)
}

/** Re-insert the todos widget at the tail of the aboveEditor map so it renders
 *  directly above the editor (below agents, tips, etc.). Mirrors the agents ›
 *  `remountTipWidget` bump: framework renders aboveEditor widgets in Map
 *  insertion order, and agent widgets race the strip. */
export function remountTodosWidget(): void {
	for (const [sessionId, state] of todoWidgetStates) {
		if (state.registered && state.ctx) mountTodoWidget(state.ctx, state, sessionId)
	}
}

function mountTodoWidget(
	ctx: ExtensionContext,
	state: TodoWidgetState,
	sessionId = state.ctx?.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionId(),
): void {
	if (state.registered && state.ctx === ctx) return

	const registrationId = state.registrationId + 1
	state.registrationId = registrationId
	const unregister = () => {
		if (state.registrationId !== registrationId) return
		state.registered = false
		stopSpinner(state)
		state.tui = undefined
		state.ctx = undefined
	}
	const component = (tui: unknown, theme: Theme) => {
		state.tui = tui as TodoWidgetState["tui"]
		syncSpinner(state, sessionId)
		return {
			render(width: number): string[] {
				if (!state.visible) return []
				return buildTodoWidgetLines(theme, state, sessionId).map((line) =>
					truncateToWidth(line, Math.max(1, width - 4)),
				)
			},
			invalidate: unregister,
			dispose: unregister,
			handleInput(data: string): void {
				if (isKeyRelease(data)) return
				// Esc hides the strip when the widget has focus. Do not bind `q` —
				// it fires while the prompt editor has focus and would steal input.
				if (matchesKey(data, Key.escape)) {
					collapseTodoWidget(ctx)
					return
				}
				// Enter/F7 collapse ↔ expand the list body; Esc hides the strip.
				if (matchesKey(data, Key.enter) || matchesKey(data, "return") || matchesKey(data, TODO_SHORTCUT)) {
					toggleTodoWidget(ctx)
				}
			},
			// Mouse only reaches widgets in fullscreen mode (`--tui-mode fullscreen`),
			// where the alt-screen renderer captures it. Left click mirrors
			// F7/`/todos` (collapse ↔ expand). Wheel scrolls the list body when
			// expanded; right-click falls through for paste.
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "wheel") {
					const counts = countAllActiveTodos(sessionId)
					const groups = collectWidgetScopes(sessionId)
					const terminalRows = state.tui?.terminal?.rows
					const expandedHeight = estimateExpandedHeight(groups, state.expanded)
					if (
						isTodoBodyCollapsed({
							expanded: state.expanded,
							listExpanded: state.listExpanded,
							listCollapsed: state.listCollapsed,
							total: counts.total,
							expandedHeight,
							terminalRows,
						})
					) {
						return undefined
					}
					const rows = buildFullTodoBodyRows(theme, groups)
					if (rows.length + 3 <= MAX_TODO_WIDGET_LINES) return undefined
					const delta = event.wheelDelta ?? 0
					if (delta === 0) return undefined
					state.userScrolled = true
					state.scrollOffset = clampScrollOffset(state.scrollOffset + delta, rows.length, TODO_WIDGET_BODY_LINES - 2)
					requestTodoRender(ctx)
					return { handled: true }
				}
				if (event.type !== "click" || event.button !== "left") return undefined
				// Swallow the trailing clicks of a double-click so it toggles once.
				if (event.clickCount !== undefined && event.clickCount > 1) return { handled: true }
				toggleTodoWidget(ctx)
				return { handled: true }
			},
		}
	}
	ctx.ui.setWidget(TODO_WIDGET_KEY, component, TODO_WIDGET_OPTIONS)
	state.registered = true
	state.ctx = ctx
}

/** Ambient show: make the strip visible without changing the user's
 *  expand/collapse overrides, so auto-collapse still applies. Used by the
 *  store-sync path, which must not count as an explicit expansion. */
function showTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.collapsed = false
	state.visible = true
	ensureTodoWidget(ctx)
	requestTodoRender(ctx)
	setTodosStatus(ctx)
}

export function openTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	// Explicit open (`/todos expand`) shows the list body even when the list is
	// past the auto-collapse threshold.
	const state = getTodoWidgetState(ctx)
	state.listExpanded = true
	state.listCollapsed = false
	state.userScrolled = false
	showTodoWidget(ctx)
}

export function expandTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.expanded = true
	state.listExpanded = true
	state.listCollapsed = false
	state.userScrolled = false
	state.scrollOffset = 0
	showTodoWidget(ctx)
}

export function clearTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.visible = false
	state.expanded = false
	state.listExpanded = false
	state.listCollapsed = false
	state.userScrolled = false
	state.scrollOffset = 0
	stopSpinner(state)
	requestTodoRender(ctx)
}

export function collapseTodoWidget(ctx: ExtensionContext): void {
	getTodoWidgetState(ctx).collapsed = true
	clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

/** Collapse ↔ expand the list body in place. Used by F7, bare `/todos`, Enter,
 *  and click. Never hides the strip — Esc and `/todos collapse` do that. */
export function toggleTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = getTodoWidgetState(ctx)
	if (!state.visible) {
		showTodoWidget(ctx)
		return
	}
	const groups = collectWidgetScopes(sessionId)
	const counts = countTodosInGroups(groups)
	const terminalRows = state.tui?.terminal?.rows
	const expandedHeight = estimateExpandedHeight(groups, state.expanded)
	if (
		isTodoBodyCollapsed({
			expanded: state.expanded,
			listExpanded: state.listExpanded,
			listCollapsed: state.listCollapsed,
			total: counts.total,
			expandedHeight,
			terminalRows,
		})
	) {
		openTodoWidget(ctx)
		return
	}
	state.listCollapsed = true
	state.listExpanded = false
	state.expanded = false
	requestTodoRender(ctx)
}

export function syncTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const counts = countAllActiveTodos(sessionId)
	const state = getTodoWidgetState(ctx)
	if (!state.collapsed && hasActiveTodos(counts)) showTodoWidget(ctx)
	else clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function disposeTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = todoWidgetStates.get(sessionId)
	ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
	if (state) {
		state.visible = false
		state.registered = false
		stopSpinner(state)
		state.tui = undefined
		state.ctx = undefined
	}
	todoWidgetStates.delete(sessionId)
}

export function registerTodoShortcut(pi: ExtensionAPI): void {
	pi.registerShortcut(TODO_SHORTCUT, {
		description: "Collapse/expand todos list",
		handler: (ctx) => toggleTodoWidget(ctx),
	})
}

export {
	buildTodoLines as __test_buildTodoLines,
	resetTodoWidgetState as __test_resetTodoWidgetState,
	summarizeTodos as __test_summarizeTodos,
}
