import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui"
import { readE2eSeam } from "../e2e-seam.js"
import { BRAILLE_FRAMES } from "../spinner.js"
import { hasEffectivePendingCheckin } from "./checkin-gate.js"
import { parseTodoScopeKey } from "./scope.js"
import { GLOBAL_TODO_SCOPE, getTodoCountsForScope, getTodoState, resolveTodoScope } from "./store.js"
import type { TodoCounts, TodoItem, TodoScope, TodoStatus } from "./types.js"

export const TODO_SHORTCUT = Key.f7
export const TODO_SHORTCUT_HINT = "F7"

const TODO_WIDGET_KEY = "kimchi-todos"
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const TODO_STATUS_KEY = "todos"
/** Terminal-height breakpoints (like CSS xs/md/xl tiers), judged by rows only
 *  — vertical space is the scarce resource for the strip; width matters are
 *  already handled by truncation.
 *  - xs (< 24 rows): ambient strip collapses to the one-liner; an explicit
 *    expand shows a single todo row at a time.
 *  Long lists never auto-collapse by item count: the viewport keeps the
 *  expanded strip at header + budget + two `↑/↓ N more` markers.
 *  - md (24–69): 3-row viewport.
 *  - xl (70+): 5-row viewport.
 *  Undefined row counts (headless/unit contexts) fall back to md. */
const TODO_XS_TERMINAL_ROWS = 24
const TODO_TALL_TERMINAL_ROWS = 70
const MAX_ROLLED_CONTEXT_ROWS = 2
/** Keep this well above tool/status spinners' cadence — each tick force-renders
 *  the whole TUI, and an 80ms loop pushed tui-e2e past the 25m job budget. */
export const SPINNER_INTERVAL_MS = 200

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
	/** User override: show the list body even where the ambient strip would collapse (xs terminal, crowding). */
	listExpanded: boolean
	/** User override (F7 / click): keep only the one-line header even where the
	 *  ambient strip would expand. Cleared by any explicit expand. */
	listCollapsed: boolean
	/** Explicit expand overrides suspended while competing UI crowds the strip;
	 *  restored when the last crowding reason clears. Dropped as soon as the
	 *  user expands/collapses during crowding — their newer choice wins. */
	crowdedOverrides?: Pick<TodoWidgetState, "expanded" | "listExpanded">
	/** Index into the full body row list for the scrollable viewport. */
	scrollOffset: number
	/** True once the user scrolls; disables auto-follow of the active todo. */
	userScrolled: boolean
	/** Strip hidden by the user (`/todos collapse`); stays hidden across
	 *  store syncs until an explicit show. */
	hidden: boolean
	registered: boolean
	registrationId: number
	/** True while the agent loop is executing (agent_start → agent_end).
	 *  The in-progress spinner and the "N running" header segment are only
	 *  shown literally while this holds; an idle agent with an in_progress
	 *  todo (e.g. work handed back to the user) renders the static ▶ marker
	 *  and an "N in progress" segment instead of a spinner that implies
	 *  execution is ongoing. */
	agentActive: boolean
	spinnerFrame: number
	spinnerTimer?: ReturnType<typeof setInterval>
	ctx?: ExtensionContext
	tui?: {
		requestRender?: (force?: boolean) => void
		terminal?: { rows?: number }
	}
}

const todoWidgetStates = new Map<string, TodoWidgetState>()

/** Live claims keeping the above-editor strip collapsed (agents, questionnaire,
 *  etc.). Each claim is its own token, so overlapping owners — even with the
 *  same reason — never release each other. */
const todoCrowdingClaims = new Set<{ reason: string }>()

export function isTodoCrowdingActive(): boolean {
	return todoCrowdingClaims.size > 0
}

/** Force the todo list body closed while competing above-editor UI is visible.
 *  Suspends any explicit expand so the strip shrinks immediately, and restores
 *  it once the last claim is released; the user can still F7/`/todos` expand
 *  while crowded. Returns this claim's release; calling it again is a no-op. */
export function claimTodoCrowding(reason: string): () => void {
	const claim = { reason }
	todoCrowdingClaims.add(claim)
	if (todoCrowdingClaims.size === 1) applyTodoCrowding(true)
	return () => {
		if (!todoCrowdingClaims.delete(claim)) return
		if (todoCrowdingClaims.size === 0) applyTodoCrowding(false)
	}
}

function applyTodoCrowding(isCrowded: boolean): void {
	for (const state of todoWidgetStates.values()) {
		if (isCrowded) {
			if (state.expanded || state.listExpanded) {
				state.crowdedOverrides = { expanded: state.expanded, listExpanded: state.listExpanded }
			}
			state.listExpanded = false
			state.expanded = false
		} else if (state.crowdedOverrides) {
			state.expanded = state.crowdedOverrides.expanded
			state.listExpanded = state.crowdedOverrides.listExpanded
			state.crowdedOverrides = undefined
		}
		state.tui?.requestRender?.(true)
	}
}

export async function withTodoCrowding<T>(reason: string, fn: () => Promise<T>): Promise<T> {
	const release = claimTodoCrowding(reason)
	try {
		return await fn()
	} finally {
		release()
	}
}

/** Drop every crowding claim, e.g. on session shutdown, so an owner whose
 *  release never runs (a form left open as the session ends) can't keep the
 *  strip collapsed for the rest of the process. Late releases stay no-ops. */
export function clearTodoCrowding(): void {
	if (todoCrowdingClaims.size === 0) return
	todoCrowdingClaims.clear()
	applyTodoCrowding(false)
}

/** Test-only: clear crowding claims between cases. */
export function __resetTodoCrowding(): void {
	todoCrowdingClaims.clear()
}

function createTodoWidgetState(): TodoWidgetState {
	return {
		visible: false,
		expanded: false,
		listExpanded: false,
		listCollapsed: false,
		scrollOffset: 0,
		userScrolled: false,
		hidden: false,
		registered: false,
		registrationId: 0,
		agentActive: false,
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
 *  `<marker> Todos[ · <scope>] · <done>/<total>[ ✓][ · ⠋ N running | · ▶ N in progress][ · N blocked] (F7)`
 *  Marker mirrors the agents widget: `●` collapsed (live or not), `▼` expanded.
 *  While the agent loop is executing (`agentActive`), in-progress rows animate
 *  with the same braille spinner as the header's "N running" segment; once the
 *  run ends, open items render statically (`▶`, "N in progress") so the strip
 *  no longer implies work is executing on an idle session. */
export function buildTodoHeaderLine(
	theme: Theme,
	counts: TodoCounts,
	collapsed: boolean,
	options: {
		scopeLabel?: string
		spinnerFrame?: number
		agentActive?: boolean
	} = {},
): string {
	const chevron = collapsed ? "●" : "▼"
	const live = counts.inProgress > 0
	const agentActive = options.agentActive ?? false
	const running = live && agentActive
	const title = `${chevron} Todos`
	const parts = [theme.fg(running ? "accent" : "dim", title)]
	if (options.scopeLabel) parts.push(theme.fg("dim", options.scopeLabel))
	const countsText = `${counts.completed}/${counts.total}`
	const allDone = counts.total > 0 && counts.completed === counts.total
	parts.push(theme.fg("dim", countsText) + (allDone ? ` ${theme.fg("success", "✓")}` : ""))
	let line = parts.join(" · ")
	if (live) {
		if (running) {
			const frame = BRAILLE_FRAMES[(options.spinnerFrame ?? 0) % BRAILLE_FRAMES.length]
			line += theme.fg("accent", ` · ${frame} ${counts.inProgress} running`)
		} else {
			line += theme.fg("dim", ` · ${TODO_SYMBOL.in_progress} ${counts.inProgress} in progress`)
		}
	}
	if (counts.blocked > 0) {
		line += theme.fg("warning", ` · ${counts.blocked} blocked`)
	}
	const verb = collapsed ? "expand" : "collapse"
	line += ` ${theme.fg("dim", `(${TODO_SHORTCUT_HINT} to ${verb})`)}`
	return line
}

/** True when the strip should render only the collapsed one-line header:
 *  competing UI is crowding the strip, the user clicked it shut, or the
 *  terminal is in the xs tier. Explicit expand overrides ambient collapse. */
function isTodoBodyCollapsed(
	state: Pick<TodoWidgetState, "expanded" | "listExpanded" | "listCollapsed">,
	terminalRows: number | undefined,
): boolean {
	if (state.expanded || state.listExpanded) return false
	if (isTodoCrowdingActive() || state.listCollapsed) return true
	// xs tier: ambient expansion would fight the conversation for space — stay
	// a one-liner until the user explicitly expands (F7 / click).
	return terminalRows !== undefined && terminalRows > 0 && terminalRows < TODO_XS_TERMINAL_ROWS
}

function hasActiveTodos(counts: TodoCounts): boolean {
	return counts.pending + counts.inProgress + counts.blocked > 0
}

export function summarizeTodos(sessionId: string): string {
	return summarizeTodoCounts(getTodoCountsForScope(GLOBAL_TODO_SCOPE, sessionId))
}

/** Render a single todo line in the widget strip. A single-space indent
 *  keeps each row tight against the header — row numbers were dropped in
 *  favor of `/todos done <n>` references, so there's no per-row prefix
 *  the indent needs to align with. */
function todoLine(todo: TodoItem, theme: Theme, scope: TodoScope, spinnerFrame: number, spinning = true): string {
	const symbol =
		todo.status === "in_progress" && spinning
			? BRAILLE_FRAMES[spinnerFrame % BRAILLE_FRAMES.length]
			: TODO_SYMBOL[todo.status]
	const isFerment = scope.kind === "ferment"
	const prefix = " "

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
	// stay distinguishable without the tick. Strip the leading indent (one
	// space in the strip) and re-prefix with the row number.
	return todoLine(todo, theme, scope, 0).replace(/^ /, ` ${index}. `)
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

function buildFullTodoBodyRows(
	theme: Theme,
	groups: WidgetScopeGroup[],
	spinnerFrame = 0,
	spinning = true,
): TodoBodyRow[] {
	const showScopeLabels = groups.length > 1 || groups[0].scope.kind !== "global"
	const rows: TodoBodyRow[] = []
	for (const group of groups) {
		if (showScopeLabels) {
			rows.push({ kind: "scope", text: theme.fg("dim", formatGroupLabel(group.scope)) })
		}
		for (const todo of group.todos) {
			rows.push({
				kind: "todo",
				text: todoLine(todo, theme, group.scope, spinnerFrame, spinning),
				status: todo.status,
			})
		}
	}
	return rows
}

/** Prefer starting near the first in-progress (else first non-completed) todo,
 *  with a couple of completed rows of context above it — scaled to the row
 *  budget so a 1-row viewport pins exactly on the active row. All-completed
 *  lists pin to the end (caller clamps against the real viewport size). */
function autoScrollOffset(rows: TodoBodyRow[], budget: number): number {
	const context = Math.min(MAX_ROLLED_CONTEXT_ROWS, Math.max(0, budget - 1))
	const firstRunning = rows.findIndex((row) => row.kind === "todo" && row.status === "in_progress")
	if (firstRunning !== -1) return Math.max(0, firstRunning - context)
	const firstActive = rows.findIndex((row) => row.kind === "todo" && row.status !== "completed")
	if (firstActive === -1) return rows.length
	return Math.max(0, firstActive - context)
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
		const scope = resolveTodoScope(sessionId)
		return [
			theme.fg("accent", formatGroupLabel(scope)),
			"",
			theme.fg("dim", "No todos yet. Add one with `/todos add <text>`."),
		]
	}

	const lines: string[] = []
	for (const group of groups) {
		lines.push(theme.fg("accent", formatGroupLabel(group.scope)))
		lines.push("")
		lines.push(theme.fg("dim", summarizeTodoCounts(countTodosInGroups([group]))))
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

/** Todo rows the expanded strip may show at once for the terminal-height
 *  tier: 1 on xs, 3 on md, 5 on xl. Marker rows (`↑/↓ N more`) render on top
 *  of this budget — the budget counts todo rows only. */
export function todoViewportRowBudget(terminalRows: number | undefined): number {
	if (terminalRows === undefined) return 3
	if (terminalRows < TODO_XS_TERMINAL_ROWS) return 1
	if (terminalRows >= TODO_TALL_TERMINAL_ROWS) return 5
	return 3
}

/** Body rows for the expanded strip. Long lists render as a small scrollable
 *  viewport around the active todo with `↑ N more` / `↓ N more` marker rows
 *  (mouse wheel in fullscreen); `/todos expand all` still dumps every row.
 *
 *  Writes `state.scrollOffset` when the viewport is capped so a later wheel
 *  event can continue from the window that was just painted. */
function buildTodoBodyLines(
	theme: Theme,
	groups: WidgetScopeGroup[],
	state: Pick<TodoWidgetState, "expanded" | "scrollOffset" | "userScrolled" | "spinnerFrame" | "agentActive">,
	terminalRows: number | undefined,
): string[] {
	const rows = buildFullTodoBodyRows(theme, groups, state.spinnerFrame, state.agentActive)

	if (state.expanded) return rows.map((row) => row.text)

	// The whole list fits the viewport budget.
	const budget = todoViewportRowBudget(terminalRows)
	if (rows.length <= budget) {
		return rows.map((row) => row.text)
	}

	let offset = state.userScrolled ? state.scrollOffset : autoScrollOffset(rows, budget)
	offset = clampScrollOffset(offset, rows.length, budget)
	state.scrollOffset = offset

	const visible = rows.slice(offset, offset + budget)
	const remainingAfter = Math.max(0, rows.length - offset - visible.length)
	const lines: string[] = []
	if (offset > 0) lines.push(theme.fg("dim", `↑ ${offset} more`))
	for (const row of visible) lines.push(row.text)
	if (remainingAfter > 0) lines.push(theme.fg("dim", `↓ ${remainingAfter} more`))
	return lines
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

	if (isTodoBodyCollapsed(state, terminalRows)) {
		return [
			buildTodoHeaderLine(theme, counts, true, {
				scopeLabel,
				spinnerFrame: state.spinnerFrame,
				agentActive: state.agentActive,
			}),
		]
	}

	const body = buildTodoBodyLines(theme, groups, state, terminalRows)
	return [
		buildTodoHeaderLine(theme, counts, false, {
			scopeLabel,
			spinnerFrame: state.spinnerFrame,
			agentActive: state.agentActive,
		}),
		...body,
	]
}

function stopSpinner(state: TodoWidgetState): void {
	if (state.spinnerTimer) {
		clearInterval(state.spinnerTimer)
		state.spinnerTimer = undefined
	}
}

function syncSpinner(state: TodoWidgetState, sessionId: string): void {
	const inProgress = countAllActiveTodos(sessionId).inProgress
	const shouldSpin = state.visible && inProgress > 0 && state.agentActive
	if (!shouldSpin) {
		stopSpinner(state)
		return
	}
	// Keep the running glyph under the TUI e2e harness, but skip the interval —
	// each tick force-renders the whole TUI and blew the 25m tui-e2e budget.
	if (readE2eSeam("KIMCHI_E2E_STATIC_TODO_SPINNER") === "1") {
		stopSpinner(state)
		return
	}
	if (state.spinnerTimer) return
	state.spinnerTimer = setInterval(() => {
		state.spinnerFrame = (state.spinnerFrame + 1) % BRAILLE_FRAMES.length
		state.tui?.requestRender?.(true)
	}, SPINNER_INTERVAL_MS)
	// Do not keep the process alive solely for the animation.
	state.spinnerTimer.unref?.()
}

/** Track whether the agent loop is executing. Driven by the agent_start /
 *  agent_end pair in the extension entry point; while inactive the strip
 *  stops the spinner timer and renders open items with the static ▶ marker
 *  (an idle session must not imply ongoing execution). */
export function setTodoAgentActive(ctx: ExtensionContext, active: boolean): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = getTodoWidgetState(ctx)
	if (state.agentActive === active) return
	state.agentActive = active
	syncSpinner(state, sessionId)
	state.tui?.requestRender?.(true)
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
	const base = hasActiveTodos(counts) ? `${summarizeTodoCounts(counts)} -> F7` : undefined
	// A pending check-in surfaces in the status line while enforcement is
	// active; the gate subscription in index.ts repaints on input,
	// confirmation, closure, and enforcement changes without todo writes.
	// A released gate (resource disabled, kill switch, no reconciliation
	// tools) must not show a false pause while work flows.
	const status = hasEffectivePendingCheckin(sessionId)
		? base
			? `⏸ todo check-in pending · ${base}`
			: "⏸ todo check-in pending"
		: base
	ctx.ui.setStatus(TODO_STATUS_KEY, status)
}

export function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	mountTodoWidget(ctx, state)
}

/** Re-insert the todos widget at the tail of the aboveEditor map so it renders
 *  directly above the editor (below agents, tips, etc.). Mirrors the agents ›
 *  `remountTipWidget` bump: framework renders aboveEditor widgets in Map
 *  insertion order, and agent widgets race the strip. `setWidget` re-sets an
 *  existing key in place, so a real re-insert requires removing the key first
 *  (which runs the component's dispose/unregister, clearing `registered` so
 *  the follow-up mount is not skipped by mountTodoWidget's guard). */
export function remountTodosWidget(): void {
	for (const [sessionId, state] of todoWidgetStates) {
		if (!state.registered || !state.ctx) continue
		const ctx = state.ctx
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
		// Removing the key runs the component's dispose hook (unregister) on
		// surfaces that invoke it; a surface that doesn't would leave the
		// guard in place and the re-mount below would be skipped — clear the
		// registration explicitly so remounting never silently no-ops again.
		if (state.registered) {
			state.registered = false
			stopSpinner(state)
		}
		mountTodoWidget(ctx, state, sessionId)
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
			// Mouse only reaches widgets in fullscreen mode (`--tui-mode fullscreen`),
			// where the alt-screen renderer captures it. Left click mirrors
			// F7/`/todos` (collapse ↔ expand). Wheel scrolls the list body when
			// expanded; right-click falls through for paste.
			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				if (event.type === "wheel") {
					const groups = collectWidgetScopes(sessionId)
					const terminalRows = state.tui?.terminal?.rows
					// Collapsed shows no body; expand-all shows every row.
					if (isTodoBodyCollapsed(state, terminalRows) || state.expanded) return undefined
					const rows = buildFullTodoBodyRows(theme, groups)
					const budget = todoViewportRowBudget(terminalRows)
					if (rows.length <= budget) return undefined
					const delta = event.wheelDelta ?? 0
					if (delta === 0) return undefined
					state.userScrolled = true
					state.scrollOffset = clampScrollOffset(state.scrollOffset + delta, rows.length, budget)
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
	state.hidden = false
	state.visible = true
	ensureTodoWidget(ctx)
	requestTodoRender(ctx)
	setTodosStatus(ctx)
}

export function openTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	// Explicit open (`/todos expand`) shows the list body even where the ambient
	// strip would collapse (xs terminal, crowding).
	const state = getTodoWidgetState(ctx)
	state.crowdedOverrides = undefined
	state.listExpanded = true
	state.listCollapsed = false
	state.userScrolled = false
	showTodoWidget(ctx)
}

export function expandTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.crowdedOverrides = undefined
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
	state.crowdedOverrides = undefined
	state.userScrolled = false
	state.scrollOffset = 0
	stopSpinner(state)
	requestTodoRender(ctx)
}

/** Hide the strip entirely (`/todos collapse`) — distinct from the
 *  collapsed one-line header that F7 toggles to. */
export function hideTodoWidget(ctx: ExtensionContext): void {
	getTodoWidgetState(ctx).hidden = true
	clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

/** Collapse ↔ expand the list body in place. Used by F7, bare `/todos`, and
 *  click. Never hides the strip — `/todos collapse` does that. */
export function toggleTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	if (!state.visible) {
		showTodoWidget(ctx)
		return
	}
	if (isTodoBodyCollapsed(state, state.tui?.terminal?.rows)) {
		openTodoWidget(ctx)
		return
	}
	state.crowdedOverrides = undefined
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
	if (!state.hidden && hasActiveTodos(counts)) showTodoWidget(ctx)
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
