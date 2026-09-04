import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { markHarnessSteer } from "../steer-marker.js"
import { setIdeSelectionIndicator } from "../ui.js"
import { formatAtMention } from "./at-mentions.js"
import { applyEditInput } from "./edit-apply.js"
import { findMatchingLockfile, getLockfileDir, parseLockfile, scanLockfiles } from "./lockfile.js"
import { connectToIde } from "./mcp-client.js"
import type { AtMentionNotification, IdeConnection, IdeTool, SelectionChangedNotification } from "./types.js"

const POLL_INTERVAL_MS = 5000

/** Module-level flag indicating whether the current process has an active IDE connection.
 * Used by other extensions (e.g. permissions) to decide whether to defer to the IDE.
 * This is coarse-grained by design: there is at most one active IDE session per Kimchi process. */
let ideConnectionActive = false

/** Return true if an IDE connection is currently active. */
export function isIdeConnected(): boolean {
	return ideConnectionActive
}

/** Max number of at-mentions to queue before dropping oldest. */
const MAX_PENDING_MENTIONS = 100

/** Max reconnect attempts before giving up on discovery polling. */
const MAX_RECONNECT_RETRIES = 3

/** Tool names that mutate files and must be gated by IDE approval when enabled. */
const APPROVAL_GATED_TOOLS = new Set(["write", "edit"])

/** Short unique id for IDE tool-window queue tracking. */
function generateChangeId(): string {
	return `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Read a file's current contents. Returns "" for missing files (ENOENT),
 * or `null` if the file exists but cannot be read (e.g. permission denied).
 * A `null` return propagates to `computeProposedChange` → `null`, which the
 * `tool_call` handler treats as a hard block so the user is never shown a
 * diff that hides the file's real contents. */
function readCurrentContent(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8")
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return ""
		console.warn(`[ide-adapter] Failed to read ${filePath}:`, err)
		return null
	}
}

/** Compute the proposed new content for a `write`/`edit` call. Returns `null`
 * on malformed input (e.g. edit `oldText` not found) so the hook defers to
 * the tool's own validation. */
function computeProposedChange(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { filePath: string; originalContent: string; newContent: string } | null {
	const rawPath =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : ""
	if (!rawPath) return null
	const filePath = resolve(cwd, rawPath)
	const originalContent = readCurrentContent(filePath)
	if (originalContent === null) return null

	if (toolName === "write") {
		const newContent = typeof input.content === "string" ? input.content : ""
		return { filePath, originalContent, newContent }
	}

	// edit
	const newContent = applyEditInput(originalContent, input as Parameters<typeof applyEditInput>[1])
	if (newContent === null) return null
	return { filePath, originalContent, newContent }
}

/** Result of an IDE approval request. `approved: true` carries the user's
 * (possibly hand-edited) `newContent`; `approved: false` means rejected.
 * `null` means the IDE call failed (network error, malformed response, or
 * abort). The caller treats `null` as a hard block — the tool will not
 * execute without either IDE or terminal approval. */
interface IdeApprovalResult {
	approved: boolean
	newContent: string | null
}

/** Call the IDE's `proposeChange` tool and return the approval result, or
 * `null` on failure (network error, malformed response, abort). */
async function requestIdeApproval(
	connection: IdeConnection,
	params: { filePath: string; originalContent: string; newContent: string; changeId: string },
	signal: AbortSignal | undefined,
): Promise<IdeApprovalResult | null> {
	if (signal?.aborted) return null
	try {
		const result = await connection.callTool("proposeChange", params, signal)
		if (signal?.aborted) return null
		const payload = unwrapMcpToolResult(result)
		if (payload && typeof payload === "object" && "approved" in payload) {
			const approved = Boolean((payload as { approved: unknown }).approved)
			const newContent = approved ? stringValue((payload as { newContent?: unknown }).newContent) : null
			return { approved, newContent }
		}
		return null
	} catch (err) {
		console.warn("[ide-adapter] proposeChange request failed:", err)
		return null
	}
}

/** Coerce to string or null. */
function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null
}

/** Override the agent's write/edit input with the user's hand-edited content
 * from the IDE diff viewer. `write` sets `input.content`; `edit` rewrites
 * `input.edits` as a single full-file replacement (robust vs. fragment-level
 * reconstruction). Both branches normalise `path`/`file_path`. */
function applyEditedContent(
	input: Record<string, unknown>,
	toolName: string,
	editedNewContent: string,
	originalContent: string,
): void {
	if (toolName === "write") {
		input.content = editedNewContent
		if (typeof input.path !== "string" && typeof input.file_path === "string") input.path = input.file_path
		return
	}
	// edit → rewrite as a single full-file replacement.
	input.edits = [{ oldText: originalContent, newText: editedNewContent }]
	// Drop legacy single-operation fields so the tool doesn't see conflicting shapes.
	input.oldText = undefined
	input.newText = undefined
	input.old_text = undefined
	input.new_text = undefined
	if (typeof input.path !== "string" && typeof input.file_path === "string") input.path = input.file_path
}

/** Extract the JSON payload from an MCP `CallToolResult` envelope:
 * `{ content: [{ type: "text", text: "<json-stringified-result>" }] }`.
 * Returns `null` on malformed envelopes or invalid JSON. */
function unwrapMcpToolResult(result: unknown): unknown {
	if (!result || typeof result !== "object") return null
	const envelope = result as { content?: unknown }
	const content = envelope.content
	if (!Array.isArray(content) || content.length === 0) return null
	const first = content[0]
	if (!first || typeof first !== "object") return null
	const text = (first as { text?: unknown }).text
	if (typeof text !== "string") return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

export default function ideAdapterExtension(pi: ExtensionAPI): void {
	let connection: IdeConnection | null = null
	let pollTimer: ReturnType<typeof setInterval> | null = null
	let isShuttingDown = false
	let reconnectRetries = 0

	// Per-instance mutable state (isolated from other sessions/agents)
	let pendingAtMentions: AtMentionNotification[] = []
	let _latestSelection: SelectionChangedNotification | null = null
	let currentCtx: ExtensionContext | null = null

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

	function localSetLatestSelection(selection: SelectionChangedNotification | null): void {
		_latestSelection = selection
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
			ideConnectionActive = true
			reconnectRetries = 0
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

		// Wire disconnect callback so we can null the handle and reconnect later.
		// Capture the connection reference so a stale WebSocket closing after
		// a reconnect doesn't wipe the live handle.
		const connRef = connection
		connection.onDisconnect = () => {
			if (connection === connRef) {
				connection = null
				ideConnectionActive = false
			}
		}

		try {
			const tools = await connection.listTools()
			for (const tool of tools) {
				if (isShuttingDown) break
				registerIdeTool(pi, tool)
			}
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
			execute: async (_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate, _ctx) => {
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
				// The IDE is the authority on file paths (CONTRACT.md): it sends
				// absolute paths and the agent's tools resolve them regardless of
				// cwd, so pass the path through verbatim.
				const filePath = params.filePath
				const mention: AtMentionNotification = {
					filePath,
					lineStart: typeof params.lineStart === "number" ? params.lineStart : 0,
					lineEnd: typeof params.lineEnd === "number" ? params.lineEnd : 0,
				}
				if (currentCtx?.hasUI) {
					try {
						currentCtx.ui.pasteToEditor(formatAtMention(mention))
						// Force an immediate TUI render so the pasted text appears
						// without waiting for the next user input event.
						currentCtx.ui.setStatus("ide-adapter-mention", undefined)
					} catch (err) {
						// If paste fails (e.g. no active editor), fall back to queue
						console.warn("[ide-adapter] pasteToEditor failed, falling back to queue:", err)
						localQueueAtMention(mention)
					}
				} else {
					localQueueAtMention(mention)
				}
			}
		} else if (m.method === "selection_changed") {
			if (typeof params.filePath === "string") {
				// Pass the IDE-supplied absolute path through verbatim (see `at_mentioned` above).
				const filePath = params.filePath
				const lineStart = typeof params.lineStart === "number" ? params.lineStart : 0
				const lineEnd = typeof params.lineEnd === "number" ? params.lineEnd : 0

				if (lineStart === 0 && lineEnd === 0) {
					// Per CONTRACT.md: lineStart: 0 and lineEnd: 0 mean "no range" —
					// clear the selection indicator and sticky selection.
					localSetLatestSelection(null)
					if (currentCtx?.hasUI) {
						setIdeSelectionIndicator(null)
					}
				} else {
					const selection: SelectionChangedNotification = { filePath, lineStart, lineEnd }
					localSetLatestSelection(selection)
					// Surface as a right-aligned indicator inside the input box's top
					// border — a dedicated segment alongside (not replacing) the pending
					// image indicator. The selection is also kept sticky in
					// `_latestSelection` for auto-attach on send (see `pi.on('input')`).
					if (currentCtx?.hasUI) {
						setIdeSelectionIndicator(formatAtMention(selection))
					}
				}
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
			ideConnectionActive = false
			conn.close().catch((err) => console.warn("[ide-adapter] Disconnect error:", err))
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName
		if (!toolName || !APPROVAL_GATED_TOOLS.has(toolName)) return undefined

		// IDE diff approval only applies in default mode. In auto/yolo the user
		// has explicitly opted out of per-file approval, and in plan mode
		// write/edit are already blocked by the permissions extension.
		const mode = ctx.sessionManager ? getPermissionMode(ctx.sessionManager.getSessionId())?.mode : undefined
		if (mode !== "default") {
			return undefined
		}

		// When an IDE session is active, the permissions extension skips its
		// terminal approval prompt for write/edit, deferring to the IDE diff
		// viewer. This makes the ide-adapter the sole approval authority — every
		// failure path must block to prevent ungated execution.
		if (!ideConnectionActive) {
			return undefined
		}

		if (!connection) {
			// IDE was active but the connection dropped before this hook ran.
			return {
				block: true,
				reason: `IDE connection was lost. ${toolName} is blocked to prevent ungated execution. Try again, or disconnect the IDE to fall back to terminal approval.`,
			}
		}

		const input = (event.input ?? {}) as Record<string, unknown>
		const proposed = computeProposedChange(toolName, input, ctx.cwd)
		if (!proposed) {
			// Can't build a proposal (malformed input, unreadable file, etc.).
			// Block rather than deferring, since permissions already skipped.
			return {
				block: true,
				reason: `Could not compute the proposed change for ${toolName}. The input may be malformed or the file unreadable. Try again, or disconnect the IDE to fall back to terminal approval.`,
			}
		}

		const changeId = generateChangeId()
		const approval = await requestIdeApproval(connection, { ...proposed, changeId }, ctx.signal)
		if (approval === null) {
			// IDE call failed (network error, malformed response, or abort).
			// block the tool so it cannot execute without either IDE or terminal approval.
			console.warn(`[ide-adapter] proposeChange call failed for ${proposed.filePath}; blocking ${toolName}`)
			return {
				block: true,
				reason: `IDE approval failed for ${proposed.filePath}. The IDE could not be reached or returned a malformed response. Try again, or disconnect the IDE to fall back to terminal approval.`,
			}
		}
		if (!approval.approved) {
			return {
				block: true,
				reason: `User rejected the proposed change to ${proposed.filePath} in the IDE diff viewer.`,
			}
		}

		// Approved. If the user hand-edited the proposed content in the IDE diff
		// viewer, override the tool's input so the agent applies the user's final
		// version instead of its original proposal.
		if (approval.newContent !== null && approval.newContent !== proposed.newContent) {
			applyEditedContent(input, toolName, approval.newContent, proposed.originalContent)
			event.input = input
			// Steer the LLM so its summary reflects what was actually written, not
			// its original proposal. Without this, the agent confidently reports
			// the proposed value even though the user changed it in the diff viewer.
			try {
				pi.sendMessage(
					{
						customType: "ide-adapter-edit-steer",
						content: [
							{
								type: "text",
								text: markHarnessSteer(
									`The user hand-edited your proposed change to ${proposed.filePath} in the IDE diff viewer before it was applied. The actual content written to disk differs from your original proposal — do not assume your proposed content was applied verbatim. If you need to reference the exact value, read the file from disk.`,
								),
							},
						],
						display: false,
					},
					{ deliverAs: "steer" },
				)
			} catch (err) {
				console.warn("[ide-adapter] Failed to send steer message:", err)
			}
		}
		return undefined
	})

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		currentCtx = ctx
		const cwd = ctx.cwd
		isShuttingDown = false
		reconnectRetries = 0

		// Reset stale connection state from a prior session so that
		// `ideConnectionActive` doesn't carry over after the old IDE disconnected.
		connection = null
		ideConnectionActive = false

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
		// Drain pending at-mentions (manual Cmd+Option+K path). Empty if none queued.
		const mentions = localHasPendingAtMentions() ? localDrainAtMentions() : []

		// Auto-attach the current IDE selection (sticky). The selection is NOT
		// consumed — it stays "in sync" with the IDE so every send re-attaches
		// whatever is currently selected, until a new selection_changed overwrites it.
		const selectionMention = _latestSelection ? formatAtMention(_latestSelection) : null

		// Dedup: if the user explicitly at-mentioned the same range they have
		// selected (e.g. Cmd+Option+K on the active selection), don't double-prefix.
		const selectionPrefix = selectionMention && !mentions.includes(selectionMention) ? selectionMention : null

		const prefixes = selectionPrefix ? [...mentions, selectionPrefix] : mentions
		if (prefixes.length === 0) return

		const prefix = prefixes.join(" ")
		const text = event.text.trimStart()
		const newText = text ? `${prefix} ${text}` : prefix

		return { action: "transform" as const, text: newText }
	})

	pi.on("session_shutdown", () => {
		currentCtx = null
		isShuttingDown = true
		// Clear the input-box selection indicator so it doesn't persist into
		// the next session (the PromptEditor instance is reused).
		setIdeSelectionIndicator(null)
		disconnect()
	})
}
