// extensions/dap/client.ts
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

	const headerText = buf.slice(0, headerEnd).toString()
	const lenMatch = headerText.match(/Content-Length: (\d+)/i)
	if (!lenMatch) return null

	const contentLen = Number.parseInt(lenMatch[1], 10)
	const start = headerEnd + 4
	const end = start + contentLen
	if (buf.length < end) return null

	return {
		message: JSON.parse(buf.slice(start, end).toString()),
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
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		const Bun = (globalThis as any).Bun
		const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as BunProcess

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
