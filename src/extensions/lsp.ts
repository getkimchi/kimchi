// extensions/lsp.ts
/**
 * LSP Extension
 *
 * Gives the agent type-aware code intelligence via LSP.
 * Supports TypeScript (typescript-language-server) and Go (gopls).
 *
 * Usage: kimchi -e extensions/lsp.ts
 */
import fs from "node:fs"
import path from "node:path"
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent"
import { isEditToolResult, isReadToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import {
	ensureFileOpen,
	getOrCreateClient,
	pullDiagnostics,
	refreshFile,
	sendRequest,
	shutdownAll,
	waitForDiagnostics,
} from "./lsp/client.js"
import { applyWorkspaceEdit } from "./lsp/edits.js"
import { detectMissingCandidates, detectServers, findRoot, serverForFile } from "./lsp/servers.js"
import type {
	Hover,
	Location,
	LocationLink,
	LspClient,
	ServerConfig,
	TextDocumentEdit,
	WorkspaceEdit,
} from "./lsp/types.js"
import { fileToUri, formatDiagnostic, uriToFile } from "./lsp/utils.js"
import { createSystemPromptBlocks } from "./prompt-construction/index.js"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"
import { markHarnessSteer } from "./steer-marker.js"

export function clientCwd(filePath: string, sessionCwd: string): string {
	if (filePath.startsWith(sessionCwd + path.sep) || filePath === sessionCwd) return sessionCwd
	return path.dirname(filePath)
}

const LSP_DIAGNOSTICS_CUSTOM_TYPE = "lsp_diagnostics"
const DIAG_WAIT_TIMEOUT_MS = 2000

/** Why a server+root is disabled for the session: the server never started
 *  ("start") or it started and then broke mid-session ("sync"). The status
 *  bar reports each accurately instead of calling everything a start
 *  failure. */
type FailurePhase = "start" | "sync"

/** All five LSP tool names. Hidden at session start when detection finds no
 *  language server for the session cwd. */
export const LSP_TOOL_NAMES = [
	"lsp_diagnostics",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_rename",
] as const

const LSP_SYSTEM_PROMPT = `## Language Server Protocol (LSP)

LSP tools provide type-aware code intelligence. Prefer them over text-based alternatives:
- Use \`lsp_diagnostics\` after editing a file to check for type errors — more precise than running the compiler manually.
- Use \`lsp_hover\` to inspect types and documentation — faster than reading source.
- Use \`lsp_definition\` to navigate to symbol definitions — more accurate than grep.
- Use \`lsp_references\` before renaming or deleting a symbol to understand full impact.
- Use \`lsp_rename\` for atomic cross-file renames — safer than find-and-replace.

LSP tools are available when language servers are detected on PATH (currently TypeScript and Go).`

export default function (pi: ExtensionAPI) {
	let cwd = ""
	let activeServers: ReturnType<typeof detectServers> = []
	let degradedServers: ReturnType<typeof detectMissingCandidates> = []
	let warned = false
	let ui: ExtensionUIContext | undefined
	// The five lsp_* tools (~670 est of
	// description+schema) are dead weight when no language server exists for the
	// session cwd — every execute() would only answer "No LSP server available".
	// Detection needs ctx.cwd, which only exists at session_start, so the gate
	// is a visibility vote rather than a registration skip: tools stay
	// registered but hidden from the advertised surface. The vote is static per
	// session — servers do not warm up later — so there is no reveal transition.
	const visibility = createToolVisibility(pi)
	// Tracks the pending diagnostic wait so a newer edit can cancel the previous
	// one (avoiding stale status-bar updates) and so session_shutdown can
	// abort any leftover waiter before tearing down clients. The local
	// controller is combined with ctx.signal so user/session aborts also unwind
	// the wait, but we never abort ctx.signal ourselves.
	let pendingRefresh: { abort: AbortController } | undefined

	// Servers that failed (e.g. typescript-language-server with no resolvable
	// tsserver.js — common in fresh worktrees without node_modules) are
	// remembered for the rest of the session and never re-spawned: without
	// environment changes (installing workspace deps) every attempt fails the
	// same way, and re-spawning on each file op re-prints the same error each
	// time. A mid-session crash is cached the same way because a dead server
	// keeps failing identically. Reset on session_start — the failure is often
	// fixed between sessions (e.g. by running the package installer), so a new
	// session retries.
	let failedClients = new Map<string, FailurePhase>()
	// The console line is reported once per server per session even when the
	// failure recurs on different roots (monorepo packages) — the issue's "one
	// human-readable line per session" — while per-root suppression above
	// still prevents pointless re-spawns of each distinct root.
	let reportedFailures = new Set<string>()

	function clientKey(server: ServerConfig, root: string): string {
		return `${server.command}:${root}`
	}

	function hasClientFailed(server: ServerConfig, root: string): boolean {
		return failedClients.has(clientKey(server, root))
	}

	/** Phase of the recorded failure for this server on any root, if any. */
	function failedPhaseFor(server: ServerConfig): FailurePhase | undefined {
		for (const [key, phase] of failedClients) {
			if (key.startsWith(`${server.command}:`)) return phase
		}
		return undefined
	}

	function failureLabel(phase: FailurePhase): string {
		return phase === "start" ? "failed to start" : "failed"
	}

	/** Status line combining healthy and failed servers, so a later successful
	 *  sync of one server doesn't erase another server's failure indicator in
	 *  mixed repos (e.g. gopls healthy while typescript failed to start). */
	function statusText(diagSuffix = ""): string {
		const parts = activeServers.map((s) => {
			const phase = failedPhaseFor(s)
			return phase ? `${s.name} ${failureLabel(phase)}` : s.name
		})
		return `LSP: ${parts.join(", ")}${diagSuffix}`
	}

	/** Record a failure once per server+root per session: reflect it in the
	 *  status bar and log a single one-line message per server (logging the
	 *  Error object itself would dump Bun's bundled-source code frame into
	 *  the TUI). Every failing path — file sync and the lsp_* tool starts —
	 *  records through here so tool-side failures get the same status
	 *  visibility. */
	function noteClientFailure(
		server: ServerConfig,
		root: string,
		err: unknown,
		phase: FailurePhase,
		statusUi: ExtensionUIContext | undefined,
	): void {
		const key = clientKey(server, root)
		if (failedClients.has(key)) return
		failedClients.set(key, phase)
		if (statusUi) {
			statusUi.setStatus(
				"lsp",
				activeServers.some((s) => s.command === server.command)
					? statusText()
					: `LSP: ${server.name} ${failureLabel(phase)}`,
			)
		}
		if (reportedFailures.has(server.name)) return
		reportedFailures.add(server.name)
		const msg = err instanceof Error ? err.message : String(err)
		// Say whether the server never started (spawn/initialize failure, e.g.
		// from an lsp_* tool) or broke mid-session while syncing a file.
		console.error(phase === "sync" ? `LSP file sync failed: ${msg}` : `LSP: ${server.name} failed to start: ${msg}`)
	}

	/** Like getOrCreateClient, but skips server+root pairs that already failed
	 *  this session instead of re-spawning a doomed server. Throws a
	 *  human-readable error so tool handlers surface something actionable. */
	async function startClient(server: ServerConfig, root: string): Promise<LspClient> {
		const phase = failedClients.get(clientKey(server, root))
		if (phase) {
			throw new Error(
				`LSP server ${server.name} ${failureLabel(phase)} for this session (see LSP status). Fix the underlying issue and start a new session to retry.`,
			)
		}
		try {
			return await getOrCreateClient(server, root)
		} catch (err) {
			noteClientFailure(server, root, err, "start", ui)
			throw err
		}
	}

	function cancelPendingRefresh(): void {
		if (!pendingRefresh) return
		pendingRefresh.abort.abort()
		pendingRefresh = undefined
	}

	createSystemPromptBlocks(pi, "lsp").register({
		id: "lsp-tools",
		render: () => (activeServers.length > 0 ? LSP_SYSTEM_PROMPT : undefined),
	})

	// ── Session start: detect servers, hook file sync, shutdown on exit ─────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		ui = ctx.hasUI ? ctx.ui : undefined
		warned = false
		degradedServers = []
		failedClients = new Map()
		reportedFailures = new Set()
		activeServers = detectServers(cwd)

		// Compute missing candidates independently of active servers. In a mixed
		// repo (e.g. both go.mod and package.json present but only one server
		// binary installed), this catches the missing server and surfaces it.
		degradedServers = detectMissingCandidates(cwd)
		if (degradedServers.length > 0 && ui) {
			const names = degradedServers.map((s) => s.name).join(", ")
			if (activeServers.length > 0) {
				// Partial degradation: some servers active, some missing
				const activeNames = activeServers.map((s) => s.name).join(", ")
				ui.setStatus("lsp", `LSP: ${activeNames} · ${names} not installed`)
			} else {
				ui.setStatus("lsp", `LSP: ${names} not installed`)
			}
		} else if (activeServers.length > 0 && ui) {
			const names = activeServers.map((s) => s.name).join(", ")
			ui.setStatus("lsp", `LSP: ${names}`)
		}

		if (activeServers.length === 0) {
			// Gate: hide the five lsp_* tools for this session.
			visibility.disable(LSP_TOOL_NAMES)
			return
		}

		// Eagerly start servers that have a project marker directly in sessionCwd
		const goMarkers = ["go.mod"]
		const tsMarkers = ["tsconfig.json", "package.json"]
		for (const server of activeServers) {
			const markers = server.name === "gopls" ? goMarkers : tsMarkers
			if (!markers.some((m) => fs.existsSync(path.join(cwd, m)))) continue
			getOrCreateClient(server, cwd).catch((err) => noteClientFailure(server, cwd, err, "start", ui))
		}
	})

	pi.on("session_shutdown", async () => {
		cancelPendingRefresh()
		if (ui) {
			ui.setStatus("lsp", undefined)
			ui = undefined
		}
		warned = false
		degradedServers = []
		failedClients = new Map()
		reportedFailures = new Set()
		shutdownAll()
	})

	// ── Degraded-state warning: notify once on the first agent turn ─────────────

	pi.on("before_agent_start", async () => {
		// One-time warning when in a project that would use LSP but has no
		// server binary on PATH. No-op on subsequent turns and when not degraded.
		if (warned || degradedServers.length === 0 || !ui?.notify) return
		const lines = degradedServers.map((s) => `${s.name} — install with: ${s.installHint ?? s.command}`)
		ui.notify(`LSP unavailable: language server(s) not installed for this project.\n${lines.join("\n")}`, "warning")
		warned = true
	})

	// ── File sync: refresh LSP after agent edits files ───────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		// Only react to read/edit/write tool results. The upstream guards narrow
		// `event` to one of these three result events so the toolName check is
		// removed; `event.input` is still `Record<string, unknown>` on result
		// events, so we narrow the path field with a runtime check.
		if (!isReadToolResult(event) && !isEditToolResult(event) && !isWriteToolResult(event)) return
		if (event.isError) return
		if (typeof event.input !== "object" || event.input === null) return

		const filePath = event.input.path
		if (typeof filePath !== "string") return

		const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
		const server = serverForFile(resolved, activeServers)
		if (!server) return
		// Resolve the project root the same way the lsp_* tools do (a nested
		// package in a monorepo is its own root), so the failure cache and the
		// spawned client are keyed by the same root whichever path sees the
		// file first.
		const root = findRoot(resolved, server.name, cwd)
		// Skip servers that already failed on this root this session —
		// re-spawning once per file op floods the output with the same error.
		if (hasClientFailed(server, root)) return

		const effectiveUi = ui ?? ctx.ui

		// Supersede any previous diagnostic wait for this handler. The local
		// controller is combined with ctx.signal so the wait also unwinds on
		// harness-level aborts.
		cancelPendingRefresh()
		const refreshController = new AbortController()
		pendingRefresh = { abort: refreshController }
		const combinedSignal = ctx.signal
			? AbortSignal.any([ctx.signal, refreshController.signal])
			: refreshController.signal

		// Distinguish why the sync failed: a server that never started
		// ("start") vs one that started and then broke while syncing
		// ("sync") — the status bar says which instead of calling every
		// failure a start failure. Diagnostics delivery to the agent
		// (sendMessage below) rides in the same best-effort sync bucket.
		let phase: FailurePhase = "start"
		try {
			const client = await getOrCreateClient(server, root)
			phase = "sync"
			if (isReadToolResult(event)) {
				// File was only read, not modified — just ensure LSP has it open
				await ensureFileOpen(client, resolved)
			} else {
				await refreshFile(client, resolved)
				const uri = fileToUri(resolved)
				// Diagnostics arrive via push (publishDiagnostics) on most servers
				// — wait for the notification with a deadline fallback. Pull-model
				// servers (e.g. the TypeScript 7 native server) never push, so fetch
				// explicitly. Both paths are best-effort: timeout/abort/request
				// failure resolves false and the sync continues.
				let gotDiagnostics = false
				if (server.pullDiagnostics) {
					try {
						await pullDiagnostics(client, uri)
						gotDiagnostics = true
					} catch {
						gotDiagnostics = false
					}
				} else {
					gotDiagnostics = await waitForDiagnostics(client, uri, {
						signal: combinedSignal,
						timeoutMs: DIAG_WAIT_TIMEOUT_MS,
					})
				}
				if (gotDiagnostics) {
					const entry = client.diagnostics.get(uri)
					const diags = entry?.diagnostics ?? []
					if (diags.length > 0) {
						const lines = diags.map((d) => formatDiagnostic(d))
						const relativePath = path.relative(cwd, resolved)
						// Inject diagnostics as a hidden custom message so the model
						// sees them as context (not as a visible user turn). Plain
						// text — no terminal coloring, since this is model-facing.
						const content = markHarnessSteer(`[LSP diagnostics for ${relativePath}]\n${lines.join("\n")}`)
						pi.sendMessage({ customType: LSP_DIAGNOSTICS_CUSTOM_TYPE, content, display: false }, { deliverAs: "steer" })
					}
				}

				// Update status bar with total diagnostic count across open files
				if (effectiveUi) {
					const totalDiags = [...client.diagnostics.values()].reduce((sum, entry) => sum + entry.diagnostics.length, 0)
					// Keep failure indicators for servers that failed this session —
					// this server's successful sync must not erase them.
					const diagPart = totalDiags > 0 ? ` (${totalDiags} diag${totalDiags === 1 ? "" : "s"})` : ""
					effectiveUi.setStatus("lsp", statusText(diagPart))
				}
			}
		} catch (err) {
			// Non-fatal: LSP sync failure doesn't break the agent. Record the
			// failure so subsequent file ops skip the dead server, and log one
			// message (logging the Error object dumps Bun's source code frame).
			noteClientFailure(server, root, err, phase, effectiveUi)
		} finally {
			if (pendingRefresh?.abort === refreshController) {
				pendingRefresh = undefined
			}
		}
	})

	// ── Tool: lsp_diagnostics ─────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP: Get Diagnostics",
		description:
			"Get type errors, warnings, and linter diagnostics for a file from the language server. Call after editing a file to check for errors. Returns empty list if no issues found.",
		promptSnippet: "Get LSP diagnostics (type errors, warnings) for a file",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or cwd-relative path to the file to check" }),
			wait_ms: Type.Optional(
				Type.Number({
					description: "Milliseconds to wait for diagnostics after refreshing (default 2000, max 10000)",
					default: 2000,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filePath = path.isAbsolute(params.file_path) ? params.file_path : path.join(cwd, params.file_path)
			const servers = activeServers.length > 0 ? activeServers : detectServers(cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }], details: null }
			}

			const client = await startClient(server, findRoot(filePath, server.name, cwd))
			await refreshFile(client, filePath)

			const waitMs = Math.min(params.wait_ms ?? 2000, 10000)
			const uri = fileToUri(filePath)
			if (server.pullDiagnostics) {
				// Pull-model servers (e.g. TypeScript 7 native): fetch instead of
				// waiting for a push notification that never comes.
				try {
					await pullDiagnostics(client, uri)
				} catch {
					// Best-effort: fall through and report whatever is cached.
				}
			} else {
				// Push-model servers: give publishDiagnostics time to arrive.
				await new Promise((resolve) => setTimeout(resolve, waitMs))
			}

			const entry = client.diagnostics.get(uri)
			if (!entry || entry.diagnostics.length === 0) {
				return { content: [{ type: "text", text: "No diagnostics found — file looks clean." }], details: null }
			}

			const lines = entry.diagnostics.map((d) => formatDiagnostic(d))
			return { content: [{ type: "text", text: lines.join("\n") }], details: null }
		},
		renderCall: lspRenderCall("LSP: Get Diagnostics"),
	})

	// ── Tool: lsp_hover ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP: Hover Info",
		description:
			"Get type information and documentation for a symbol at a specific position. Useful for understanding types before making changes.",
		promptSnippet: "Get LSP hover info (type, docs) at a file position",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or cwd-relative path to the file" }),
			line: Type.Number({ description: "0-based line number" }),
			character: Type.Number({ description: "0-based character offset" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filePath = path.isAbsolute(params.file_path) ? params.file_path : path.join(cwd, params.file_path)
			const servers = activeServers.length > 0 ? activeServers : detectServers(cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }], details: null }
			}

			const client = await startClient(server, findRoot(filePath, server.name, cwd))
			await ensureFileOpen(client, filePath)

			const result = (await sendRequest(client, "textDocument/hover", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			})) as Hover | null

			if (!result) {
				return { content: [{ type: "text", text: "No hover information available at this position." }], details: null }
			}

			const text = extractHoverText(result)
			return { content: [{ type: "text", text }], details: null }
		},
		renderCall: lspRenderCall("LSP: Hover Info"),
	})

	// ── Tool: lsp_definition ─────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP: Go to Definition",
		description:
			"Find the definition of a symbol at a position. Returns file path and line number. Pass method='typeDefinition' or method='implementation' for variants.",
		promptSnippet: "Navigate to definition/type-definition/implementation of a symbol",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or cwd-relative path to the file" }),
			line: Type.Number({ description: "0-based line number" }),
			character: Type.Number({ description: "0-based character offset" }),
			method: Type.Optional(
				Type.Union([Type.Literal("definition"), Type.Literal("typeDefinition"), Type.Literal("implementation")], {
					default: "definition",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filePath = path.isAbsolute(params.file_path) ? params.file_path : path.join(cwd, params.file_path)
			const servers = activeServers.length > 0 ? activeServers : detectServers(cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }], details: null }
			}

			const client = await startClient(server, findRoot(filePath, server.name, cwd))
			await ensureFileOpen(client, filePath)

			const lspMethod = `textDocument/${params.method ?? "definition"}`
			const result = (await sendRequest(client, lspMethod, {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			})) as Location | Location[] | LocationLink[] | null

			if (!result) {
				return { content: [{ type: "text", text: "No definition found." }], details: null }
			}

			const locations = normalizeLocations(result)
			const lines = locations.map((loc) => {
				const file = path.relative(cwd, uriToFile(loc.uri))
				return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
			})
			return { content: [{ type: "text", text: lines.join("\n") }], details: null }
		},
		renderCall: lspRenderCall("LSP: Go to Definition"),
	})

	// ── Tool: lsp_references ─────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_references",
		label: "LSP: Find References",
		description:
			"Find all references to a symbol across the codebase. Essential before renaming or deleting a symbol to understand the full impact.",
		promptSnippet: "Find all references to a symbol for refactoring impact analysis",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or cwd-relative path to the file" }),
			line: Type.Number({ description: "0-based line number" }),
			character: Type.Number({ description: "0-based character offset" }),
			include_declaration: Type.Optional(
				Type.Boolean({ description: "Include the declaration itself in results (default: true)", default: true }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filePath = path.isAbsolute(params.file_path) ? params.file_path : path.join(cwd, params.file_path)
			const servers = activeServers.length > 0 ? activeServers : detectServers(cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }], details: null }
			}

			const client = await startClient(server, findRoot(filePath, server.name, cwd))
			await ensureFileOpen(client, filePath)

			const result = (await sendRequest(client, "textDocument/references", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
				context: { includeDeclaration: params.include_declaration ?? true },
			})) as Location[] | null

			if (!result || result.length === 0) {
				return { content: [{ type: "text", text: "No references found." }], details: null }
			}

			const lines = result.map((loc) => {
				const file = path.relative(cwd, uriToFile(loc.uri))
				return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
			})
			return { content: [{ type: "text", text: `${result.length} reference(s):\n${lines.join("\n")}` }], details: null }
		},
		renderCall: lspRenderCall("LSP: Find References"),
	})

	// ── Tool: lsp_rename ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "lsp_rename",
		label: "LSP: Rename Symbol",
		description:
			"Atomically rename a symbol across all files. The language server computes all affected locations and the extension applies the edits. Returns a summary of changed files.",
		promptSnippet: "Rename a symbol across all files using the language server",
		parameters: Type.Object({
			file_path: Type.String({ description: "Absolute or cwd-relative path to the file containing the symbol" }),
			line: Type.Number({ description: "0-based line number of the symbol" }),
			character: Type.Number({ description: "0-based character offset of the symbol" }),
			new_name: Type.String({ description: "New name for the symbol" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filePath = path.isAbsolute(params.file_path) ? params.file_path : path.join(cwd, params.file_path)
			const servers = activeServers.length > 0 ? activeServers : detectServers(cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }], details: null }
			}

			const client = await startClient(server, findRoot(filePath, server.name, cwd))
			await ensureFileOpen(client, filePath)

			// Check if rename is valid at this position
			const prepareResult = await sendRequest(client, "textDocument/prepareRename", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			}).catch(() => null)

			if (prepareResult === null) {
				return {
					content: [{ type: "text", text: "Cannot rename: symbol at this position is not renameable." }],
					details: null,
				}
			}

			// Request the rename workspace edit
			const edit = (await sendRequest(client, "textDocument/rename", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
				newName: params.new_name,
			})) as WorkspaceEdit | null

			if (!edit) {
				return { content: [{ type: "text", text: "Rename returned no changes." }], details: null }
			}

			const applied = await applyWorkspaceEdit(edit, cwd)

			// Refresh all modified files in the client that performed the rename
			const affectedUris = [
				...Object.keys(edit.changes ?? {}),
				...(edit.documentChanges ?? [])
					.filter((c): c is TextDocumentEdit => "textDocument" in c)
					.map((c) => c.textDocument.uri),
			]
			for (const uri of affectedUris) {
				refreshFile(client, uriToFile(uri)).catch(() => {})
			}

			return { content: [{ type: "text", text: applied.join("\n") }], details: null }
		},
		renderCall: lspRenderCall("LSP: Rename Symbol"),
	})
}

// =============================================================================
// Helpers
// =============================================================================

function lspRenderCall(label: string) {
	return (args: Record<string, unknown>, theme: Theme, context: { lastComponent: unknown }): Container => {
		const filePath = (args.file_path as string | undefined) ?? ""
		const line = args.line !== undefined ? `:${(args.line as number) + 1}` : ""
		const char = args.character !== undefined ? `:${(args.character as number) + 1}` : ""
		const loc = filePath ? `${filePath}${line}${char}` : ""
		const header = `${theme.fg("muted", "-")} ${theme.fg("toolTitle", theme.bold(label))}`
		const fileLine = loc
			? `  ${theme.fg("muted", "file:")} ${theme.fg("accent", "`")}${theme.fg("accent", loc)}${theme.fg("accent", "`")}`
			: ""
		const text = fileLine ? `${header}\n${fileLine}` : header
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
		component.clear()
		component.addChild(new Text(text, 0, 0))
		return component
	}
}

function extractHoverText(hover: Hover): string {
	const c = hover.contents
	if (typeof c === "string") return c
	if (Array.isArray(c)) {
		return c
			.map((item) => (typeof item === "string" ? item : item.value))
			.filter(Boolean)
			.join("\n\n")
	}
	if ("value" in c) return c.value
	return String(c)
}

function normalizeLocations(result: Location | Location[] | LocationLink[]): Location[] {
	if (!Array.isArray(result)) return [result as Location]
	return (result as Array<Location | LocationLink>).map((item) => {
		if ("targetUri" in item) {
			return { uri: item.targetUri, range: item.targetSelectionRange }
		}
		return item as Location
	})
}
