import { homedir } from "node:os"
import { basename } from "node:path"
import {
	getMarkdownTheme,
	getSelectListTheme,
	keyHint,
	type SessionInfo,
	SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent"
import {
	type Component,
	getKeybindings,
	type Input,
	matchesKey,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import { getInternalSessionInfo, type InternalSessionInfo } from "./session-visibility.js"

// Pi 0.85.1 exposes the selector but not its presentation state. Keep this private
// boundary here; the contract tests instantiate the real upstream component.
type SortMode = Parameters<ReturnType<SessionSelectorComponent["getSessionList"]>["setSortMode"]>[0]
interface SessionListState extends Component {
	allSessions: SessionInfo[]
	filteredSessions: { session: SessionInfo }[]
	selectedIndex: number
	searchInput: Input
	sortMode: SortMode
	nameFilter: "all" | "named"
	showCwd: boolean
	showPath: boolean
	onTogglePath(showPath: boolean): void
	confirmingDeletePath: string | null
	maxVisible: number
	filterSessions(query: string): void
	setSortMode(mode: SortMode): void
	buildTreePrefix(node: { session: SessionInfo }): string
	isCurrentSessionPath(path: string): boolean
	handleInput(data: string): void
}
interface SelectorState extends Pick<SessionSelectorComponent, "children" | "render"> {
	currentSessionsLoader: ConstructorParameters<typeof SessionSelectorComponent>[0]
	allSessionsLoader: ConstructorParameters<typeof SessionSelectorComponent>[1]
	sessionList: SessionListState
	sortMode: SortMode
	header: Component & {
		scope: "current" | "all"
		loading: boolean
		statusMessage: unknown
		showRenameHint: boolean
		loadProgress: { loaded: number; total: number } | null
		setSortMode(mode: SortMode): void
	}
	buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void
}

const colors = getSelectListTheme()
const { bold, code, link, underline } = getMarkdownTheme()

function clean(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
}

function shortPath(path: string, width: number): string {
	const home = homedir()
	const text = clean(path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
	const length = visibleWidth(text)
	return length <= width ? text : `…${sliceByColumn(text, length - width + 1, Math.max(0, width - 1), true)}`
}

function age(date: Date): string {
	const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000))
	if (!Number.isFinite(minutes)) return "Unknown"
	if (minutes < 1) return "now"
	if (minutes < 60) return `${minutes}m ago`
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
	return `${Math.floor(minutes / 1440)}d ago`
}

function dateTime(date: Date): string {
	return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown"
}

function sessionDate(date: Date): string {
	if (!Number.isFinite(date.getTime())) return "Unknown"
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	if (date.toDateString() === today.toDateString())
		return `Today ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`
	if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
	})
}

function cell(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true)
}

function highlight(text: string, pattern?: RegExp): string {
	const match = pattern?.exec(text)
	if (!match?.[0]) return text
	return text.slice(0, match.index) + code(bold(underline(match[0]))) + text.slice(match.index + match[0].length)
}

// Search itself stays in Pi. This expression only locates visible match context.
function searchPattern(query: string): { pattern?: RegExp; error?: string } {
	const value = query.trim()
	if (!value) return {}
	if (value.startsWith("re:")) {
		if (!value.slice(3).trim()) return { error: "Enter a pattern after re:" }
		try {
			return { pattern: new RegExp(value.slice(3).trim(), "i") }
		} catch {
			return { error: "Invalid regular expression. Fix the pattern or clear the search." }
		}
	}
	const words = (value.match(/"[^"]+"|[^\s"]+/g) ?? [])
		.map((word) => word.replace(/^"|"$/g, "").replace(/\s+/g, " "))
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	return { pattern: new RegExp(words.join("|"), "i") }
}

function preview(session: SessionInfo, query: string, width: number): string {
	const text = clean(query.trim() ? session.allMessagesText : session.firstMessage)
	const match = searchPattern(query).pattern?.exec(text)
	let start = Math.max(0, (match?.index ?? 0) - Math.floor(width / 4))
	// RegExp indices count UTF-16 units; don't start on the low half of an emoji.
	if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--
	const excerpt = (start ? "…" : "") + sliceByColumn(text.slice(start), 0, width * 3, true)
	return excerpt || "(no conversation text)"
}

function renderSessions(
	list: SessionListState,
	width: number,
	loading: boolean,
	hiddenCount: number,
	internalSessions: WeakMap<SessionInfo, InternalSessionInfo>,
): string[] {
	const query = list.searchInput.getValue()
	const { pattern, error } = searchPattern(query)
	const lines = [
		...list.searchInput.render(width),
		colors.description('Search names, messages, folders or IDs · "phrase" exact · re:regex'),
	]
	if (loading) {
		lines.push(colors.description("Loading sessions…"))
		return lines.map((line) => truncateToWidth(line, width))
	}
	if (error || list.filteredSessions.length === 0) {
		const empty = query.trim()
			? "No matching sessions. Clear the search or press Tab to change folder scope."
			: hiddenCount === list.allSessions.length && hiddenCount > 0
				? "No visible sessions. Press Ctrl+E to show evaluators."
				: list.nameFilter === "named"
					? "No named sessions. Toggle the named filter to show all sessions."
					: list.showCwd
						? "No saved sessions yet. Start a conversation to create one."
						: "No sessions in this folder. Press Tab to search all folders."
		lines.push(...wrapTextWithAnsi(colors.noMatch(error ?? empty), width))
		return lines.map((line) => truncateToWidth(line, width))
	}

	const dateWidth = width >= 60 ? 13 : 10
	const projectWidth = list.showCwd && width >= 60 ? 18 : 0
	lines.push(
		colors.selectedText(
			bold(`  ${cell("Last active", dateWidth)}${projectWidth ? cell("Project", projectWidth) : ""}Session`),
		),
	)
	const start = Math.max(
		0,
		Math.min(list.selectedIndex - Math.floor(list.maxVisible / 2), list.filteredSessions.length - list.maxVisible),
	)
	const end = Math.min(start + list.maxVisible, list.filteredSessions.length)
	for (let index = start; index < end; index++) {
		const node = list.filteredSessions[index]
		const session = node.session
		const selected = index === list.selectedIndex
		const current = list.isCurrentSessionPath(session.path)
		const title = clean(session.name?.trim() || session.firstMessage || "(untitled session)")
		const dates = code(cell(sessionDate(session.modified), dateWidth))
		const project = projectWidth ? link(cell(`${clean(basename(session.cwd)) || "Unknown"} `, projectWidth)) : ""
		const info = internalSessions.get(session)
		const internal = info ? colors.description(info.kind === "ferment-evaluator" ? "[evaluator] " : "[internal] ") : ""
		const label = `${list.buildTreePrefix(node)}${internal}${current ? "[current] " : ""}${highlight(title, pattern)}`
		let row = `${selected ? "› " : "  "}${dates}${project}${selected ? bold(label) : label}`
		row = truncateToWidth(row, width)
		if (session.path === list.confirmingDeletePath) row = colors.selectedText(row)
		if (selected) row = `\x1b[7m${colors.selectedText(bold(cell(stripTerminalSequences(row), width)))}\x1b[27m`
		lines.push(row)
	}
	lines.push(
		colors.description(
			`${list.selectedIndex + 1}/${list.filteredSessions.length} sessions${query.trim() ? ` · ${list.allSessions.length - hiddenCount} in scope` : ""}${hiddenCount ? ` · ${hiddenCount} evaluator${hiddenCount === 1 ? "" : "s"} hidden` : ""}`,
		),
	)
	const selected = list.filteredSessions[list.selectedIndex]?.session
	if (selected) {
		lines.push("")
		const internal = internalSessions.get(selected)
		const parent = list.allSessions.find((session) => session.path === selected.parentSessionPath)
		const labelWidth = 15
		const detail = (label: string, value: string) => colors.description(cell(`${label}:`, labelWidth)) + value
		lines.push(
			detail("Last active", code(`${dateTime(selected.modified)} · ${age(selected.modified)}`)),
			detail("Created", `${dateTime(selected.created)} · ${selected.messageCount} messages`),
			internal
				? detail(
						"Parent",
						clean(parent?.name || parent?.firstMessage || basename(selected.parentSessionPath ?? "")) || "Unavailable",
					)
				: detail("Folder", link(shortPath(selected.cwd, width - labelWidth) || "Unknown")),
			detail("Session", colors.description(clean(selected.id))),
		)
		if (list.showPath) lines.push(detail("File", link(shortPath(selected.path, width - labelWidth))))
		if (internal) {
			lines.push(
				detail(
					"Role",
					internal.kind === "ferment-evaluator" ? "Checks whether the parent task is complete" : "Internal session",
				),
				detail("Initial model", internal.model ? clean(internal.model) : "Not recorded"),
			)
		} else {
			const previewWidth = Math.max(1, width - labelWidth)
			// Reserve both preview rows so selecting a longer message cannot move the menu.
			const context = wrapTextWithAnsi(highlight(preview(selected, query, previewWidth), pattern), previewWidth).concat(
				"",
			)
			lines.push(
				...context
					.slice(0, 2)
					.map(
						(line, index) =>
							(index === 0
								? colors.selectedText(cell(query.trim() ? "Conversation:" : "First message:", labelWidth))
								: " ".repeat(labelWidth)) + line,
					),
			)
		}
	}
	lines.push(
		`${keyHint("tui.select.confirm", list.confirmingDeletePath ? "confirm deletion" : "resume")} · ${keyHint("tui.select.cancel", "cancel")}`,
	)
	return lines.map((line) => truncateToWidth(line, width))
}

const installed = new WeakSet<SessionListState>()
const prototype = SessionSelectorComponent.prototype as unknown as SelectorState
const buildBaseLayout = prototype.buildBaseLayout
const render = prototype.render

prototype.render = function (width) {
	return render.call(this, Math.min(width, 120))
}

// Decorate the shared upstream selector, including CLI --resume. Loading, input,
// focus, scope, rename, deletion confirmation and switching remain upstream-owned.
prototype.buildBaseLayout = function (content, options) {
	const list = this.sessionList
	if (!installed.has(list)) {
		installed.add(list)
		const internalSessions = new WeakMap<SessionInfo, InternalSessionInfo>()
		let showInternal = false
		let previousSort: SortMode = "relevance"
		for (const key of ["currentSessionsLoader", "allSessionsLoader"] as const) {
			const loader = this[key].bind(this)
			this[key] = async (onProgress) => {
				const sessions = await loader(onProgress)
				for (const session of sessions) {
					const info = await getInternalSessionInfo(session)
					if (info) internalSessions.set(session, info)
				}
				return sessions
			}
		}
		this.sortMode = "relevance"
		this.header.setSortMode("relevance")
		list.setSortMode("relevance")
		const filter = list.filterSessions.bind(list)
		let previousQuery = ""
		list.filterSessions = (query) => {
			filter(query)
			if (!showInternal)
				list.filteredSessions = list.filteredSessions.filter(({ session }) => !internalSessions.has(session))
			const literal = query
				.trim()
				.replace(/^"([^"]+)"$/, "$1")
				.toLowerCase()
			if (literal && !query.trim().startsWith("re:") && list.sortMode !== "recent") {
				// Keep Pi's fuzzy fallback and tie order, but put recognizable literal
				// matches ahead of characters scattered across long conversations.
				list.filteredSessions = list.filteredSessions
					.map((node) => {
						const session = node.session
						const title = (session.name || session.firstMessage).toLowerCase()
						const priority =
							title.includes(literal) || session.id.toLowerCase().includes(literal)
								? 0
								: session.cwd.toLowerCase().includes(literal)
									? 1
									: session.allMessagesText.toLowerCase().includes(literal)
										? 2
										: 3
						return { node, priority }
					})
					.sort((a, b) => a.priority - b.priority)
					.map(({ node }) => node)
			}
			list.selectedIndex =
				query !== previousQuery ? 0 : Math.max(0, Math.min(list.selectedIndex, list.filteredSessions.length - 1))
			previousQuery = query
		}
		const handleInput = list.handleInput.bind(list)
		list.handleInput = (data) => {
			if ((matchesKey(data, "ctrl+e") || matchesKey(data, "f4")) && !list.confirmingDeletePath) {
				const selected = list.filteredSessions[list.selectedIndex]?.session
				if (!showInternal) previousSort = list.sortMode
				showInternal = !showInternal
				this.sortMode = showInternal ? "threaded" : previousSort
				this.header.setSortMode(this.sortMode)
				list.setSortMode(this.sortMode)
				const selectedPath =
					!showInternal && selected && internalSessions.has(selected) ? selected.parentSessionPath : selected?.path
				const index = list.filteredSessions.findIndex(({ session }) => session.path === selectedPath)
				if (index >= 0) list.selectedIndex = index
				return
			}
			const keys = getKeybindings()
			if (!list.confirmingDeletePath && matchesKey(data, "ctrl+f")) {
				list.showPath = !list.showPath
				list.onTogglePath(list.showPath)
				return
			}
			if (!list.confirmingDeletePath && keys.matches(data, "app.session.toggleSort")) {
				// Recent and relevance have identical order without a query; threaded
				// and relevance have identical search behavior. Skip the duplicate state.
				this.sortMode = list.searchInput.getValue().trim()
					? list.sortMode === "recent"
						? "relevance"
						: "recent"
					: list.sortMode === "threaded"
						? "relevance"
						: "threaded"
				this.header.setSortMode(this.sortMode)
				list.setSortMode(this.sortMode)
				return
			}
			if (
				this.header.loading &&
				(keys.matches(data, "tui.select.confirm") ||
					keys.matches(data, "app.session.rename") ||
					keys.matches(data, "app.session.delete") ||
					(keys.matches(data, "app.session.deleteNoninvasive") && !list.searchInput.getValue()))
			)
				return
			handleInput(data)
		}
		const renderHeader = this.header.render.bind(this.header)
		this.header.render = (width) => {
			const sort =
				list.sortMode !== "recent" && list.searchInput.getValue().trim()
					? "Best match"
					: list.sortMode === "threaded"
						? "Threads"
						: "Last active"
			const scope = this.header.scope === "current" ? "Current folder" : "All folders"
			const progress = this.header.loadProgress
			const loading = this.header.loading ? ` · Loading${progress ? ` ${progress.loaded}/${progress.total}` : "…"}` : ""
			const named = list.nameFilter === "named" ? " · Named only" : ""
			const hints = renderHeader(width).slice(1)
			if (!list.confirmingDeletePath && !this.header.statusMessage) {
				const nextSort = list.searchInput.getValue().trim()
					? list.sortMode === "recent"
						? "best match"
						: "last active"
					: list.sortMode === "threaded"
						? "last active"
						: "group by parent"
				hints[0] = truncateToWidth(
					`${keyHint("tui.input.tab", "scope")} · ${keyHint("app.session.toggleSort", nextSort)} · ${colors.selectedText("ctrl+e")} evaluators (${showInternal ? "on" : "off"})`,
					width,
				)
				hints[1] = truncateToWidth(
					`${keyHint("app.session.toggleNamedFilter", "named")} · ${keyHint("app.session.delete", "delete")} · ${colors.selectedText("ctrl+f")} file (${list.showPath ? "on" : "off"})${this.header.showRenameHint ? ` · ${keyHint("app.session.rename", "rename")}` : ""}`,
					width,
				)
			}
			return [
				truncateToWidth(colors.selectedText(bold(`Resume session · ${scope} · ${sort}${named}${loading}`)), width),
				...hints,
			]
		}
		list.render = (width) => {
			// Leave room for the 17 panel rows and up to three harness footer rows.
			list.maxVisible = Math.max(1, Math.min(10, (process.stdout.rows || 40) - 20 - Number(list.showPath)))
			const hiddenCount = showInternal ? 0 : list.allSessions.filter((session) => internalSessions.has(session)).length
			return renderSessions(list, width, this.header.loading, hiddenCount, internalSessions)
		}
	}
	buildBaseLayout.call(this, content, options)
	if (content === list) this.children = this.children.filter((child) => !(child instanceof Spacer))
}
