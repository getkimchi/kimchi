// extensions/dap/types.ts

import type { BunProcess } from "../lsp/types.js"

/** DAP base protocol message. DAP frames messages with Content-Length headers
 *  (same as LSP). The `seq` field is the sequence number; `type` is "request" | "response" | "event". */
export interface DapProtocolMessage {
	seq: number
	type: "request" | "response" | "event"
}

export interface DapRequest extends DapProtocolMessage {
	type: "request"
	command: string
	arguments?: unknown
}

export interface DapResponse extends DapProtocolMessage {
	type: "response"
	request_seq: number
	success: boolean
	/** Required by the DAP spec: echoes the `command` from the request this
	 *  response answers. Strict adapters reject responses without it. */
	command: string
	message?: string
	body?: unknown
}

export interface DapEvent extends DapProtocolMessage {
	type: "event"
	event: string
	body?: unknown
}

/** Capabilities advertised by the adapter in the `initialize` response.
 *  Only the fields the client/tools actually inspect. Extend as needed. */
export interface DapCapabilities {
	supportsConfigurationDoneRequest?: boolean
	supportsFunctionBreakpoints?: boolean
	supportsConditionalBreakpoints?: boolean
	supportsHitConditionalBreakpoints?: boolean
	supportsEvaluateForHovers?: boolean
	supportsStepBack?: boolean
	supportsSetVariable?: boolean
	supportsRestartFrame?: boolean
	supportsGotoTargetsRequest?: boolean
	supportsStepInTargetsRequest?: boolean
	supportsCompletionsRequest?: boolean
	supportsModulesRequest?: boolean
	supportsRestartRequest?: boolean
	supportsExceptionOptions?: boolean
	supportsValueFormattingOptions?: boolean
	supportsTerminateDebuggee?: boolean
	supportsDelayedStackTraceLoading?: boolean
	supportsLoadedSourcesRequest?: boolean
	supportsLogPoints?: boolean
	supportsTerminateThreadsRequest?: boolean
	supportsSetExpression?: boolean
	supportsTerminateRequest?: boolean
	supportsDataBreakpoints?: boolean
	supportsReadMemoryRequest?: boolean
	supportsWriteMemoryRequest?: boolean
	supportsDisassembleRequest?: boolean
	supportsCancelRequest?: boolean
	supportsBreakpointLocationsRequest?: boolean
	supportsClipboardContext?: boolean
	supportsSteppingGranularity?: boolean
	supportsInstructionBreakpoints?: boolean
	supportsExceptionFilterOptions?: boolean
	supportsSingleThreadExecutionRequests?: boolean
}

export interface Source {
	name?: string
	path?: string
	sourceReference?: number
	presentationHint?: "normal" | "emphasize" | "deemphasize"
	origin?: string
	adapterData?: unknown
	checksums?: Array<{ algorithm: string; checksum: string }>
}

export interface StackFrame {
	id: number
	name: string
	source?: Source
	line: number
	column: number
	endLine?: number
	endColumn?: number
	canRestart?: boolean
	presentationHint?: "normal" | "label" | "subtle"
	moduleId?: number | string
}

export interface Scope {
	name: string
	variablesReference: number
	namedVariables?: number
	indexedVariables?: number
	expensive: boolean
	source?: Source
	presentationHint?: "arguments" | "locals" | "registers"
}

export interface Variable {
	name: string
	value: string
	type?: string
	presentationHint?: { kind?: string; attributes?: string[]; visibility?: string; lazy?: boolean }
	evaluateName?: string
	variablesReference: number
	namedVariables?: number
	indexedVariables?: number
	memoryReference?: string
}

export interface Breakpoint {
	id?: number
	verified: boolean
	message?: string
	source?: Source
	line?: number
	column?: number
	endLine?: number
	endColumn?: number
}

/** Body of the DAP `evaluate` response. The `result` is the stringified value;
 *  `variablesReference` is >0 when the value has children (struct/object) that
 *  can be expanded via a subsequent `variables` request. */
export interface DapEvaluateResult {
	result: string
	type?: string
	presentationHint?: { kind?: string; attributes?: string[]; visibility?: string; lazy?: boolean }
	variablesReference: number
	namedVariables?: number
	indexedVariables?: number
	memoryReference?: string
}

export interface Thread {
	id: number
	name: string
}

export interface ExceptionInfo {
	exceptionId?: string
	description?: string
	breakMode: string
	details?: {
		message?: string
		typeName?: string
		stackTrace?: string
		innerException?: Array<unknown>
		typeId?: string
	}
}

export interface StoppedEvent {
	reason:
		| "step"
		| "breakpoint"
		| "exception"
		| "pause"
		| "entry"
		| "goto"
		| "function breakpoint"
		| "data breakpoint"
		| "instruction breakpoint"
		| string
	description?: string
	threadId?: number
	preserveFocusHint?: boolean
	text?: string
	allThreadsStopped?: boolean
	hitBreakpointIds?: number[]
}

export interface ContinuedEvent {
	threadId: number
	allThreadsContinued?: boolean
}

export interface TerminatedEvent {
	restart?: unknown
}

export interface OutputEvent {
	category?: "console" | "important" | "stdout" | "stderr" | "telemetry" | string
	output: string
	group?: "start" | "startCollapsed" | "end"
	variablesReference?: number
	source?: Source
	line?: number
	column?: number
	data?: unknown
}

export interface DapPendingRequest {
	resolve: (value: unknown) => void
	reject: (reason: Error) => void
	command: string
}

/** A waiter resolved when the next `stopped` event arrives (used by Layer 2 tools
 *  that block until a breakpoint/exception is hit). */
export interface DapStoppedWaiter {
	resolve: (event: StoppedEvent) => void
	reject: (reason: Error) => void
}

/** A waiter resolved when the next `terminated` event arrives. */
export interface DapTerminatedWaiter {
	resolve: (event: TerminatedEvent) => void
	reject: (reason: Error) => void
}

/** A captured stdout/stderr line for output collection. */
export interface DapOutputLine {
	category: string
	text: string
}

/** Per-session DAP client state, mirroring LSP's `LspClient`. Keyed by cwd in a
 *  DapClientRegistry's `clients` Map (the same scoping strategy LSP uses).
 *
 *  js-debug nested sessions: when the parent adapter sends a `startDebugging`
 *  reverse-request, the client opens a CHILD connection to the same TCP server
 *  and routes all subsequent debug requests to it. The child's events
 *  (stopped/terminated/output) update this (parent) client's state so the
 *  session layer — which only ever reads from the parent — sees them. */
export interface DapClient {
	name: string
	cwd: string
	proc: BunProcess
	seq: number
	capabilities: DapCapabilities | null
	/** Pending DAP requests keyed by `seq`. */
	pendingRequests: Map<number, DapPendingRequest>
	messageBuffer: Buffer
	isReading: boolean
	/** Current thread id (from the most recent `stopped` or `thread` event). */
	threadId: number | null
	/** The most recent stopped event for this session. */
	stoppedEvent: StoppedEvent | null
	/** Waiters for the next `stopped` event. */
	stoppedWaiters: DapStoppedWaiter[]
	/** Waiters for the next `terminated` event. */
	terminatedWaiters: DapTerminatedWaiter[]
	/** Captured output lines (stdout/stderr/console), capped by the client. */
	outputLines: DapOutputLine[]
	terminated: boolean
	/** Resolves when the `initialized` event arrives (after launch). */
	initializedResolve?: () => void
	initializedPromise: Promise<void>
	/** For TCP transports (js-debug), the host:port of the parent adapter's
	 *  listening socket. Stored so a child connection can be opened on
	 *  `startDebugging`. Undefined for stdio adapters (no nested session). */
	parentServer?: { host: string; port: number }
	/** The child client created on `startDebugging`. When set, `sendRequest`
	 *  transparently routes to it. The child reader still updates THIS (parent)
	 *  client's stoppedEvent/outputLines/etc. */
	childClient?: DapClient
	/** Resolves once the child client has completed its initialize + launch +
	 *  configurationDone handshake (or failed — then `childClient` remains unset
	 *  and `childSetupError` is set). `sendRequest` awaits this before routing
	 *  to the child so the child is fully ready before any debug request is sent. */
	childClientReady?: Promise<void>
	/** Set when child-session setup (startDebugging handshake) failed. Unlike
	 *  "no child requested", a failed child must NOT fall back to the parent
	 *  connection — the parent manager has no debuggee, so routing breakpoints
	 *  there would silently no-op. sendRequest rejects with this error. */
	childSetupError?: Error
}

/** How the DAP client talks to the adapter subprocess.
 *  - stdio: frame pump over the subprocess's stdin/stdout (debugpy, lldb-dap)
 *  - tcp:   adapter listens on a port; the client connects via TCP socket and
 *           runs the same framing pump over it (dlv dap, js-debug's dapDebugServer.js).
 *  See the js-debug protocol conclusion at the top of adapters.ts. */
export type DapTransport = { kind: "stdio" } | { kind: "tcp"; host?: string }

export interface DapAdapterConfig {
	name: string
	command: string
	args?: string[]
	/** Binary name to `which`-check for detection. Defaults to `command`. Set when
	 *  `command` is a generic interpreter — e.g. js-debug runs as `node <script>`
	 *  but we detect the `js-debug-adapter` shim instead of `node` (always present). */
	detectBinary?: string
	/** Detection command for module-based adapters — e.g. ["python3", "-c", "import debugpy"]
	 *  to check if debugpy is installed as a Python module rather than a binary. */
	detectModule?: string[]
	/** Function that returns true if this adapter's runtime is available.
	 *  Used for adapters that need custom detection logic beyond a simple
	 *  `which` check or module probe — e.g. js-debug checks for the
	 *  dapDebugServer.js script at known install paths. */
	detect?: () => boolean
	/** Transport the DAP client uses to talk to this adapter. Defaults to stdio. */
	transport?: DapTransport
	languages: string[]
	extensions: string[]
	/** DAP `type` field for the `launch` request (e.g. "node", "python", "go", "lldb"). */
	launchType: string
	/** Install command shown in the degraded-state warning when the binary is not on PATH. */
	installHint?: string
	/** Adapter-specific default launch config (merged into the `launch` request arguments). */
	launchConfig?: Record<string, unknown>
}
