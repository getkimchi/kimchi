# LSP Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional LSP extension (`extensions/lsp.ts`) that gives the kimchi agent type-aware code intelligence via diagnostics, hover, definition, references, and rename — loadable with `kimchi -e extensions/lsp.ts`.

**Architecture:** A self-contained Bun process extension that spawns LSP server processes on demand (lazy init), maintains per-cwd client state, hooks into `tool_result` events to keep file state in sync, and registers LLM-callable tools (`lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_rename`). Rename applies workspace edits via the agent's own write path (`node:fs/promises`) to preserve agent state integrity. Supports TypeScript (`typescript-language-server`) and Go (`gopls`) in v1.

**Tech Stack:** TypeScript, Bun (spawn, file I/O), pi-coding-agent ExtensionAPI, TypeBox (parameter schemas), Vitest (tests)

---

## File Structure

```
extensions/
  lsp.ts              ← extension entry point: registers tools + hooks file sync
  lsp/
    client.ts         ← LSP client: JSON-RPC, lifecycle, file sync, request/notify
    types.ts          ← TypeScript types for LSP protocol messages
    edits.ts          ← applyWorkspaceEdit + applyTextEditsToString (for rename)
    servers.ts        ← server configs + auto-detection by cwd
    utils.ts          ← fileToUri, uriToFile, detectLanguageId, formatDiagnostic
```

**Test files:**
```
src/extensions/lsp/
  edits.test.ts       ← unit tests for text edit application (pure functions, easy to test)
  utils.test.ts       ← unit tests for URI conversion and language detection
```

> Note: `client.ts` and `servers.ts` involve process spawning and are not unit-tested here — they are verified by running kimchi with the extension loaded.

---

## Task 1: Types

**Files:**
- Create: `extensions/lsp/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// extensions/lsp/types.ts

export interface Position {
	line: number
	character: number
}

export interface Range {
	start: Position
	end: Position
}

export interface Location {
	uri: string
	range: Range
}

export interface LocationLink {
	originSelectionRange?: Range
	targetUri: string
	targetRange: Range
	targetSelectionRange: Range
}

export interface TextEdit {
	range: Range
	newText: string
}

export interface TextDocumentEdit {
	textDocument: { uri: string; version?: number | null }
	edits: TextEdit[]
}

export interface CreateFile {
	kind: "create"
	uri: string
}

export interface RenameFile {
	kind: "rename"
	oldUri: string
	newUri: string
}

export interface DeleteFile {
	kind: "delete"
	uri: string
}

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>
	documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[]
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4

export interface Diagnostic {
	range: Range
	severity?: DiagnosticSeverity
	code?: string | number
	source?: string
	message: string
}

export interface PublishDiagnosticsParams {
	uri: string
	version?: number
	diagnostics: Diagnostic[]
}

export interface Hover {
	contents:
		| string
		| { language?: string; value: string }
		| { kind: "markdown" | "plaintext"; value: string }
		| Array<string | { language?: string; value: string }>
	range?: Range
}

export interface DocumentSymbol {
	name: string
	kind: number
	range: Range
	selectionRange: Range
	children?: DocumentSymbol[]
}

export interface LspJsonRpcRequest {
	jsonrpc: "2.0"
	id: number
	method: string
	params: unknown
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0"
	id: number
	result?: unknown
	error?: { code: number; message: string; data?: unknown }
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0"
	method: string
	params?: unknown
}

export interface OpenFileInfo {
	version: number
	languageId: string
}

export interface PendingRequest {
	resolve: (value: unknown) => void
	reject: (reason: Error) => void
	method: string
}

export interface LspClient {
	name: string
	cwd: string
	proc: ReturnType<typeof Bun.spawn>
	requestId: number
	diagnostics: Map<string, { diagnostics: Diagnostic[]; version: number | null }>
	diagnosticsVersion: number
	openFiles: Map<string, OpenFileInfo>
	pendingRequests: Map<number, PendingRequest>
	messageBuffer: Buffer
	isReading: boolean
	lastActivity: number
	activeProgressTokens: Set<string | number>
	projectLoaded: Promise<void>
	resolveProjectLoaded: () => void
}

export interface ServerConfig {
	name: string
	command: string
	args?: string[]
	extensions: string[]
	initOptions?: Record<string, unknown>
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1 | head -20
```

Expected: no errors from `extensions/lsp/types.ts`

- [ ] **Step 3: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp/types.ts
git commit -m "feat(lsp): add LSP protocol types"
```

---

## Task 2: Utilities (fileToUri, uriToFile, detectLanguageId, formatDiagnostic)

**Files:**
- Create: `extensions/lsp/utils.ts`
- Create: `src/extensions/lsp/utils.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/extensions/lsp/utils.test.ts
import { describe, expect, it } from "vitest"
import { detectLanguageId, fileToUri, formatDiagnostic, uriToFile } from "../../../extensions/lsp/utils.js"

describe("fileToUri", () => {
	it("converts absolute unix path to file URI", () => {
		expect(fileToUri("/home/user/foo.ts")).toBe("file:///home/user/foo.ts")
	})

	it("resolves relative paths", () => {
		const result = fileToUri("foo.ts")
		expect(result).toMatch(/^file:\/\/\//)
		expect(result).toMatch(/foo\.ts$/)
	})
})

describe("uriToFile", () => {
	it("converts file URI back to path", () => {
		expect(uriToFile("file:///home/user/foo.ts")).toBe("/home/user/foo.ts")
	})

	it("passes through non-file URIs", () => {
		expect(uriToFile("untitled:foo")).toBe("untitled:foo")
	})

	it("round-trips with fileToUri", () => {
		const path = "/tmp/test/bar.go"
		expect(uriToFile(fileToUri(path))).toBe(path)
	})
})

describe("detectLanguageId", () => {
	it("detects TypeScript", () => {
		expect(detectLanguageId("foo.ts")).toBe("typescript")
	})

	it("detects TypeScript JSX", () => {
		expect(detectLanguageId("foo.tsx")).toBe("typescriptreact")
	})

	it("detects Go", () => {
		expect(detectLanguageId("foo.go")).toBe("go")
	})

	it("detects JavaScript", () => {
		expect(detectLanguageId("foo.js")).toBe("javascript")
	})

	it("falls back to plaintext for unknown", () => {
		expect(detectLanguageId("foo.xyz")).toBe("plaintext")
	})
})

describe("formatDiagnostic", () => {
	it("formats an error diagnostic", () => {
		const result = formatDiagnostic({
			range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
			severity: 1,
			message: "Cannot find name 'foo'",
		})
		expect(result).toBe("5:3 error: Cannot find name 'foo'")
	})

	it("formats a warning diagnostic with code", () => {
		const result = formatDiagnostic({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 2,
			code: "TS2345",
			message: "Type mismatch",
		})
		expect(result).toBe("1:1 warning [TS2345]: Type mismatch")
	})

	it("defaults to error severity when missing", () => {
		const result = formatDiagnostic({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			message: "something wrong",
		})
		expect(result).toContain("error")
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/utils.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '…/extensions/lsp/utils.js'`

- [ ] **Step 3: Create utils.ts**

```typescript
// extensions/lsp/utils.ts
import path from "node:path"
import type { Diagnostic } from "./types.js"

// =============================================================================
// URI Handling
// =============================================================================

export function fileToUri(filePath: string): string {
	const resolved = path.resolve(filePath)
	if (process.platform === "win32") {
		return `file:///${resolved.replace(/\\/g, "/")}`
	}
	return `file://${resolved}`
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri
	let filePath = decodeURIComponent(uri.slice(7))
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1)
	}
	return filePath
}

// =============================================================================
// Language Detection
// =============================================================================

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescriptreact",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascriptreact",
	mjs: "javascript",
	cjs: "javascript",
	go: "go",
	rs: "rust",
	py: "python",
	rb: "ruby",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sh: "shellscript",
	bash: "shellscript",
}

export function detectLanguageId(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return EXT_TO_LANG[ext] ?? "plaintext"
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

const SEVERITY_NAMES: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
}

export function formatDiagnostic(d: Diagnostic): string {
	const line = d.range.start.line + 1
	const col = d.range.start.character + 1
	const sev = SEVERITY_NAMES[d.severity ?? 1] ?? "error"
	const code = d.code !== undefined ? ` [${d.code}]` : ""
	return `${line}:${col} ${sev}${code}: ${d.message}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/utils.test.ts 2>&1 | tail -10
```

Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp/utils.ts src/extensions/lsp/utils.test.ts
git commit -m "feat(lsp): add URI, language detection, and diagnostic formatting utilities"
```

---

## Task 3: Text Edit Application (for rename)

**Files:**
- Create: `extensions/lsp/edits.ts`
- Create: `src/extensions/lsp/edits.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/extensions/lsp/edits.test.ts
import { describe, expect, it } from "vitest"
import { applyTextEditsToString } from "../../../extensions/lsp/edits.js"

describe("applyTextEditsToString", () => {
	it("applies a single-line replacement", () => {
		const content = "const foo = 1\nconst bar = 2\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
				newText: "baz",
			},
		])
		expect(result).toBe("const baz = 1\nconst bar = 2\n")
	})

	it("applies multiple edits in bottom-to-top order", () => {
		const content = "aaa\nbbb\nccc\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
				newText: "AAA",
			},
			{
				range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
				newText: "CCC",
			},
		])
		expect(result).toBe("AAA\nbbb\nCCC\n")
	})

	it("applies a multi-line replacement", () => {
		const content = "function foo() {\n  return 1\n}\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 9 }, end: { line: 2, character: 1 } },
				newText: "bar() {\n  return 2\n}",
			},
		])
		expect(result).toBe("function bar() {\n  return 2\n}\n")
	})

	it("handles insertion (empty range)", () => {
		const content = "hello world\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
				newText: " beautiful",
			},
		])
		expect(result).toBe("hello beautiful world\n")
	})

	it("handles deletion (empty newText)", () => {
		const content = "hello world\n"
		const result = applyTextEditsToString(content, [
			{
				range: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
				newText: "",
			},
		])
		expect(result).toBe("hello\n")
	})

	it("returns content unchanged for empty edits array", () => {
		const content = "unchanged\n"
		expect(applyTextEditsToString(content, [])).toBe("unchanged\n")
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/edits.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '…/extensions/lsp/edits.js'`

- [ ] **Step 3: Create edits.ts**

```typescript
// extensions/lsp/edits.ts
import * as fs from "node:fs/promises"
import path from "node:path"
import type { TextEdit, WorkspaceEdit } from "./types.js"
import { uriToFile } from "./utils.js"

export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	if (edits.length === 0) return content
	const lines = content.split("\n")

	const sorted = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line
		return b.range.start.character - a.range.start.character
	})

	for (const edit of sorted) {
		const { start, end } = edit.range
		if (start.line === end.line) {
			const line = lines[start.line] ?? ""
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character)
		} else {
			const startLine = lines[start.line] ?? ""
			const endLine = lines[end.line] ?? ""
			const merged = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character)
			lines.splice(start.line, end.line - start.line + 1, ...merged.split("\n"))
		}
	}

	return lines.join("\n")
}

async function applyTextEditsToFile(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await fs.readFile(filePath, "utf-8")
	const result = applyTextEditsToString(content, edits)
	await fs.writeFile(filePath, result, "utf-8")
}

/** Apply a workspace edit. Used for rename results only. Returns list of applied change descriptions. */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = []

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const filePath = uriToFile(uri)
			await applyTextEditsToFile(filePath, textEdits)
			applied.push(`Applied ${textEdits.length} edit(s) to ${path.relative(cwd, filePath)}`)
		}
	}

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && "edits" in change) {
				const filePath = uriToFile(change.textDocument.uri)
				const textEdits = change.edits.filter((e): e is TextEdit => "range" in e && "newText" in e)
				await applyTextEditsToFile(filePath, textEdits)
				applied.push(`Applied ${textEdits.length} edit(s) to ${path.relative(cwd, filePath)}`)
			} else if ("kind" in change) {
				if (change.kind === "create") {
					const filePath = uriToFile(change.uri)
					await fs.writeFile(filePath, "", "utf-8")
					applied.push(`Created ${path.relative(cwd, filePath)}`)
				} else if (change.kind === "rename") {
					const oldPath = uriToFile(change.oldUri)
					const newPath = uriToFile(change.newUri)
					await fs.mkdir(path.dirname(newPath), { recursive: true })
					await fs.rename(oldPath, newPath)
					applied.push(`Renamed ${path.relative(cwd, oldPath)} → ${path.relative(cwd, newPath)}`)
				} else if (change.kind === "delete") {
					const filePath = uriToFile(change.uri)
					await fs.rm(filePath, { recursive: true })
					applied.push(`Deleted ${path.relative(cwd, filePath)}`)
				}
			}
		}
	}

	return applied
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm vitest run src/extensions/lsp/edits.test.ts 2>&1 | tail -10
```

Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp/edits.ts src/extensions/lsp/edits.test.ts
git commit -m "feat(lsp): add text and workspace edit application"
```

---

## Task 4: Server Configurations

**Files:**
- Create: `extensions/lsp/servers.ts`

- [ ] **Step 1: Create servers.ts**

```typescript
// extensions/lsp/servers.ts
import * as fs from "node:fs"
import path from "node:path"
import type { ServerConfig } from "./types.js"

const SERVERS: ServerConfig[] = [
	{
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
	},
	{
		name: "gopls",
		command: "gopls",
		args: [],
		extensions: ["go"],
	},
]

function exists(cmd: string): boolean {
	try {
		const result = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" })
		return result.exitCode === 0
	} catch {
		return false
	}
}

function cwdHasExtension(cwd: string, exts: string[]): boolean {
	try {
		const entries = fs.readdirSync(cwd, { recursive: true, withFileTypes: true })
		return (entries as fs.Dirent[]).some(
			e => e.isFile() && exts.some(ext => e.name.endsWith(`.${ext}`)),
		)
	} catch {
		return false
	}
}

/** Detect which LSP servers apply to the given cwd based on file extensions present. */
export function detectServers(cwd: string): ServerConfig[] {
	const applicable: ServerConfig[] = []

	// Check tsconfig.json or go.mod as fast signals before full directory scan
	for (const server of SERVERS) {
		let apply = false

		if (server.name === "typescript-language-server") {
			apply =
				fs.existsSync(path.join(cwd, "tsconfig.json")) ||
				fs.existsSync(path.join(cwd, "package.json")) ||
				cwdHasExtension(cwd, server.extensions)
		} else if (server.name === "gopls") {
			apply = fs.existsSync(path.join(cwd, "go.mod")) || cwdHasExtension(cwd, server.extensions)
		}

		if (apply && exists(server.command)) {
			applicable.push(server)
		}
	}

	return applicable
}

/** Get the server config for a specific file path, or null if no server applies. */
export function serverForFile(filePath: string, servers: ServerConfig[]): ServerConfig | null {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return servers.find(s => s.extensions.includes(ext)) ?? null
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1 | head -20
```

Expected: no new errors

- [ ] **Step 3: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp/servers.ts
git commit -m "feat(lsp): add TS and Go server detection"
```

---

## Task 5: LSP Client (JSON-RPC, lifecycle, file sync)

**Files:**
- Create: `extensions/lsp/client.ts`

- [ ] **Step 1: Create client.ts**

```typescript
// extensions/lsp/client.ts
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	OpenFileInfo,
	PublishDiagnosticsParams,
	ServerConfig,
} from "./types.js"
import { detectLanguageId, fileToUri } from "./utils.js"

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>()
const clientLocks = new Map<string, Promise<LspClient>>()
const fileOperationLocks = new Map<string, Promise<void>>()

// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: false },
		hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		rename: { dynamicRegistration: false, prepareSupport: true },
		publishDiagnostics: { relatedInformation: true, versionSupport: true },
	},
	window: { workDoneProgress: true },
	workspace: {
		applyEdit: false,
		configuration: false,
	},
}

// =============================================================================
// Message Protocol
// =============================================================================

function findHeaderEnd(buf: Buffer): number {
	for (let i = 0; i < buf.length - 3; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
	}
	return -1
}

function parseMessage(buf: Buffer): { message: LspJsonRpcResponse | LspJsonRpcNotification; remaining: Buffer } | null {
	const headerEnd = findHeaderEnd(buf)
	if (headerEnd === -1) return null

	const headerText = buf.slice(0, headerEnd).toString()
	const lenMatch = headerText.match(/Content-Length: (\d+)/i)
	if (!lenMatch) return null

	const contentLen = parseInt(lenMatch[1], 10)
	const start = headerEnd + 4
	const end = start + contentLen
	if (buf.length < end) return null

	return {
		message: JSON.parse(buf.slice(start, end).toString()),
		remaining: buf.subarray(end),
	}
}

async function writeMessage(
	stdin: ReturnType<typeof Bun.spawn>["stdin"],
	msg: LspJsonRpcRequest | LspJsonRpcNotification,
): Promise<void> {
	const content = JSON.stringify(msg)
	const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`
	await (stdin as WritableStream).getWriter().write(new TextEncoder().encode(header + content))
}

// =============================================================================
// Message Reader
// =============================================================================

async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return
	client.isReading = true

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			client.messageBuffer = Buffer.concat([client.messageBuffer, value])
			let parsed = parseMessage(client.messageBuffer)
			while (parsed) {
				const { message, remaining } = parsed
				client.messageBuffer = remaining

				if ("id" in message && message.id !== undefined) {
					const pending = client.pendingRequests.get(message.id as number)
					if (pending) {
						client.pendingRequests.delete(message.id as number)
						if ("error" in message && message.error) {
							pending.reject(new Error(`LSP error: ${message.error.message}`))
						} else {
							pending.resolve(message.result)
						}
					}
					// Silently ignore server-initiated requests (workspace/configuration, workspace/applyEdit)
					// We advertise applyEdit: false and configuration: false in capabilities.
				} else if ("method" in message) {
					if (message.method === "textDocument/publishDiagnostics" && message.params) {
						const params = message.params as PublishDiagnosticsParams
						client.diagnostics.set(params.uri, {
							diagnostics: params.diagnostics,
							version: params.version ?? null,
						})
						client.diagnosticsVersion++
					} else if (message.method === "$/progress" && message.params) {
						const params = message.params as { token: string | number; value?: { kind?: string } }
						if (params.value?.kind === "begin") {
							client.activeProgressTokens.add(params.token)
						} else if (params.value?.kind === "end") {
							client.activeProgressTokens.delete(params.token)
							if (client.activeProgressTokens.size === 0) client.resolveProjectLoaded()
						}
					}
				}

				parsed = parseMessage(client.messageBuffer)
			}
		}
	} catch (err) {
		for (const pending of client.pendingRequests.values()) {
			pending.reject(new Error(`LSP connection closed: ${err}`))
		}
		client.pendingRequests.clear()
	} finally {
		reader.releaseLock()
		client.isReading = false
	}
}

// =============================================================================
// Client Lifecycle
// =============================================================================

const PROJECT_LOAD_TIMEOUT_MS = 15_000
const DEFAULT_TIMEOUT_MS = 30_000

export async function getOrCreateClient(config: ServerConfig, cwd: string): Promise<LspClient> {
	const key = `${config.command}:${cwd}`

	const existing = clients.get(key)
	if (existing) {
		existing.lastActivity = Date.now()
		return existing
	}

	const existingLock = clientLocks.get(key)
	if (existingLock) return existingLock

	const clientPromise = (async () => {
		const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		})

		let resolveProjectLoaded!: () => void
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve
		})
		const timeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS)
		const originalResolve = resolveProjectLoaded
		resolveProjectLoaded = () => {
			clearTimeout(timeout)
			originalResolve()
		}

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: Buffer.alloc(0),
			isReading: false,
			lastActivity: Date.now(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		}
		clients.set(key, client)

		proc.exited.then(() => {
			clients.delete(key)
			clientLocks.delete(key)
			client.resolveProjectLoaded()
			const err = new Error(`LSP server exited (code ${proc.exitCode})`)
			for (const pending of client.pendingRequests.values()) pending.reject(err)
			client.pendingRequests.clear()
		})

		startMessageReader(client)

		try {
			await sendRequest(client, "initialize", {
				processId: process.pid,
				rootUri: fileToUri(cwd),
				rootPath: cwd,
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: config.initOptions ?? {},
				workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
			})
			await sendNotification(client, "initialized", {})
			return client
		} catch (err) {
			clients.delete(key)
			clientLocks.delete(key)
			proc.kill()
			throw err
		} finally {
			clientLocks.delete(key)
		}
	})()

	clientLocks.set(key, clientPromise)
	return clientPromise
}

export function shutdownAll(): void {
	const all = Array.from(clients.values())
	clients.clear()
	const err = new Error("LSP shutdown")
	for (const client of all) {
		for (const pending of client.pendingRequests.values()) pending.reject(err)
		client.pendingRequests.clear()
		sendRequest(client, "shutdown", null).catch(() => {})
		client.proc.kill()
	}
}

// =============================================================================
// Protocol
// =============================================================================

export async function sendRequest(client: LspClient, method: string, params: unknown): Promise<unknown> {
	const id = ++client.requestId
	const request: LspJsonRpcRequest = { jsonrpc: "2.0", id, method, params }
	client.lastActivity = Date.now()

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			client.pendingRequests.delete(id)
			reject(new Error(`LSP ${method} timed out after ${DEFAULT_TIMEOUT_MS}ms`))
		}, DEFAULT_TIMEOUT_MS)

		client.pendingRequests.set(id, {
			resolve: v => { clearTimeout(timer); resolve(v) },
			reject: e => { clearTimeout(timer); reject(e) },
			method,
		})

		writeMessage(client.proc.stdin, request).catch(err => {
			clearTimeout(timer)
			client.pendingRequests.delete(id)
			reject(err)
		})
	})
}

export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = { jsonrpc: "2.0", method, params }
	client.lastActivity = Date.now()
	await writeMessage(client.proc.stdin, notification)
}

// =============================================================================
// File Sync
// =============================================================================

export async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
	const uri = fileToUri(filePath)
	if (client.openFiles.has(uri)) return

	const lockKey = `${client.name}:${uri}`
	const existingLock = fileOperationLocks.get(lockKey)
	if (existingLock) { await existingLock; return }

	const openPromise = (async () => {
		if (client.openFiles.has(uri)) return
		let content: string
		try {
			content = await Bun.file(filePath).text()
		} catch {
			return // file doesn't exist
		}
		const languageId = detectLanguageId(filePath)
		await sendNotification(client, "textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text: content },
		})
		client.openFiles.set(uri, { version: 1, languageId })
		client.lastActivity = Date.now()
	})()

	fileOperationLocks.set(lockKey, openPromise)
	try { await openPromise } finally { fileOperationLocks.delete(lockKey) }
}

export async function refreshFile(client: LspClient, filePath: string): Promise<void> {
	const uri = fileToUri(filePath)
	const lockKey = `${client.name}:${uri}`

	const existingLock = fileOperationLocks.get(lockKey)
	if (existingLock) await existingLock

	const refreshPromise = (async () => {
		client.diagnostics.delete(uri)
		const info = client.openFiles.get(uri)

		if (!info) {
			await ensureFileOpen(client, filePath)
			return
		}

		let content: string
		try {
			content = await Bun.file(filePath).text()
		} catch {
			return
		}

		const version = ++info.version
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		})
		await sendNotification(client, "textDocument/didSave", {
			textDocument: { uri },
			text: content,
		})
		client.lastActivity = Date.now()
	})()

	fileOperationLocks.set(lockKey, refreshPromise)
	try { await refreshPromise } finally { fileOperationLocks.delete(lockKey) }
}

export function getAllClients(): LspClient[] {
	return Array.from(clients.values())
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1 | head -30
```

Expected: no errors (or only errors from unrelated files)

> **Note on `writeMessage`:** The Bun spawn stdin type varies by version. If `stdin as WritableStream` causes a type error, use `(stdin as any).write(...)` — the actual API is `client.proc.stdin.write(buffer)` in Bun. Check by running `bun --version` and consulting Bun docs. The oh-my-pi reference used `Bun.FileSink` — if that type is available, use `(stdin as Bun.FileSink).write(content); await (stdin as Bun.FileSink).flush()`.

- [ ] **Step 3: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp/client.ts
git commit -m "feat(lsp): add LSP client with lifecycle, file sync, and JSON-RPC"
```

---

## Task 6: Extension Entry Point (tools + file sync hooks)

**Files:**
- Create: `extensions/lsp.ts`

- [ ] **Step 1: Create lsp.ts**

```typescript
// extensions/lsp.ts
/**
 * LSP Extension
 *
 * Gives the agent type-aware code intelligence via LSP.
 * Supports TypeScript (typescript-language-server) and Go (gopls).
 *
 * Usage: kimchi -e extensions/lsp.ts
 */
import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { ensureFileOpen, getAllClients, getOrCreateClient, refreshFile, sendRequest, shutdownAll } from "./lsp/client.js"
import { applyWorkspaceEdit } from "./lsp/edits.js"
import { detectServers, serverForFile } from "./lsp/servers.js"
import type { Hover, Location, LocationLink, WorkspaceEdit } from "./lsp/types.js"
import { fileToUri, formatDiagnostic, uriToFile } from "./lsp/utils.js"

export default function (pi: ExtensionAPI) {
	let cwd = ""
	let activeServers = pi.getActiveTools() // placeholder — populated on session_start

	// ── Session start: detect servers, hook file sync, shutdown on exit ─────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		const servers = detectServers(cwd)
		if (servers.length === 0) return

		// Eagerly start servers so they're warm when first tool is called
		for (const server of servers) {
			getOrCreateClient(server, cwd).catch(() => {})
		}
	})

	pi.on("session_shutdown", async () => {
		shutdownAll()
	})

	// ── File sync: refresh LSP after agent edits files ───────────────────────────

	pi.on("tool_result", async event => {
		if (!("toolName" in event)) return
		if (event.toolName !== "edit" && event.toolName !== "write") return
		if (event.isError) return

		// Extract the file path from the tool input
		const input = event.input as Record<string, unknown>
		const filePath = (input.file_path ?? input.path) as string | undefined
		if (!filePath) return

		const resolved = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
		const servers = detectServers(cwd)
		const server = serverForFile(resolved, servers)
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file_path)
				? params.file_path
				: path.join(ctx.cwd, params.file_path)
			const servers = detectServers(ctx.cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }] }
			}

			const client = await getOrCreateClient(server, ctx.cwd)
			await refreshFile(client, filePath)

			const waitMs = Math.min(params.wait_ms ?? 2000, 10000)
			await Bun.sleep(waitMs)

			const uri = fileToUri(filePath)
			const entry = client.diagnostics.get(uri)
			if (!entry || entry.diagnostics.length === 0) {
				return { content: [{ type: "text", text: "No diagnostics found — file looks clean." }] }
			}

			const lines = entry.diagnostics.map(d => formatDiagnostic(d))
			return { content: [{ type: "text", text: lines.join("\n") }] }
		},
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file_path)
				? params.file_path
				: path.join(ctx.cwd, params.file_path)
			const servers = detectServers(ctx.cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }] }
			}

			const client = await getOrCreateClient(server, ctx.cwd)
			await ensureFileOpen(client, filePath)

			const result = (await sendRequest(client, "textDocument/hover", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			})) as Hover | null

			if (!result) {
				return { content: [{ type: "text", text: "No hover information available at this position." }] }
			}

			const text = extractHoverText(result)
			return { content: [{ type: "text", text }] }
		},
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
				Type.Union([
					Type.Literal("definition"),
					Type.Literal("typeDefinition"),
					Type.Literal("implementation"),
				], { default: "definition" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file_path)
				? params.file_path
				: path.join(ctx.cwd, params.file_path)
			const servers = detectServers(ctx.cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }] }
			}

			const client = await getOrCreateClient(server, ctx.cwd)
			await ensureFileOpen(client, filePath)

			const lspMethod = `textDocument/${params.method ?? "definition"}`
			const result = (await sendRequest(client, lspMethod, {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			})) as Location | Location[] | LocationLink[] | null

			if (!result) {
				return { content: [{ type: "text", text: "No definition found." }] }
			}

			const locations = normalizeLocations(result)
			const lines = locations.map(loc => {
				const file = path.relative(ctx.cwd, uriToFile(loc.uri))
				return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
			})
			return { content: [{ type: "text", text: lines.join("\n") }] }
		},
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file_path)
				? params.file_path
				: path.join(ctx.cwd, params.file_path)
			const servers = detectServers(ctx.cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }] }
			}

			const client = await getOrCreateClient(server, ctx.cwd)
			await ensureFileOpen(client, filePath)

			const result = (await sendRequest(client, "textDocument/references", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
				context: { includeDeclaration: params.include_declaration ?? true },
			})) as Location[] | null

			if (!result || result.length === 0) {
				return { content: [{ type: "text", text: "No references found." }] }
			}

			const lines = result.map(loc => {
				const file = path.relative(ctx.cwd, uriToFile(loc.uri))
				return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
			})
			return { content: [{ type: "text", text: `${result.length} reference(s):\n${lines.join("\n")}` }] }
		},
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file_path)
				? params.file_path
				: path.join(ctx.cwd, params.file_path)
			const servers = detectServers(ctx.cwd)
			const server = serverForFile(filePath, servers)
			if (!server) {
				return { content: [{ type: "text", text: "No LSP server available for this file type." }] }
			}

			const client = await getOrCreateClient(server, ctx.cwd)
			await ensureFileOpen(client, filePath)

			// Check if rename is valid at this position
			const prepareResult = await sendRequest(client, "textDocument/prepareRename", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
			}).catch(() => null)

			if (prepareResult === null) {
				return { content: [{ type: "text", text: "Cannot rename: symbol at this position is not renameable." }] }
			}

			// Request the rename workspace edit
			const edit = (await sendRequest(client, "textDocument/rename", {
				textDocument: { uri: fileToUri(filePath) },
				position: { line: params.line, character: params.character },
				newName: params.new_name,
			})) as WorkspaceEdit | null

			if (!edit) {
				return { content: [{ type: "text", text: "Rename returned no changes." }] }
			}

			const applied = await applyWorkspaceEdit(edit, ctx.cwd)

			// Refresh all modified files in LSP clients
			for (const client of getAllClients()) {
				const affectedUris = [
					...Object.keys(edit.changes ?? {}),
					...(edit.documentChanges ?? [])
						.filter((c): c is { textDocument: { uri: string }; edits: unknown[] } => "textDocument" in c)
						.map(c => c.textDocument.uri),
				]
				for (const uri of affectedUris) {
					const file = uriToFile(uri)
					refreshFile(client, file).catch(() => {})
				}
			}

			return { content: [{ type: "text", text: applied.join("\n") }] }
		},
	})
}

// =============================================================================
// Helpers
// =============================================================================

function extractHoverText(hover: Hover): string {
	const c = hover.contents
	if (typeof c === "string") return c
	if (Array.isArray(c)) {
		return c
			.map(item => (typeof item === "string" ? item : item.value))
			.filter(Boolean)
			.join("\n\n")
	}
	if ("value" in c) return c.value
	return String(c)
}

function normalizeLocations(result: Location | Location[] | LocationLink[]): Location[] {
	if (!Array.isArray(result)) return [result as Location]
	return (result as Array<Location | LocationLink>).map(item => {
		if ("targetUri" in item) {
			return { uri: item.targetUri, range: item.targetSelectionRange }
		}
		return item as Location
	})
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1 | head -30
```

Fix any type errors before proceeding. Common issue: `Bun.spawn` stdin type — if `WritableStream` doesn't match, cast to `any` for the write call.

- [ ] **Step 3: Run biome lint**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm biome check extensions/lsp.ts extensions/lsp/ 2>&1 | head -30
```

Fix any lint errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add extensions/lsp.ts extensions/lsp/client.ts extensions/lsp/servers.ts
git commit -m "feat(lsp): add extension entry point with diagnostics, hover, definition, references, rename tools"
```

---

## Task 7: Run All Tests

**Files:** (no new files)

- [ ] **Step 1: Run all unit tests**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm test 2>&1 | tail -20
```

Expected: existing tests pass, new lsp tests pass, no regressions.

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/ibar/castai/src/kimchi-dev && pnpm tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Smoke test — load extension**

```bash
cd /Users/ibar/castai/src/kimchi-dev && kimchi -e extensions/lsp.ts --print "list your active tools" 2>&1 | grep -E "lsp_|error" | head -20
```

Expected: output includes `lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_rename`.

- [ ] **Step 4: Final commit**

```bash
cd /Users/ibar/castai/src/kimchi-dev
git add -p  # review anything unstaged
git commit -m "feat(lsp): verify tests and typecheck pass"
```

---

## Verification

**End-to-end test (manual):**

1. Start kimchi in the kimchi-dev repo with LSP:
   ```bash
   kimchi -e extensions/lsp.ts
   ```

2. Ask the agent to check a TypeScript file for errors:
   > "Run lsp_diagnostics on src/cli.ts"

3. Ask for hover info:
   > "Run lsp_hover on src/cli.ts at line 10, character 5"

4. Ask for references:
   > "Find all references to ExtensionAPI in src/extensions/mcp-adapter/index.ts at line 1, character 20"

5. Ask for rename:
   > "Rename the function `detectServers` in extensions/lsp/servers.ts at line 27, character 17 to `findServersForCwd`"

Expected: each tool returns meaningful output without crashing kimchi.
