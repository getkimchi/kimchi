// extensions/dap/client.ts
import { spawn } from "node:child_process"
import net from "node:net"
import type { BunProcess } from "../lsp/types.js"
import { resolveJsDebugScript } from "./adapters.js"
import type {
	DapAdapterConfig,
	DapCapabilities,
	DapClient,
	DapEvent,
	DapPendingRequest,
	DapRequest,
	DapResponse,
	OutputEvent,
	StoppedEvent,
	TerminatedEvent,
} from "./types.js"

// =============================================================================
// TCP transport (js-debug): spawn server, connect socket, wrap as BunProcess
// =============================================================================

/** Wraps a net.Socket to satisfy the BunProcess interface so the same
 *  reader/writer code works for TCP-based adapters (js-debug). The socket's
 *  readable side maps to `stdout`, the write side maps to `stdin`. `kill()`
 *  destroys the socket; the spawned subprocess is tracked separately so the
 *  caller can force-kill it. */
interface TcpProcessHandle extends BunProcess {
	/** The underlying node:child_process spawn (the dapDebugServer.js process).
	 *  Tracked so the DapClientRegistry can kill it when the client is shut down. */
	childProc: { kill: (signal?: string) => void; exitCode: number | null; exited: Promise<void> }
}

function wrapSocketAsProcess(
	socket: net.Socket,
	childProc: { kill: (signal?: string) => void; exitCode: number | null; exited: Promise<void> },
): TcpProcessHandle {
	const reader = new ReadableStream<Uint8Array>({
		start(controller) {
			socket.on("data", (data: Buffer) => controller.enqueue(new Uint8Array(data)))
			socket.on("end", () => controller.close())
			socket.on("error", (err: Error) => controller.error(err))
		},
	})
	return {
		stdin: {
			write(data: Uint8Array | string) {
				socket.write(data)
			},
			flush() {
				return Promise.resolve()
			},
			end() {
				socket.end()
			},
		},
		stdout: reader,
		stderr: new ReadableStream<Uint8Array>({
			start(c) {
				c.close()
			},
		}),
		kill() {
			socket.destroy()
			childProc.kill("SIGKILL")
		},
		exited: childProc.exited,
		exitCode: null,
		childProc,
	}
}

/** Spawn a stdio-based DAP adapter (dlv, debugpy, lldb-dap) — the adapter
 *  speaks DAP over stdin/stdout. Uses Bun.spawn when available (dev), falls
 *  back to node:child_process spawn (production build / vitest forks pool). */
function spawnStdioAdapter(config: DapAdapterConfig, cwd: string): BunProcess {
	// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
	const Bun = (globalThis as any).Bun
	if (Bun?.spawn) {
		return Bun.spawn([config.command, ...(config.args ?? [])], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as BunProcess
	}
	return spawnChildProcessAsBunProcess([config.command, ...(config.args ?? [])], cwd)
}

/** A BunProcess wrapper that additionally surfaces spawn failures (ENOENT,
 *  EACCES). The registry reads `spawnError` when the process dies to produce a
 *  meaningful error instead of a bare `exited (code null)`.
 *  Not part of the BunProcess interface — accessed via a typed property read. */
interface SpawnTrackedProcess extends BunProcess {
	/** Set when the child process itself failed to spawn or died abnormally. */
	readonly spawnError: Error | null
}

/** Spawn a child process via node:child_process and wrap its stdio to satisfy
 *  the BunProcess interface. Used when Bun is not available (vitest forks pool,
 *  production Node build). Mirrors the BunProcess shape Bun.spawn returns. */
function spawnChildProcessAsBunProcess(argv: string[], cwd: string): BunProcess {
	if (argv.length === 0) throw new Error("DAP adapter spawn requires a command")
	const cmd = argv[0]
	if (!cmd) throw new Error("DAP adapter command is empty")
	const cp = spawn(cmd, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] })
	// A spawn failure (adapter binary missing) emits 'error' on the ChildProcess;
	// WITHOUT a listener Node rethrows it as an uncaught exception, crashing the
	// harness in production builds. 'exit' may never fire after a spawn error,
	// so `exited` resolves on 'close' (always emitted).
	let spawnError: Error | null = null
	cp.on("error", (err: Error) => {
		spawnError = err
	})
	// Writes to stdin after a spawn failure emit 'error' on the stream itself.
	// Swallow it — the spawn error above is the meaningful signal; the request
	// pipeline already rejects via the exited watcher / write catch.
	cp.stdin.on("error", () => {})
	let exitCode: number | null = null
	cp.on("exit", (code: number | null) => {
		exitCode = code
	})
	const stdinWriter = {
		write(data: Uint8Array | string) {
			cp.stdin.write(data)
		},
		flush() {
			return Promise.resolve()
		},
		end() {
			cp.stdin.end()
		},
	}
	// Convert Node's readable streams to web ReadableStream.
	const toWebStream = (nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> => {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				nodeStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
				nodeStream.on("end", () => controller.close())
				nodeStream.on("error", (err: Error) => controller.error(err))
			},
		})
	}
	const wrapped: SpawnTrackedProcess = {
		stdin: stdinWriter,
		stdout: toWebStream(cp.stdout),
		stderr: toWebStream(cp.stderr),
		kill() {
			cp.kill("SIGKILL")
		},
		exited: new Promise<void>((resolve) => cp.on("close", () => resolve())),
		get exitCode() {
			return exitCode
		},
		get spawnError() {
			return spawnError
		},
	}
	return wrapped
}

/** Spawn a TCP-based DAP adapter (js-debug's dapDebugServer.js), wait for the
 *  `Debug server listening at <host>:<port>` line, connect a TCP socket, and
 *  return a BunProcess wrapping the socket plus the resolved host:port (stored
 *  on the DapClient so a child connection can be opened on `startDebugging`).
 *  Resolves the script path from config.args (if set) or resolveJsDebugScript(). */
async function spawnTcpAdapterForConfig(
	config: DapAdapterConfig,
	cwd: string,
): Promise<{ proc: BunProcess; addr: { host: string; port: number } }> {
	// Resolve the dapDebugServer.js script path + port arg. config.args may
	// already contain ["<script>", "0", "127.0.0.1"] if a caller set them;
	// otherwise resolve the script and append the ephemeral port + host.
	let argv: string[]
	if (config.args && config.args.length > 0) {
		argv = [config.command, ...config.args]
	} else {
		const script = resolveJsDebugScript()
		if (!script) {
			throw new Error("js-debug dapDebugServer.js not found. Set JS_DEBUG_PATH or install js-debug-adapter.")
		}
		const host = config.transport?.kind === "tcp" ? (config.transport.host ?? "127.0.0.1") : "127.0.0.1"
		argv = [config.command, script, "0", host]
	}
	// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
	const Bun = (globalThis as any).Bun
	interface ChildProcHandle {
		kill: () => void
		exitCode: number | null
		exited: Promise<void>
	}
	let childProc: ChildProcHandle
	let stdoutBuf = ""
	const callbacks = {
		resolve: null as null | ((addr: { host: string; port: number }) => void),
		reject: null as null | ((err: Error) => void),
	}
	const listeningPromise = new Promise<{ host: string; port: number }>((resolve, reject) => {
		callbacks.resolve = resolve
		callbacks.reject = reject
	})

	const parseListeningLine = (line: string): { host: string; port: number } | null => {
		// js-debug prints: "Debug server listening at 127.0.0.1:65284"
		// dlv prints:      "DAP server listening at: 127.0.0.1:49223"
		// Match "listening at" optionally followed by ":" then host:port.
		const m = line.match(/listening\s+at:?\s+\[?([^:\]]+)\]?:(\d+)/i)
		if (!m) return null
		return { host: m[1], port: Number.parseInt(m[2], 10) }
	}

	const timer = setTimeout(() => {
		if (callbacks.reject) callbacks.reject(new Error(`Timed out waiting for ${config.name} TCP server to start`))
	}, 10_000)

	if (Bun?.spawn) {
		const proc = Bun.spawn(argv, {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as BunProcess
		childProc = {
			kill: () => proc.kill(),
			exitCode: null,
			exited: proc.exited,
		}
		const reader = proc.stdout.getReader()
		;(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					stdoutBuf += Buffer.from(value).toString("utf-8")
					const lines = stdoutBuf.split("\n")
					stdoutBuf = lines.pop() ?? ""
					for (const line of lines) {
						const addr = parseListeningLine(line)
						if (addr && callbacks.resolve) {
							callbacks.resolve(addr)
							callbacks.resolve = null
						}
					}
				}
			} catch {
				// ignore reader errors
			}
		})()
	} else {
		const cmd = argv[0]
		if (!cmd) throw new Error("DAP adapter command is empty")
		const cp = spawn(cmd, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] })
		// Without an 'error' listener a spawn failure (ENOENT) becomes an
		// uncaught exception. Reject the listening promise immediately instead
		// of waiting for the 10s timeout.
		cp.on("error", (err: Error) => {
			if (callbacks.reject) {
				callbacks.reject(new Error(`DAP adapter '${config.command}' failed to start: ${err.message}`))
				callbacks.reject = null
			}
		})
		cp.stdin.on("error", () => {})
		childProc = {
			kill: () => cp.kill("SIGKILL"),
			exitCode: null,
			exited: new Promise<void>((resolve) => cp.on("close", () => resolve())),
		}
		cp.stdout.on("data", (data: Buffer) => {
			stdoutBuf += data.toString("utf-8")
			const lines = stdoutBuf.split("\n")
			stdoutBuf = lines.pop() ?? ""
			for (const line of lines) {
				const addr = parseListeningLine(line)
				if (addr && callbacks.resolve) {
					callbacks.resolve(addr)
					callbacks.resolve = null
				}
			}
		})
	}

	let addr: { host: string; port: number }
	try {
		addr = await listeningPromise
	} catch (err) {
		// Listening failed (timeout or spawn error) — the process is not tracked
		// by any client yet, so kill it here rather than leaking it.
		childProc.kill()
		throw err
	} finally {
		clearTimeout(timer)
	}

	const socket = net.createConnection({ host: addr.host, port: addr.port })
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve)
		socket.once("error", reject)
	})
	return { proc: wrapSocketAsProcess(socket, childProc), addr }
}

// =============================================================================
// Client State
// =============================================================================

const DEFAULT_TIMEOUT_MS = 30_000

// =============================================================================
// Message Protocol
// =============================================================================

function findHeaderEnd(buf: Buffer): number {
	for (let i = 0; i < buf.length - 3; i++) {
		if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
	}
	return -1
}

function parseMessage(buf: Buffer): { message: DapRequest | DapResponse | DapEvent; remaining: Buffer } | null {
	const headerEnd = findHeaderEnd(buf)
	if (headerEnd === -1) return null

	const headerText = buf.subarray(0, headerEnd).toString()
	const lenMatch = headerText.match(/Content-Length: (\d+)/i)
	if (!lenMatch) return null

	const contentLen = Number.parseInt(lenMatch[1], 10)
	const start = headerEnd + 4
	const end = start + contentLen
	if (buf.length < end) return null

	return {
		message: JSON.parse(buf.subarray(start, end).toString()),
		remaining: buf.subarray(end),
	}
}

async function writeMessage(proc: BunProcess, msg: DapRequest | DapResponse): Promise<void> {
	const content = JSON.stringify(msg)
	const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`
	proc.stdin.write(header + content)
	if (proc.stdin.flush) await proc.stdin.flush()
}

/** Reject every stop/terminate waiter registered on `state` so waiters fail
 *  fast instead of hanging until their own timeout when the connection dies.
 *  `state` is the client owning event state (the PARENT for nested child
 *  connections, whose reader routes events to the parent's waiters). */
function rejectWaiters(state: DapClient, err: Error): void {
	const stopped = state.stoppedWaiters.splice(0)
	for (const w of stopped) w.reject(err)
	const terminated = state.terminatedWaiters.splice(0)
	for (const w of terminated) w.reject(err)
}

/** Cap on unparsed buffered bytes before the connection is treated as broken.
 *  A runaway or garbage adapter (emitting bytes without Content-Length
 *  framing) would otherwise buffer up unbounded memory forever. */
const MAX_MESSAGE_BUFFER_BYTES = 10 * 1024 * 1024

// =============================================================================
// Message Reader
// =============================================================================

/** Reads DAP messages from `client.proc.stdout`, correlating responses via
 *  `client.pendingRequests` and dispatching events/requests. When `stateTarget`
 *  is provided (the js-debug nested-session case), event-driven state —
 *  stoppedEvent, threadId, outputLines, terminated, and the waiter queues — is
 *  written to `stateTarget` (the parent client) while requests/responses are
 *  still correlated on `client` (the child connection). The `initialized` event
 *  always resolves `client.initializedResolve` since it is per-connection. */
async function startMessageReader(client: DapClient, stateTarget?: DapClient): Promise<void> {
	const state = stateTarget ?? client
	if (client.isReading) return
	client.isReading = true

	const reader = client.proc.stdout.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			client.messageBuffer = Buffer.concat([client.messageBuffer, value])
			if (client.messageBuffer.length > MAX_MESSAGE_BUFFER_BYTES) {
				throw new Error(
					"DAP message buffer exceeded 10MB without a parseable frame — adapter is emitting protocol garbage; treating the connection as broken",
				)
			}
			let parsed = parseMessage(client.messageBuffer)
			while (parsed) {
				const { message, remaining } = parsed
				client.messageBuffer = remaining

				if (message.type === "response") {
					const pending = client.pendingRequests.get(message.request_seq)
					if (pending) {
						client.pendingRequests.delete(message.request_seq)
						if (message.success) {
							pending.resolve(message.body)
						} else {
							pending.reject(new Error(`DAP ${pending.command} failed: ${message.message ?? "unknown error"}`))
						}
					}
				} else if (message.type === "event") {
					switch (message.event) {
						case "stopped": {
							const body = message.body as StoppedEvent
							state.stoppedEvent = body
							if (body.threadId != null) state.threadId = body.threadId
							while (state.stoppedWaiters.length > 0) {
								const waiter = state.stoppedWaiters.shift()
								if (!waiter) continue
								try {
									waiter.resolve(body)
								} catch (err) {
									waiter.reject(err as Error)
								}
							}
							break
						}
						case "terminated": {
							const body = message.body as TerminatedEvent
							state.terminated = true
							while (state.terminatedWaiters.length > 0) {
								const waiter = state.terminatedWaiters.shift()
								if (!waiter) continue
								try {
									waiter.resolve(body)
								} catch (err) {
									waiter.reject(err as Error)
								}
							}
							break
						}
						case "thread": {
							const body = message.body as { threadId?: number }
							if (body.threadId != null) state.threadId = body.threadId
							break
						}
						case "initialized": {
							// Per-connection: always resolve the connection's own promise
							// (not the stateTarget's), so a child's initialize handshake
							// completes on its own connection.
							if (client.initializedResolve) client.initializedResolve()
							break
						}
						case "output": {
							const body = message.body as OutputEvent
							state.outputLines.push({
								category: body.category ?? "console",
								text: body.output,
							})
							if (state.outputLines.length > 1000) state.outputLines.shift()
							break
						}
						default:
						// Unknown events are intentionally ignored.
					}
				} else if (message.type === "request") {
					if (message.command === "startDebugging") {
						if (client.parentServer) {
							handleStartDebuggingRequest(client, message).catch(logSwallow("startDebugging"))
						} else {
							// stdio adapter — no parent TCP server to connect a child to.
							// Reply success:true so the adapter doesn't hang waiting.
							sendResponse(client, message.seq, message.command, true, undefined, undefined).catch(
								logSwallow("sendResponse"),
							)
						}
					} else {
						// Server-initiated requests (e.g. runInTerminal) are unsupported.
						// Reply success:false so the adapter falls back to internalConsole.
						sendResponse(
							client,
							message.seq,
							message.command,
							false,
							undefined,
							`Unsupported server request: ${message.command}`,
						).catch(logSwallow("sendResponse"))
					}
				}

				parsed = parseMessage(client.messageBuffer)
			}
		}
	} catch (err) {
		const closed = new Error(`DAP connection closed: ${err}`)
		for (const pending of client.pendingRequests.values()) {
			pending.reject(closed)
		}
		client.pendingRequests.clear()
		rejectWaiters(state, closed)
	} finally {
		// Clean stream end: any request or stop/terminate waiter still outstanding
		// will never resolve — fail fast rather than hanging until timeout. When
		// the process failed to spawn, prefer the spawn error (it is the actual
		// reason; spawn 'error' fires before stdio closes).
		if (client.pendingRequests.size > 0 || state.stoppedWaiters.length > 0 || state.terminatedWaiters.length > 0) {
			const spawnErr = (client.proc as Partial<SpawnTrackedProcess>).spawnError
			const closed = spawnErr
				? new Error(`DAP adapter '${client.name}' failed to start: ${spawnErr.message}`)
				: new Error("DAP connection closed")
			for (const pending of client.pendingRequests.values()) pending.reject(closed)
			client.pendingRequests.clear()
			rejectWaiters(state, closed)
		}
		reader.releaseLock()
		client.isReading = false
	}
}

// =============================================================================
// js-debug nested session — startDebugging reverse-request
// =============================================================================

/** Arguments of the DAP `startDebugging` reverse-request. The `configuration`
 *  is the launch config the client must send verbatim on the child connection. */
interface StartDebuggingArguments {
	request?: "launch" | "attach"
	configuration?: Record<string, unknown>
}

/** Handle the js-debug `startDebugging` reverse-request: open a child TCP
 *  connection to the same adapter, run the initialize + launch +
 *  configurationDone handshake on it, install it as `client.childClient`, and
 *  only THEN reply `success:true` — acknowledging before the child is ready
 *  would let the adapter send debug traffic against a child that may never
 *  come up. On setup failure replies `success:false` and records
 *  `client.childSetupError` so sendRequest rejects instead of silently
 *  routing to the parent manager connection (which has no debuggee).
 *  `childClientReady` is set synchronously so concurrent sendRequest callers
 *  await it before routing. The child reader routes event-driven state to
 *  the PARENT client. */
async function handleStartDebuggingRequest(client: DapClient, message: DapRequest): Promise<void> {
	const args = (message.arguments ?? {}) as StartDebuggingArguments
	const configuration = args.configuration ?? {}
	// Set the ready promise up-front so concurrent sendRequest callers await it.
	let resolveReady!: () => void
	client.childClientReady = new Promise<void>((resolve) => {
		resolveReady = resolve
	})
	try {
		const child = await startChildSession(client, configuration)
		client.childClient = child
		await sendResponse(client, message.seq, message.command, true, undefined, undefined)
	} catch (err) {
		client.childSetupError = err instanceof Error ? err : new Error(String(err))
		await sendResponse(
			client,
			message.seq,
			message.command,
			false,
			undefined,
			`startDebugging child setup failed: ${client.childSetupError.message}`,
		)
	} finally {
		client.childClientReady = undefined
		resolveReady()
	}
}

/** A no-op subprocess handle for a child TCP connection — there is no separate
 *  OS process to kill (the child connects to the already-running parent server).
 *  `exited` never resolves so the registry's exit watcher stays inert. */
function noopChildProc(): {
	kill: (signal?: string) => void
	exitCode: number | null
	exited: Promise<void>
} {
	return {
		kill: () => {},
		exitCode: null,
		exited: new Promise<void>(() => {}),
	}
}

/** Open a child TCP connection to the parent adapter's socket and run the
 *  initialize + launch + configurationDone handshake on it. The child's message
 *  reader is started with `stateTarget = parent` so stopped/terminated/output
 *  events update the parent client's state (the session layer reads from the
 *  parent). Returns the child client; the caller assigns it to
 *  `parent.childClient`. */
async function startChildSession(parent: DapClient, configuration: Record<string, unknown>): Promise<DapClient> {
	if (!parent.parentServer) {
		throw new Error("startDebugging received but parent has no TCP server address")
	}
	const { host, port } = parent.parentServer
	const socket = net.createConnection({ host, port })
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve)
		socket.once("error", reject)
	})
	const proc = wrapSocketAsProcess(socket, noopChildProc())

	const child: DapClient = {
		name: `${parent.name}:child`,
		cwd: parent.cwd,
		proc,
		seq: 0,
		capabilities: null,
		pendingRequests: new Map(),
		messageBuffer: Buffer.alloc(0),
		isReading: false,
		threadId: null,
		stoppedEvent: null,
		stoppedWaiters: [],
		terminatedWaiters: [],
		outputLines: [],
		terminated: false,
		initializedPromise: undefined as unknown as Promise<void>,
		// The child can itself receive a startDebugging (deeper nesting) — store
		// the same server address so a grandchild can connect if ever needed.
		parentServer: parent.parentServer,
	}
	child.initializedPromise = new Promise((resolve) => {
		child.initializedResolve = resolve
	})

	// Start the child reader, routing event-driven state to the PARENT client.
	startMessageReader(child, parent)
	// Drain the child's stderr (empty for a TCP socket, but keeps the contract).
	;(async () => {
		const reader = child.proc.stderr.getReader()
		try {
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}
		} finally {
			reader.releaseLock()
		}
	})()

	const initBody = await sendRequest(child, "initialize", {
		clientID: "kimchi",
		clientName: "Kimchi DAP Client",
		adapterID: "pwa-node",
		locale: "en-US",
		linesStartAt1: true,
		columnsStartAt1: true,
		supportsVariableType: false,
		supportsVariablePaging: false,
		supportsRunInTerminalRequest: false,
		supportsStartDebuggingRequest: true,
		supportsProgressReporting: false,
		supportsInvalidatedEvent: false,
		supportsMemoryReferences: false,
		pathFormat: "path",
	})
	child.capabilities = (initBody as DapCapabilities) ?? null

	// Fire launch without awaiting — js-debug defers the launch response until
	// after configurationDone, so awaiting would deadlock. Await it last.
	const launchP = sendRequest(child, "launch", configuration, 30_000)
	// Wait for the child's `initialized` event (per-connection) before sending
	// configurationDone, matching the DAP ordering: initialized → configurationDone.
	await Promise.race([child.initializedPromise, new Promise((r) => setTimeout(r, 5000))])
	try {
		await sendRequest(child, "configurationDone", {}, 10_000)
	} catch {
		// Some adapters reject/timeout configurationDone — proceed regardless.
	}
	try {
		await launchP
	} catch {
		// The launch response may be deferred or error after configurationDone;
		// the child is still usable for subsequent debug requests.
	}
	return child
}

// =============================================================================
// Client Lifecycle — DapClientRegistry
// =============================================================================

/** Per-extension-instance registry of live DapClient instances. Holds the
 *  `clients` Map and the in-flight `clientLocks` Map (which dedupes concurrent
 *  getOrCreate calls for the same key) as instance fields so two extension
 *  activations in the same process do not share debug client state. Mirrors
 *  the LSP client scoping strategy, but per-instance rather than module-level.
 *
 *  Keyed by `${adapter.command}:${cwd}` — the same adapter in different working
 *  directories gets separate subprocesses. */
export class DapClientRegistry {
	private readonly clients = new Map<string, DapClient>()
	private readonly clientLocks = new Map<string, Promise<DapClient>>()

	/** Return the existing client for (command, cwd, scope) if present, else
	 *  spawn the adapter subprocess, run the initialize
	 *  handshake, and register the client. Concurrent calls for the same key
	 *  share a single in-flight promise so the adapter is spawned only once.
	 *
	 *  `scope` namespaces the cache key — dap.ts passes the DAP session id so
	 *  every debug session gets its own adapter process. A DAP connection is
	 *  one-debuggee, and DapSession.terminate() SIGKILLs the client proc; with
	 *  per-session keys one session's terminate can never cross-kill another's.
	 *  Omitting scope uses the shared (command, cwd) key (tests, static callers). */
	async getOrCreate(config: DapAdapterConfig, cwd: string, scope?: string): Promise<DapClient> {
		const key = scope ? `${config.command}:${cwd}:${scope}` : `${config.command}:${cwd}`

		const existing = this.clients.get(key)
		if (existing) {
			return existing
		}

		const existingLock = this.clientLocks.get(key)
		if (existingLock) return existingLock

		const clientPromise = (async () => {
			// For TCP-based adapters (js-debug), spawn the server and connect a socket.
			// For stdio adapters (dlv, debugpy, lldb-dap), spawn the adapter directly.
			let proc: BunProcess
			let parentServer: { host: string; port: number } | undefined
			if (config.transport?.kind === "tcp") {
				const tcp = await spawnTcpAdapterForConfig(config, cwd)
				proc = tcp.proc
				parentServer = tcp.addr
			} else {
				proc = spawnStdioAdapter(config, cwd)
			}

			const client: DapClient = {
				name: key,
				cwd,
				proc,
				seq: 0,
				capabilities: null,
				pendingRequests: new Map(),
				messageBuffer: Buffer.alloc(0),
				isReading: false,
				threadId: null,
				stoppedEvent: null,
				stoppedWaiters: [],
				terminatedWaiters: [],
				outputLines: [],
				terminated: false,
				initializedPromise: undefined as unknown as Promise<void>,
				parentServer,
			}
			// Set up the initialized promise after the client object exists
			// so initializedResolve can reference it.
			client.initializedPromise = new Promise((resolve) => {
				client.initializedResolve = resolve
			})
			this.clients.set(key, client)

			// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
			;(proc as any).exited.then(() => {
				this.clients.delete(key)
				this.clientLocks.delete(key)
				const spawnErr = (proc as Partial<SpawnTrackedProcess>).spawnError
				// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
				const adapterExitCode = (proc as any).exitCode
				const err = spawnErr
					? new Error(`DAP adapter '${config.command}' failed to start: ${spawnErr.message}`)
					: new Error(`DAP adapter exited (code ${adapterExitCode})`)
				for (const pending of client.pendingRequests.values()) pending.reject(err)
				client.pendingRequests.clear()
				rejectWaiters(client, err)
				if (client.childClient) {
					for (const pending of client.childClient.pendingRequests.values()) pending.reject(err)
					client.childClient.pendingRequests.clear()
					client.childClient.terminated = true
				}
			})

			startMessageReader(client)
			// Drain stderr to prevent pipe buffer filling and blocking stdout.
			;(async () => {
				const reader = client.proc.stderr.getReader()
				try {
					while (true) {
						const { done } = await reader.read()
						if (done) break
					}
				} finally {
					reader.releaseLock()
				}
			})()

			try {
				const initBody = await sendRequest(client, "initialize", {
					clientID: "kimchi",
					clientName: "Kimchi DAP Client",
					adapterID: config.launchType,
					locale: "en-US",
					linesStartAt1: true,
					columnsStartAt1: true,
					supportsVariableType: false,
					supportsVariablePaging: false,
					supportsRunInTerminalRequest: false,
					supportsStartDebuggingRequest: true,
					supportsProgressReporting: false,
					supportsInvalidatedEvent: false,
					supportsMemoryReferences: false,
					pathFormat: "path",
				})
				client.capabilities = (initBody as DapCapabilities) ?? null
				return client
			} catch (err) {
				this.clients.delete(key)
				this.clientLocks.delete(key)
				proc.kill()
				throw err
			} finally {
				this.clientLocks.delete(key)
			}
		})()

		this.clientLocks.set(key, clientPromise)
		return clientPromise
	}

	/** Tear down every tracked client: reject pending requests, mark terminated,
	 *  and SIGKILL the adapter subprocesses. Also tears down any child clients
	 *  created by a `startDebugging` reverse-request (js-debug nested sessions).
	 *  Called on session_shutdown. */
	shutdownAll(): void {
		const all = Array.from(this.clients.values())
		this.clients.clear()
		const err = new Error("DAP shutdown")
		for (const client of all) {
			for (const pending of client.pendingRequests.values()) pending.reject(err)
			client.pendingRequests.clear()
			rejectWaiters(client, err)
			client.terminated = true
			client.proc.kill()
			if (client.childClient) {
				for (const pending of client.childClient.pendingRequests.values()) pending.reject(err)
				client.childClient.pendingRequests.clear()
				rejectWaiters(client.childClient, err)
				client.childClient.terminated = true
				try {
					client.childClient.proc.kill()
				} catch {
					// child socket already closed
				}
			}
		}
	}

	/** All currently tracked clients. Used by status reporting / tests. */
	getAll(): DapClient[] {
		return Array.from(this.clients.values())
	}
}

// =============================================================================
// Protocol
// =============================================================================

export async function sendRequest(
	client: DapClient,
	command: string,
	args?: unknown,
	timeoutMs?: number,
): Promise<unknown> {
	// js-debug nested session: once a child client exists (or is being set up),
	// route every request to the child connection. Awaiting `childClientReady`
	// ensures the child's initialize + launch + configurationDone handshake has
	// completed before any debug request is sent. The promise is unset for
	// stdio adapters and before `startDebugging` arrives, so non-nested sessions
	// are unaffected.
	if (client.childClientReady) {
		try {
			await client.childClientReady
		} catch {
			// Setup failed — childClient remains unset; fall through to the parent.
		}
	}
	if (client.childClient) {
		return sendRequest(client.childClient, command, args, timeoutMs)
	}
	if (client.childSetupError) {
		throw new Error(`DAP child session setup failed (startDebugging): ${client.childSetupError.message}`)
	}
	const seq = ++client.seq
	const request: DapRequest = { seq, type: "request", command, arguments: args }

	const timeoutDuration = timeoutMs ?? DEFAULT_TIMEOUT_MS
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			client.pendingRequests.delete(seq)
			reject(new Error(`DAP ${command} timed out after ${timeoutDuration}ms`))
		}, timeoutDuration)

		const pending: DapPendingRequest = {
			resolve: (v) => {
				clearTimeout(timer)
				resolve(v)
			},
			reject: (e) => {
				clearTimeout(timer)
				reject(e)
			},
			command,
		}

		client.pendingRequests.set(seq, pending)

		writeMessage(client.proc, request).catch((err) => {
			clearTimeout(timer)
			client.pendingRequests.delete(seq)
			reject(err)
		})
	})
}

export async function sendResponse(
	client: DapClient,
	requestSeq: number,
	command: string,
	success: boolean,
	body?: unknown,
	message?: string,
): Promise<void> {
	const response: DapResponse = {
		seq: ++client.seq,
		type: "response",
		request_seq: requestSeq,
		success,
		command,
		body,
		message,
	}
	await writeMessage(client.proc, response)
}

/** Non-fatal async failures (reverse-request replies, child-session setup) must
 *  be observable without crashing the reader loop — log instead of silently
 *  swallowing. */
function logSwallow(label: string): (err: unknown) => void {
	return (err: unknown) => {
		console.error(`[dap] ${label} failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}
