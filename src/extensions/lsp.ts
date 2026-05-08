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
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { ensureFileOpen, getOrCreateClient, refreshFile, sendRequest, shutdownAll } from "./lsp/client.js"
import { applyWorkspaceEdit } from "./lsp/edits.js"
import { detectServers, findRoot, serverForFile } from "./lsp/servers.js"
import type { Hover, Location, LocationLink, TextDocumentEdit, WorkspaceEdit } from "./lsp/types.js"
import { fileToUri, formatDiagnostic, uriToFile } from "./lsp/utils.js"

export function clientCwd(filePath: string, sessionCwd: string): string {
	if (filePath.startsWith(sessionCwd + path.sep) || filePath === sessionCwd) return sessionCwd
	return path.dirname(filePath)
}

export default function (pi: ExtensionAPI) {
	let cwd = ""
	let activeServers: ReturnType<typeof detectServers> = []

	// ── Session start: detect servers, hook file sync, shutdown on exit ─────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		activeServers = detectServers(cwd)
		if (activeServers.length === 0) return

		// Eagerly start servers that have a project marker directly in sessionCwd
		const goMarkers = ["go.mod"]
		const tsMarkers = ["tsconfig.json", "package.json"]
		for (const server of activeServers) {
			const markers = server.name === "gopls" ? goMarkers : tsMarkers
			if (!markers.some((m) => fs.existsSync(path.join(cwd, m)))) continue
			getOrCreateClient(server, cwd).catch(() => {})
		}
	})

	pi.on("session_shutdown", async () => {
		shutdownAll()
	})

	// ── File sync: refresh LSP after agent edits files ───────────────────────────

	pi.on("tool_result", async (event) => {
		if (!("toolName" in event)) return
		if (event.toolName !== "edit" && event.toolName !== "write") return
		if (event.isError) return

		// Extract the file path from the tool input
		const input = event.input as Record<string, unknown>
		const filePath = (input.file_path ?? input.path) as string | undefined
		if (!filePath) return

		const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
		const server = serverForFile(resolved, activeServers)
		if (!server) return

		try {
			const client = await getOrCreateClient(server, cwd)
			await refreshFile(client, resolved)
		} catch {
			// Non-fatal: LSP sync failure doesn't break the agent
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

			const client = await getOrCreateClient(server, findRoot(filePath, server.name, cwd))
			await refreshFile(client, filePath)

			const waitMs = Math.min(params.wait_ms ?? 2000, 10000)
			await new Promise((resolve) => setTimeout(resolve, waitMs))

			const uri = fileToUri(filePath)
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

			const client = await getOrCreateClient(server, findRoot(filePath, server.name, cwd))
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

			const client = await getOrCreateClient(server, findRoot(filePath, server.name, cwd))
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

			const client = await getOrCreateClient(server, findRoot(filePath, server.name, cwd))
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

			const client = await getOrCreateClient(server, findRoot(filePath, server.name, cwd))
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
