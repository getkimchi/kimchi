// extensions/dap/client.ts
import { spawn } from "node:child_process"
import net from "node:net"
import type { BunProcess } from "../lsp/types.js"
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
	 *  Tracked so getOrCreateClient can kill it when the client is shut down. */
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

/** Spawn a child process via node:child_process and wrap its stdio to satisfy
 *  the BunProcess interface. Used when Bun is not available (vitest forks pool,
 *  production Node build). Mirrors the BunProcess shape Bun.spawn returns. */
function spawnChildProcessAsBunProcess(argv: string[], cwd: string): BunProcess {
	if (argv.length === 0) throw new Error("DAP adapter spawn requires a command")
	const cmd = argv[0]
	if (!cmd) throw new Error("DAP adapter command is empty")
	const cp = spawn(cmd, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] })
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
	return {
		stdin: stdinWriter,
		stdout: toWebStream(cp.stdout),
		stderr: toWebStream(cp.stderr),
		kill() {
			cp.kill("SIGKILL")
		},
		exited: new Promise<void>((resolve) => cp.on("exit", () => resolve())),
		exitCode: null,
	}
}

/** Resolve the js-debug dapDebugServer.js script path. Searches common install
 *  locations: $JS_DEBUG_PATH, node_modules/js-debug-adapter, Mason, and the
 *  standard global npm prefix. Returns null if not found. */
function resolveJsDebugScript(): string | null {
	if (process.env.JS_DEBUG_PATH) return process.env.JS_DEBUG_PATH
	const fs = require("node:fs")
	const candidates = [
		"node_modules/js-debug-adapter/src/dapDebugServer.js",
		"node_modules/@vscode/js-debug/src/dapDebugServer.js",
	]
	for (const c of candidates) {
		if (fs.existsSync(c)) return c
	}
	// npm global prefix
	try {
		const { execSync } = require("node:child_process")
		const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim()
		const globalPath = `${prefix}/lib/node_modules/js-debug-adapter/src/dapDebugServer.js`
		if (fs.existsSync(globalPath)) return globalPath
	} catch {
		// npm not available
	}
	return null
}

/** Spawn a TCP-based DAP adapter (js-debug's dapDebugServer.js), wait for the
 *  `Debug server listening at <host>:<port>` line, connect a TCP socket, and
 *  return a BunProcess wrapping the socket. Resolves the script path from
 *  config.args (if set) or resolveJsDebugScript(). */
async function spawnTcpAdapterForConfig(config: DapAdapterConfig, cwd: string): Promise<BunProcess> {
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
		childProc = {
			kill: () => cp.kill("SIGKILL"),
			exitCode: null,
			exited: new Promise<void>((resolve) => cp.on("exit", () => resolve())),
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
	} finally {
		clearTimeout(timer)
	}

	const socket = net.createConnection({ host: addr.host, port: addr.port })
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve)
		socket.once("error", reject)
	})
	return wrapSocketAsProcess(socket, childProc)
}

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, DapClient>()
const clientLocks = new Map<string, Promise<DapClient>>()

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

// =============================================================================
// Message Reader
// =============================================================================

async function startMessageReader(client: DapClient): Promise<void> {
	if (client.isReading) return
	client.isReading = true

	const reader = client.proc.stdout.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			client.messageBuffer = Buffer.concat([client.messageBuffer, value])
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
							client.stoppedEvent = body
							if (body.threadId != null) client.threadId = body.threadId
							while (client.stoppedWaiters.length > 0) {
								const waiter = client.stoppedWaiters.shift()
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
							client.terminated = true
							while (client.terminatedWaiters.length > 0) {
								const waiter = client.terminatedWaiters.shift()
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
							if (body.threadId != null) client.threadId = body.threadId
							break
						}
						case "output": {
							const body = message.body as OutputEvent
							client.outputLines.push({
								category: body.category ?? "console",
								text: body.output,
							})
							if (client.outputLines.length > 1000) client.outputLines.shift()
							break
						}
						default:
						// Unknown events are intentionally ignored.
					}
				} else if (message.type === "request") {
					// Server-initiated requests (e.g. runInTerminal) are unsupported in v1.
					// Reply success:false so the adapter falls back to its internal console.
					sendResponse(client, message.seq, false, undefined, `Unsupported server request: ${message.command}`).catch(
						() => {},
					)
				}

				parsed = parseMessage(client.messageBuffer)
			}
		}
	} catch (err) {
		for (const pending of client.pendingRequests.values()) {
			pending.reject(new Error(`DAP connection closed: ${err}`))
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

export async function getOrCreateClient(config: DapAdapterConfig, cwd: string): Promise<DapClient> {
	const key = `${config.command}:${cwd}`

	const existing = clients.get(key)
	if (existing) {
		existing.lastActivity = Date.now()
		return existing
	}

	const existingLock = clientLocks.get(key)
	if (existingLock) return existingLock

	const clientPromise = (async () => {
		// For TCP-based adapters (js-debug), spawn the server and connect a socket.
		// For stdio adapters (dlv, debugpy, lldb-dap), spawn the adapter directly.
		const proc =
			config.transport?.kind === "tcp" ? await spawnTcpAdapterForConfig(config, cwd) : spawnStdioAdapter(config, cwd)

		const client: DapClient = {
			name: key,
			cwd,
			proc,
			seq: 0,
			capabilities: null,
			pendingRequests: new Map(),
			messageBuffer: Buffer.alloc(0),
			isReading: false,
			lastActivity: Date.now(),
			threadId: null,
			stoppedEvent: null,
			stoppedWaiters: [],
			terminatedWaiters: [],
			outputLines: [],
			terminated: false,
		}
		clients.set(key, client)

		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		;(proc as any).exited.then(() => {
			clients.delete(key)
			clientLocks.delete(key)
			// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
			const err = new Error(`DAP adapter exited (code ${(proc as any).exitCode})`)
			for (const pending of client.pendingRequests.values()) pending.reject(err)
			client.pendingRequests.clear()
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
				supportsProgressReporting: false,
				supportsInvalidatedEvent: false,
				supportsMemoryReferences: false,
				pathFormat: "path",
			})
			client.capabilities = (initBody as DapCapabilities) ?? null
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
	const err = new Error("DAP shutdown")
	for (const client of all) {
		for (const pending of client.pendingRequests.values()) pending.reject(err)
		client.pendingRequests.clear()
		client.terminated = true
		client.proc.kill()
	}
}

export function getAllClients(): DapClient[] {
	return Array.from(clients.values())
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
	const seq = ++client.seq
	const request: DapRequest = { seq, type: "request", command, arguments: args }
	client.lastActivity = Date.now()

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
	success: boolean,
	body?: unknown,
	message?: string,
): Promise<void> {
	const response: DapResponse = {
		seq: ++client.seq,
		type: "response",
		request_seq: requestSeq,
		success,
		body,
		message,
	}
	client.lastActivity = Date.now()
	await writeMessage(client.proc, response)
}
