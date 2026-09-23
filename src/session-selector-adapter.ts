import { homedir } from "node:os"
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
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui"

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
	confirmingDeletePath: string | null
	maxVisible: number
	filterSessions(query: string): void
	setSortMode(mode: SortMode): void
	buildTreePrefix(node: { session: SessionInfo }): string
	isCurrentSessionPath(path: string): boolean
	handleInput(data: string): void
}
interface SelectorState extends Pick<SessionSelectorComponent, "children"> {
	sessionList: SessionListState
	sortMode: SortMode
	header: Component & {
		scope: "current" | "all"
		loading: boolean
		loadProgress: { loaded: number; total: number } | null
		setSortMode(mode: SortMode): void
	}
	buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void
}

const colors = getSelectListTheme()
const { bold } = getMarkdownTheme()

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

function cell(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true)
}

function highlight(text: string, pattern?: RegExp): string {
	const match = pattern?.exec(text)
	if (!match?.[0]) return text
	return text.slice(0, match.index) + colors.selectedText(bold(match[0])) + text.slice(match.index + match[0].length)
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
	const words = value
		.replaceAll('"', "")
		.split(/\s+/)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	return { pattern: new RegExp(words.join("|"), "i") }
}

function preview(session: SessionInfo, query: string, width: number): string {
	const text = clean(query.trim() ? session.allMessagesText : session.firstMessage)
	const match = searchPattern(query).pattern?.exec(text)
	const start = Math.max(0, (match?.index ?? 0) - Math.floor(width / 4))
	const excerpt = (start ? "…" : "") + text.slice(start, start + width * 3)
	return excerpt || "(no conversation text)"
}

function renderSessions(list: SessionListState, width: number, loading: boolean): string[] {
	const query = list.searchInput.getValue()
	const { pattern, error } = searchPattern(query)
	const lines = [...list.searchInput.render(width), colors.description("Search names, messages, folders or IDs")]
	if (loading) {
		lines.push(colors.description("Loading sessions…"))
		return lines.map((line) => truncateToWidth(line, width))
	}
	if (error || list.filteredSessions.length === 0) {
		const empty = query.trim()
			? "No matching sessions. Clear the search or press Tab to change folder scope."
			: list.nameFilter === "named"
				? "No named sessions. Toggle the named filter to show all sessions."
				: list.showCwd
					? "No saved sessions yet. Start a conversation to create one."
					: "No sessions in this folder. Press Tab to search all folders."
		lines.push(...wrapTextWithAnsi(colors.noMatch(error ?? empty), width))
		return lines.map((line) => truncateToWidth(line, width))
	}

	const dateWidth = width >= 60 ? 13 : 10
	const createdColumn = width >= 100
	lines.push(
		colors.description(`  ${cell("Last active", dateWidth)}${createdColumn ? cell("Created", 13) : ""}Session`),
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
		const dates = cell(age(session.modified), dateWidth) + (createdColumn ? cell(age(session.created), 13) : "")
		const label = `${list.buildTreePrefix(node)}${current ? "[current] " : ""}${highlight(title, pattern)}`
		let row = `${selected ? "› " : "  "}${colors.description(dates)}${selected ? bold(label) : label}`
		row = truncateToWidth(row, width)
		if (session.path === list.confirmingDeletePath) row = colors.selectedText(row)
		if (selected) row = colors.selectedText(cell(row, width))
		lines.push(row)
	}
	lines.push(
		colors.description(
			`${list.selectedIndex + 1}/${list.filteredSessions.length} sessions${query.trim() ? ` · ${list.allSessions.length} in scope` : ""}`,
		),
	)
	const selected = list.filteredSessions[list.selectedIndex]?.session
	if (selected) {
		lines.push("")
		const details = [
			`Last active: ${dateTime(selected.modified)} · ${age(selected.modified)}`,
			`Created: ${dateTime(selected.created)} · ${selected.messageCount} messages`,
			`Folder: ${shortPath(selected.cwd, width - 8) || "Unknown"}`,
			`Session: ${clean(selected.id)}`,
		]
		if (list.showPath) details.push(`File: ${shortPath(selected.path, width - 6)}`)
		lines.push(...details.map((line) => colors.description(line)))
		lines.push(
			...wrapTextWithAnsi(
				`${query.trim() ? "Conversation" : "First message"}: ${highlight(preview(selected, query, width), pattern)}`,
				width,
			).slice(0, 2),
		)
	}
	lines.push(`${keyHint("tui.select.confirm", "resume")} · ${keyHint("tui.select.cancel", "cancel")}`)
	return lines.map((line) => truncateToWidth(line, width))
}

const installed = new WeakSet<SessionListState>()
const prototype = SessionSelectorComponent.prototype as unknown as SelectorState
const buildBaseLayout = prototype.buildBaseLayout

// Decorate the shared upstream selector, including CLI --resume. Loading, input,
// focus, scope, rename, deletion confirmation and switching remain upstream-owned.
prototype.buildBaseLayout = function (content, options) {
	const list = this.sessionList
	if (!installed.has(list)) {
		installed.add(list)
		this.sortMode = "relevance"
		this.header.setSortMode("relevance")
		list.setSortMode("relevance")
		const filter = list.filterSessions.bind(list)
		let previousQuery = ""
		list.filterSessions = (query) => {
			filter(query)
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
			list.selectedIndex = query !== previousQuery ? 0 : Math.max(0, list.selectedIndex)
			previousQuery = query
		}
		const handleInput = list.handleInput.bind(list)
		list.handleInput = (data) => {
			const keys = getKeybindings()
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
			return [
				truncateToWidth(bold(`Resume session · ${scope} · ${sort}${named}${loading}`), width),
				...renderHeader(width).slice(1),
			]
		}
		list.render = (width) => {
			list.maxVisible = Math.max(1, Math.min(10, (process.stdout.rows || 40) - 18 - Number(list.showPath)))
			return renderSessions(list, width, this.header.loading)
		}
	}
	buildBaseLayout.call(this, content, options)
	if (content === list) this.children = this.children.filter((child) => !(child instanceof Spacer))
}
