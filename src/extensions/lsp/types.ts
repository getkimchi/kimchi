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

export interface BunProcess {
	stdin: { write(data: Uint8Array | string): void; flush?(): Promise<void>; end(): void }
	stdout: ReadableStream<Uint8Array>
	stderr: ReadableStream<Uint8Array>
	kill(): void
	exited: Promise<void>
	exitCode: number | null
}

export interface DiagnosticWaiter {
	/** diagnosticsVersion snapshot taken at wait time. Resolved when the next
	 *  publishDiagnostics for this URI arrives (version > snapshot). */
	snapshot: number
	resolve: () => void
}

export interface LspClient {
	name: string
	cwd: string
	proc: BunProcess
	requestId: number
	diagnostics: Map<string, { diagnostics: Diagnostic[]; version: number | null }>
	diagnosticsVersion: number
	/** Per-URI baseline captured at refreshFile time. Cleared by refreshFile
	 *  before the next publishDiagnostics arrives. waitForDiagnostics uses the
	 *  baseline as the version threshold so a publishDiagnostics that races
	 *  between refreshFile and waitForDiagnostics still resolves the waiter. */
	pendingDiagBaseline: Map<string, number>
	/** Per-URI waiters for the next publishDiagnostics notification. */
	diagnosticWaiters: Map<string, Set<DiagnosticWaiter>>
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
