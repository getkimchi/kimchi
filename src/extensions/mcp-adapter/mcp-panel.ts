import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { fg } from "../../ansi.js"
import type { CachedTool, MetadataCache, ServerCacheEntry } from "./metadata-cache.js"
import { resourceNameToToolName } from "./resource-tools.js"
import { isToolExcluded } from "./types.js"
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.js"

interface PanelTheme {
	border: string
	title: string
	selected: string
	direct: string
	needsAuth: string
	placeholder: string
	description: string
	hint: string
	confirm: string
	cancel: string
}

const DEFAULT_THEME: PanelTheme = {
	border: "2",
	title: "2",
	selected: "36",
	direct: "32",
	needsAuth: "33",
	placeholder: "2;3",
	description: "2",
	hint: "2",
	confirm: "32",
	cancel: "31",
}


const RAINBOW_COLORS = [
	"38;2;178;129;214",
	"38;2;215;135;175",
	"38;2;254;188;56",
	"38;2;228;192;15",
	"38;2;137;210;129",
	"38;2;0;175;175",
	"38;2;23;143;185",
]

function rainbowProgress(filled: number, total: number): string {
	const dots: string[] = []
	for (let i = 0; i < total; i++) {
		const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length]
		dots.push(fg(color, i < filled ? "●" : "○"))
	}
	return dots.join(" ")
}

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase()
	const lt = text.toLowerCase()
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50
	let score = 0
	let qi = 0
	let consecutive = 0
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive
			consecutive += 5
			qi++
		} else {
			consecutive = 0
		}
	}
	return qi === lq.length ? score : 0
}

function estimateTokens(tool: CachedTool): number {
	const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length
	const descLen = tool.description?.length ?? 0
	return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting"

interface ToolState {
	name: string
	description: string
	isDirect: boolean
	wasDirect: boolean
	estimatedTokens: number
}

interface ServerState {
	name: string
	expanded: boolean
	source: "user" | "project" | "import"
	importKind?: string
	excludeTools?: string[]
	exposeResources: boolean
	connectionStatus: ConnectionStatus
	tools: ToolState[]
	hasCachedData: boolean
}

interface VisibleItem {
	type: "server" | "tool"
	serverIndex: number
	toolIndex?: number
}

/**
 * Compute the visible-item window for the panel given the terminal height,
 * cursor position, and total item count.
 *
 * - `maxVis` adapts to the terminal so the bottom controls stay on-screen
 *   on small terminals: it's clamped to [MIN_VISIBLE, MAX_VISIBLE] around
 *   `terminalRows - FIXED_OVERHEAD_ROWS`.
 * - `startIdx`/`endIdx` slide the visible window so the cursor stays roughly
 *   centered while staying within `[0, total]`.
 */
export function computeVisibleWindow(
	terminalRows: number,
	cursorIndex: number,
	total: number,
	limits: { maxVisible: number; minVisible: number; fixedOverheadRows: number } = {
		maxVisible: 12,
		minVisible: 3,
		fixedOverheadRows: 16,
	},
): { maxVis: number; startIdx: number; endIdx: number } {
	const maxVis = Math.max(
		limits.minVisible,
		Math.min(limits.maxVisible, terminalRows - limits.fixedOverheadRows),
	)
	const startIdx = Math.max(0, Math.min(cursorIndex - Math.floor(maxVis / 2), total - maxVis))
	const endIdx = Math.min(startIdx + maxVis, total)
	return { maxVis, startIdx, endIdx }
}

class McpPanel {
	private prefix: "server" | "none" | "short"
	private servers: ServerState[] = []
	private cursorIndex = 0
	private nameQuery = ""
	private descSearchActive = false
	private descQuery = ""
	private dirty = false
	private confirmingDiscard = false
	private discardSelected = 1
	private importNotice: string | null = null
	private authNotice: string | null = null
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null
	private visibleItems: VisibleItem[] = []
	private tui: { requestRender(force?: boolean): void; terminal: { rows: number } }
	private t = DEFAULT_THEME

	private static readonly MAX_VISIBLE = 12
	// Borders, search row, dividers, empty rows, progress row, stats row, ~2 hint rows.
	// Subtract from terminal rows to bound visible items so the bottom controls stay on-screen.
	private static readonly FIXED_OVERHEAD_ROWS = 16
	private static readonly MIN_VISIBLE = 3
	private static readonly INACTIVITY_MS = 60_000

	constructor(
		config: McpConfig,
		cache: MetadataCache | null,
		provenance: Map<string, ServerProvenance>,
		private callbacks: McpPanelCallbacks,
		tui: { requestRender(force?: boolean): void; terminal: { rows: number } },
		private done: (result: McpPanelResult) => void,
	) {
		this.tui = tui
		this.prefix = config.settings?.toolPrefix ?? "server"

		for (const [serverName, definition] of Object.entries(config.mcpServers)) {
			const prov = provenance.get(serverName)
			const serverCache = cache?.servers?.[serverName]

			const globalDirect = config.settings?.directTools
			let toolFilter: true | string[] | false = false
			if (definition.directTools !== undefined) {
				toolFilter = definition.directTools
			} else if (globalDirect) {
				toolFilter = globalDirect
			}

			const tools: ToolState[] = []
			if (serverCache) {
				for (const tool of serverCache.tools ?? []) {
					if (isToolExcluded(tool.name, serverName, this.prefix, definition.excludeTools)) {
						continue
					}

					const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(tool.name))
					tools.push({
						name: tool.name,
						description: tool.description ?? "",
						isDirect,
						wasDirect: isDirect,
						estimatedTokens: estimateTokens(tool),
					})
				}
				if (definition.exposeResources !== false) {
					for (const resource of serverCache.resources ?? []) {
						const baseName = `get_${resourceNameToToolName(resource.name)}`
						if (isToolExcluded(baseName, serverName, this.prefix, definition.excludeTools)) {
							continue
						}

						const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(baseName))
						const ct: CachedTool = { name: baseName, description: resource.description }
						tools.push({
							name: baseName,
							description: resource.description ?? `Read resource: ${resource.uri}`,
							isDirect,
							wasDirect: isDirect,
							estimatedTokens: estimateTokens(ct),
						})
					}
				}
			}

			const status = callbacks.getConnectionStatus(serverName)

			this.servers.push({
				name: serverName,
				expanded: false,
				source: prov?.kind ?? "user",
				importKind: prov?.importKind,
				excludeTools: definition.excludeTools,
				exposeResources: definition.exposeResources !== false,
				connectionStatus: status,
				tools,
				hasCachedData: !!serverCache,
			})
		}

		this.rebuildVisibleItems()
		this.resetInactivityTimeout()
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout)
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup()
			this.done({ cancelled: true, changes: new Map() })
		}, McpPanel.INACTIVITY_MS)
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout)
			this.inactivityTimeout = null
		}
	}

	private rebuildVisibleItems(): void {
		const query = this.descSearchActive ? this.descQuery : this.nameQuery
		const mode = this.descSearchActive ? "desc" : "name"

		this.visibleItems = []
		for (let si = 0; si < this.servers.length; si++) {
			const server = this.servers[si]
			this.visibleItems.push({ type: "server", serverIndex: si })
			if (server.expanded || query) {
				for (let ti = 0; ti < server.tools.length; ti++) {
					const tool = server.tools[ti]
					if (query) {
						const score =
							mode === "name"
								? Math.max(fuzzyScore(query, tool.name), fuzzyScore(query, server.name) * 0.6)
								: fuzzyScore(query, tool.description)
						if (score === 0) continue
					}
					this.visibleItems.push({ type: "tool", serverIndex: si, toolIndex: ti })
				}
			}
		}

		if (query) {
			this.visibleItems = this.visibleItems.filter((item) => {
				if (item.type === "server") {
					return this.visibleItems.some((other) => other.type === "tool" && other.serverIndex === item.serverIndex)
				}
				return true
			})
		}
	}

	private updateDirty(): void {
		this.dirty = this.servers.some((s) => s.tools.some((t) => t.isDirect !== t.wasDirect))
	}

	private buildResult(): McpPanelResult {
		const changes = new Map<string, true | string[] | false>()
		for (const server of this.servers) {
			const changed = server.tools.some((t) => t.isDirect !== t.wasDirect)
			if (!changed) continue
			const directTools = server.tools.filter((t) => t.isDirect)
			if (directTools.length === server.tools.length && server.tools.length > 0) {
				changes.set(server.name, true)
			} else if (directTools.length === 0) {
				changes.set(server.name, false)
			} else {
				changes.set(
					server.name,
					directTools.map((t) => t.name),
				)
			}
		}
		return { changes, cancelled: false }
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout()
		this.importNotice = null
		this.authNotice = null

		if (this.confirmingDiscard) {
			this.handleDiscardInput(data)
			return
		}

		// Global shortcuts — always work, even during desc search
		if (matchesKey(data, "ctrl+c")) {
			this.cleanup()
			this.done({ cancelled: true, changes: new Map() })
			return
		}

		if (matchesKey(data, "ctrl+s")) {
			this.cleanup()
			this.done(this.buildResult())
			return
		}

		// Modal description search mode
		if (this.descSearchActive) {
			if (matchesKey(data, "escape") || matchesKey(data, "return")) {
				this.descSearchActive = false
				this.descQuery = ""
				this.rebuildVisibleItems()
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
				return
			}
			if (matchesKey(data, "backspace")) {
				if (this.descQuery.length > 0) {
					this.descQuery = this.descQuery.slice(0, -1)
					this.rebuildVisibleItems()
					this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
				}
				return
			}
			if (matchesKey(data, "up")) {
				this.moveCursor(-1)
				return
			}
			if (matchesKey(data, "down")) {
				this.moveCursor(1)
				return
			}
			if (matchesKey(data, "space")) {
				// Toggle even while in desc search
				const item = this.visibleItems[this.cursorIndex]
				if (item) this.toggleItem(item)
				return
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.descQuery += data
				this.rebuildVisibleItems()
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
				return
			}
			return
		}

		if (matchesKey(data, "escape")) {
			if (this.nameQuery) {
				this.nameQuery = ""
				this.rebuildVisibleItems()
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
				return
			}
			if (this.dirty) {
				this.confirmingDiscard = true
				this.discardSelected = 1
				return
			}
			this.cleanup()
			this.done({ cancelled: true, changes: new Map() })
			return
		}

		if (matchesKey(data, "up")) {
			this.moveCursor(-1)
			return
		}
		if (matchesKey(data, "down")) {
			this.moveCursor(1)
			return
		}

		if (matchesKey(data, "space")) {
			const item = this.visibleItems[this.cursorIndex]
			if (item) this.toggleItem(item)
			return
		}

		if (matchesKey(data, "return")) {
			const item = this.visibleItems[this.cursorIndex]
			if (!item) return
			const server = this.servers[item.serverIndex]
			if (item.type === "server") {
				if (server.connectionStatus === "needs-auth") {
					this.authNotice = `OAuth required — run /mcp-auth ${server.name} after closing this panel`
					return
				}
				server.expanded = !server.expanded
				this.rebuildVisibleItems()
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
			} else if (item.toolIndex !== undefined) {
				const tool = server.tools[item.toolIndex]
				tool.isDirect = !tool.isDirect
				if (tool.isDirect && server.source === "import") {
					this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`
				}
				this.updateDirty()
			}
			return
		}

		if (matchesKey(data, "ctrl+r")) {
			const item = this.visibleItems[this.cursorIndex]
			if (!item) return
			const server = this.servers[item.serverIndex]
			if (server.connectionStatus === "connecting") return
			server.connectionStatus = "connecting"
			this.callbacks
				.reconnect(server.name)
				.then(() => {
					server.connectionStatus = this.callbacks.getConnectionStatus(server.name)
					if (server.connectionStatus === "connected") {
						const entry = this.callbacks.refreshCacheAfterReconnect(server.name)
						if (entry) {
							this.rebuildServerTools(server, entry)
						}
						server.hasCachedData = true
					}
					this.tui.requestRender()
				})
				.catch((error) => {
					server.connectionStatus = "failed"
					const message = error instanceof Error ? error.message : String(error)
					this.authNotice = `Reconnect failed for ${server.name}: ${message}`
					this.tui.requestRender()
				})
			return
		}

		if (data === "?") {
			this.descSearchActive = true
			this.descQuery = ""
			this.rebuildVisibleItems()
			this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
			return
		}

		// Backspace removes from name query
		if (matchesKey(data, "backspace")) {
			if (this.nameQuery.length > 0) {
				this.nameQuery = this.nameQuery.slice(0, -1)
				this.rebuildVisibleItems()
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
			}
			return
		}

		// All other printable chars → always-on name search
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.nameQuery += data
			this.rebuildVisibleItems()
			this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1))
			return
		}
	}

	private toggleItem(item: VisibleItem): void {
		const server = this.servers[item.serverIndex]
		if (item.type === "server") {
			const newState = !server.tools.every((t) => t.isDirect)
			if (server.source === "import" && newState) {
				this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`
			}
			for (const t of server.tools) t.isDirect = newState
		} else if (item.toolIndex !== undefined) {
			const tool = server.tools[item.toolIndex]
			tool.isDirect = !tool.isDirect
			if (tool.isDirect && server.source === "import") {
				this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`
			}
		}
		this.updateDirty()
	}

	private handleDiscardInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.cleanup()
			this.done({ cancelled: true, changes: new Map() })
			return
		}
		if (matchesKey(data, "escape") || data === "n" || data === "N") {
			this.confirmingDiscard = false
			return
		}
		if (matchesKey(data, "return")) {
			if (this.discardSelected === 0) {
				this.cleanup()
				this.done({ cancelled: true, changes: new Map() })
			} else {
				this.confirmingDiscard = false
			}
			return
		}
		if (data === "y" || data === "Y") {
			this.cleanup()
			this.done({ cancelled: true, changes: new Map() })
			return
		}
		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.discardSelected = this.discardSelected === 0 ? 1 : 0
		}
	}

	private moveCursor(delta: number): void {
		if (this.visibleItems.length === 0) return
		this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta))
	}

	private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
		const existingState = new Map<string, boolean>()
		for (const t of server.tools) existingState.set(t.name, t.isDirect)

		const newTools: ToolState[] = []
		for (const tool of entry.tools ?? []) {
			if (isToolExcluded(tool.name, server.name, this.prefix, server.excludeTools)) {
				continue
			}

			const prev = existingState.get(tool.name)
			const isDirect = prev !== undefined ? prev : false
			newTools.push({
				name: tool.name,
				description: tool.description ?? "",
				isDirect,
				wasDirect: prev !== undefined ? (server.tools.find((t) => t.name === tool.name)?.wasDirect ?? false) : false,
				estimatedTokens: estimateTokens(tool),
			})
		}

		if (server.exposeResources) {
			for (const resource of entry.resources ?? []) {
				const baseName = `get_${resourceNameToToolName(resource.name)}`
				if (isToolExcluded(baseName, server.name, this.prefix, server.excludeTools)) {
					continue
				}

				const prev = existingState.get(baseName)
				const isDirect = prev !== undefined ? prev : false
				const ct: CachedTool = { name: baseName, description: resource.description }
				newTools.push({
					name: baseName,
					description: resource.description ?? `Read resource: ${resource.uri}`,
					isDirect,
					wasDirect: prev !== undefined ? (server.tools.find((t) => t.name === baseName)?.wasDirect ?? false) : false,
					estimatedTokens: estimateTokens(ct),
				})
			}
		}

		server.tools = newTools
		this.rebuildVisibleItems()
		this.updateDirty()
	}

	render(width: number): string[] {
		const innerW = width - 2
		const lines: string[] = []
		const t = this.t
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`

		const row = (content: string) =>
			fg(t.border, "│") + truncateToWidth(" " + content, innerW, "…", true) + fg(t.border, "│")
		const emptyRow = () => fg(t.border, "│") + " ".repeat(innerW) + fg(t.border, "│")
		const divider = () => fg(t.border, "├" + "─".repeat(innerW) + "┤")

		const titleText = " MCP Servers "
		const borderLen = innerW - visibleWidth(titleText)
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"))

		lines.push(emptyRow())

		const cursor = fg(t.selected, "│")
		const searchIcon = fg(t.border, "◎")
		if (this.descSearchActive) {
			lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "desc:")} ${this.descQuery}${cursor}`))
		} else if (this.nameQuery) {
			lines.push(row(`${searchIcon}  ${this.nameQuery}${cursor}`))
		} else {
			lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("search..."))}`))
		}

		lines.push(emptyRow())
		lines.push(divider())

		if (this.servers.length === 0) {
			lines.push(emptyRow())
			lines.push(row(fg(t.hint, italic("No MCP servers configured."))))
			lines.push(emptyRow())
		} else {
			const total = this.visibleItems.length
			const { maxVis, startIdx, endIdx } = computeVisibleWindow(
				this.tui.terminal.rows,
				this.cursorIndex,
				total,
				{
					maxVisible: McpPanel.MAX_VISIBLE,
					minVisible: McpPanel.MIN_VISIBLE,
					fixedOverheadRows: McpPanel.FIXED_OVERHEAD_ROWS,
				},
			)

			lines.push(emptyRow())

			for (let i = startIdx; i < endIdx; i++) {
				const item = this.visibleItems[i]
				const isCursor = i === this.cursorIndex
				const server = this.servers[item.serverIndex]

				if (item.type === "server") {
					lines.push(row(this.renderServerRow(server, isCursor)))
				} else if (item.toolIndex !== undefined) {
					lines.push(row(this.renderToolRow(server.tools[item.toolIndex], isCursor, innerW)))
				}
			}

			lines.push(emptyRow())

			if (total > maxVis) {
				const prog = Math.round(((this.cursorIndex + 1) / total) * 10)
				lines.push(row(`${rainbowProgress(prog, 10)}  ${fg(t.hint, `${this.cursorIndex + 1}/${total}`)}`))
				lines.push(emptyRow())
			}

			if (this.importNotice) {
				lines.push(row(fg(t.needsAuth, italic(this.importNotice))))
				lines.push(emptyRow())
			}
			if (this.authNotice) {
				lines.push(row(fg(t.needsAuth, italic(this.authNotice))))
				lines.push(emptyRow())
			}
		}

		lines.push(divider())
		lines.push(emptyRow())

		if (this.confirmingDiscard) {
			const discardBtn =
				this.discardSelected === 0 ? inverse(bold(fg(t.cancel, "  Discard  "))) : fg(t.hint, "  Discard  ")
			const keepBtn = this.discardSelected === 1 ? inverse(bold(fg(t.confirm, "  Keep  "))) : fg(t.hint, "  Keep  ")
			lines.push(row(`Discard unsaved changes?  ${discardBtn}   ${keepBtn}`))
		} else {
			const directCount = this.servers.reduce((sum, s) => sum + s.tools.filter((t) => t.isDirect).length, 0)
			const totalTokens = this.servers.reduce(
				(sum, s) => sum + s.tools.filter((t) => t.isDirect).reduce((ts, t) => ts + t.estimatedTokens, 0),
				0,
			)
			const stats =
				directCount > 0 ? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens` : "no direct tools"
			lines.push(row(fg(t.description, stats + (this.dirty ? fg(t.needsAuth, "  (unsaved)") : ""))))
		}

		lines.push(emptyRow())
		const hints = [
			italic("↑↓") + " navigate",
			italic("space") + " toggle",
			italic("⏎") + " expand",
			italic("ctrl+r") + " reconnect",
			italic("?") + " desc search",
			italic("ctrl+s") + " save",
			italic("esc") + " clear/close",
			italic("ctrl+c") + " quit",
		]
		const gap = "  "
		const gapW = 2
		const maxW = innerW - 2
		let curLine = ""
		let curW = 0
		for (const hint of hints) {
			const hw = visibleWidth(hint)
			const needed = curW === 0 ? hw : gapW + hw
			if (curW > 0 && curW + needed > maxW) {
				lines.push(row(fg(t.hint, curLine)))
				curLine = hint
				curW = hw
			} else {
				curLine += (curW > 0 ? gap : "") + hint
				curW += needed
			}
		}
		if (curLine) lines.push(row(fg(t.hint, curLine)))

		lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"))

		return lines
	}

	private renderServerRow(server: ServerState, isCursor: boolean): string {
		const t = this.t
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`

		const expandIcon = server.expanded ? "▾" : "▸"
		const prefix = isCursor ? fg(t.selected, expandIcon) : fg(t.border, server.expanded ? expandIcon : "·")

		const nameStr = isCursor ? bold(fg(t.selected, server.name)) : server.name
		const importLabel = server.source === "import" ? fg(t.description, ` (${server.importKind ?? "import"})`) : ""

		if (!server.hasCachedData) {
			return `${prefix}   ${nameStr}${importLabel}  ${fg(t.description, "(not cached)")}`
		}

		const directCount = server.tools.filter((t) => t.isDirect).length
		const totalCount = server.tools.length
		let toggleIcon = fg(t.description, "○")
		if (directCount === totalCount && totalCount > 0) {
			toggleIcon = fg(t.direct, "●")
		} else if (directCount > 0) {
			toggleIcon = fg(t.needsAuth, "◐")
		}

		let toolInfo = ""
		if (totalCount > 0) {
			toolInfo = `${directCount}/${totalCount}`
			if (directCount > 0) {
				const tokens = server.tools.filter((t) => t.isDirect).reduce((s, t) => s + t.estimatedTokens, 0)
				toolInfo += `  ~${tokens.toLocaleString()}`
			}
			toolInfo = fg(t.description, toolInfo)
		}

		return `${prefix} ${toggleIcon} ${nameStr}${importLabel}  ${toolInfo}`
	}

	private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
		const t = this.t
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`

		const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○")
		const cursor = isCursor ? fg(t.selected, "▸") : " "
		const nameStr = isCursor ? bold(fg(t.selected, tool.name)) : tool.name

		const prefixLen = 7 + visibleWidth(tool.name)
		const maxDescLen = Math.max(0, innerW - prefixLen - 8)
		// Tool descriptions are often multi-line docstrings (e.g. "Args:\n  ..."). The
		// newlines have visible width 0 but break terminal layout when emitted. Collapse
		// any whitespace/control sequence to a single space before truncating.
		const flatDesc = tool.description ? tool.description.replace(/\s+/g, " ").trim() : ""
		const descStr =
			maxDescLen > 5 && flatDesc
				? fg(t.description, "— " + truncateToWidth(flatDesc, maxDescLen, "…"))
				: ""

		return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup()
	}
}

export function createMcpPanel(
	config: McpConfig,
	cache: MetadataCache | null,
	provenance: Map<string, ServerProvenance>,
	callbacks: McpPanelCallbacks,
	tui: { requestRender(force?: boolean): void; terminal: { rows: number } },
	done: (result: McpPanelResult) => void,
): McpPanel & { dispose(): void } {
	return new McpPanel(config, cache, provenance, callbacks, tui, done)
}
