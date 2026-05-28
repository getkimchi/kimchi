import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { formatAtMention } from "./at-mentions.js"
import { findMatchingLockfile, getLockfileDir, parseLockfile, scanLockfiles } from "./lockfile.js"
import { connectToIde } from "./mcp-client.js"
import type { AtMentionNotification, IdeConnection, IdeTool, SelectionChangedNotification } from "./types.js"

const POLL_INTERVAL_MS = 5000

/** Max number of at-mentions to queue before dropping oldest. */
const MAX_PENDING_MENTIONS = 100

/** Max reconnect attempts before giving up on discovery polling. */
const MAX_RECONNECT_RETRIES = 3

export default function ideAdapterExtension(pi: ExtensionAPI): void {
	let connection: IdeConnection | null = null
	let pollTimer: ReturnType<typeof setInterval> | null = null
	let registeredToolNames: string[] = []
	let isShuttingDown = false
	let reconnectRetries = 0

	// Per-instance mutable state (isolated from other sessions/agents)
	let pendingAtMentions: AtMentionNotification[] = []
	let latestSelection: SelectionChangedNotification | null = null

	function ensureMaxMentions(): void {
		if (pendingAtMentions.length > MAX_PENDING_MENTIONS) {
			pendingAtMentions = pendingAtMentions.slice(-MAX_PENDING_MENTIONS)
		}
	}

	function localQueueAtMention(mention: AtMentionNotification): void {
		pendingAtMentions.push(mention)
		ensureMaxMentions()
	}

	function localDrainAtMentions(): string[] {
		const formatted = pendingAtMentions.map(formatAtMention)
		pendingAtMentions = []
		return formatted
	}

	function localHasPendingAtMentions(): boolean {
		return pendingAtMentions.length > 0
	}

	function localSetLatestSelection(selection: SelectionChangedNotification): void {
		latestSelection = selection
	}

	async function discoverAndConnect(cwd: string): Promise<void> {
		if (isShuttingDown) return
		if (connection) return

		const dir = getLockfileDir()
		const lockfilePaths = scanLockfiles(dir)
		const lockfiles = lockfilePaths.map(parseLockfile).filter((l) => l !== null)
		if (lockfiles.length === 0) return

		const match = findMatchingLockfile(lockfiles, cwd)
		if (!match) return

		try {
			const newConnection = await connectToIde(match)
			if (isShuttingDown) {
				await newConnection.close()
				return
			}
			connection = newConnection
			reconnectRetries = 0
			console.log(`[ide-adapter] Connected to ${match.ideName} (${match.ideVersion})`)
		} catch (err) {
			reconnectRetries++
			console.warn(
				`[ide-adapter] Failed to connect to ${match.ideName} (attempt ${reconnectRetries}/${MAX_RECONNECT_RETRIES}):`,
				err,
			)
			if (reconnectRetries >= MAX_RECONNECT_RETRIES) {
				console.warn(
					`[ide-adapter] Max reconnect retries (${MAX_RECONNECT_RETRIES}) reached. Stopping discovery polling.`,
				)
				if (pollTimer) {
					clearInterval(pollTimer)
					pollTimer = null
				}
			}
			return
		}

		// Wire disconnect callback so we can null the handle and reconnect later
		connection.onDisconnect = () => {
			connection = null
			registeredToolNames = []
		}

		try {
			const tools = await connection.listTools()
			for (const tool of tools) {
				if (isShuttingDown) break
				registerIdeTool(pi, tool)
			}
			registeredToolNames = tools.map((t) => t.name)
			console.log(`[ide-adapter] Registered ${tools.length} IDE tool(s): ${registeredToolNames.join(", ")}`)
		} catch (err) {
			console.warn("[ide-adapter] Failed to list IDE tools:", err)
		}

		connection.setNotificationHandler((msg) => {
			dispatchNotification(msg)
		})
	}

	function registerIdeTool(pi: ExtensionAPI, tool: IdeTool): void {
		pi.registerTool({
			name: `ide_${tool.name}`,
			label: `IDE: ${tool.name}`,
			description: tool.description || `IDE tool: ${tool.name}`,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema || { type: "object", properties: {} }),
			execute: async (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate, ctx) => {
				if (signal?.aborted) {
					return {
						content: [{ type: "text" as const, text: "Tool call aborted" }],
						details: { error: "aborted" },
					}
				}
				if (!connection) {
					return {
						content: [{ type: "text" as const, text: "IDE connection lost" }],
						details: { error: "IDE connection lost" },
					}
				}
				try {
					const result = await connection.callTool(tool.name, params)
					if (signal?.aborted) {
						return {
							content: [{ type: "text" as const, text: "Tool call aborted" }],
							details: { error: "aborted" },
						}
					}
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: result,
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					return {
						content: [{ type: "text" as const, text: `IDE tool error: ${message}` }],
						details: { error: message },
					}
				}
			},
		})
	}

	function dispatchNotification(msg: unknown): void {
		if (typeof msg !== "object" || msg === null) return
		const m = msg as Record<string, unknown>
		if (m.method !== "at_mentioned" && m.method !== "selection_changed") return
		if (typeof m.params !== "object" || m.params === null) return
		const params = m.params as Record<string, unknown>

		if (m.method === "at_mentioned") {
			if (typeof params.filePath === "string") {
				localQueueAtMention({
					filePath: params.filePath,
					lineStart: typeof params.lineStart === "number" ? params.lineStart : 0,
					lineEnd: typeof params.lineEnd === "number" ? params.lineEnd : 0,
				})
			}
		} else if (m.method === "selection_changed") {
			if (typeof params.filePath === "string") {
				localSetLatestSelection({
					filePath: params.filePath,
					lineStart: typeof params.lineStart === "number" ? params.lineStart : 0,
					lineEnd: typeof params.lineEnd === "number" ? params.lineEnd : 0,
				})
			}
		}
	}

	function disconnect(): void {
		// Guard against timer leak if session_start fires multiple times
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}
		if (connection) {
			// Prevent onDisconnect from clearing a stale handle after we intentionally close
			const conn = connection
			connection = null
			registeredToolNames = []
			conn.close().catch((err) => console.warn("[ide-adapter] Disconnect error:", err))
		}
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const cwd = ctx.cwd
		isShuttingDown = false
		reconnectRetries = 0

		// Prevent duplicate poll timers on reconnect
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}

		discoverAndConnect(cwd).catch((err) => console.warn("[ide-adapter] Discovery error:", err))

		pollTimer = setInterval(() => {
			discoverAndConnect(cwd).catch((err) => console.warn("[ide-adapter] Polling discovery error:", err))
		}, POLL_INTERVAL_MS)
	})

	pi.on("input", (event) => {
		if (!localHasPendingAtMentions()) return

		const mentions = localDrainAtMentions()
		if (mentions.length === 0) return

		const prefix = mentions.join(" ")
		const text = event.text.trimStart()
		const newText = text ? `${prefix} ${text}` : prefix

		return { action: "transform" as const, text: newText }
	})

	pi.on("session_shutdown", () => {
		isShuttingDown = true
		disconnect()
	})
}
