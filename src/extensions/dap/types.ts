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
 *  module-level `clients` Map (the same scoping strategy LSP uses). */
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
	lastActivity: number
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
}

/** How the DAP client talks to the adapter subprocess.
 *  - stdio: frame pump over the subprocess's stdin/stdout (dlv, debugpy, lldb-dap)
 *  - tcp:   adapter listens on a port given as a CLI arg; client connects via TCP
 *           socket and runs the same framing pump over it (js-debug's dapDebugServer.js).
 *  See the js-debug protocol conclusion at the top of adapters.ts. */
export type DapTransport = { kind: "stdio" } | { kind: "tcp"; portArgIndex: number; host?: string }

export interface DapAdapterConfig {
	name: string
	command: string
	args?: string[]
	/** Binary name to `which`-check for detection. Defaults to `command`. Set when
	 *  `command` is a generic interpreter — e.g. js-debug runs as `node <script>`
	 *  but we detect the `js-debug-adapter` shim instead of `node` (always present). */
	detectBinary?: string
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
