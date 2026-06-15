// extensions/lsp/client.ts
import type {
	BunProcess,
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
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

	const contentLen = Number.parseInt(lenMatch[1], 10)
	const start = headerEnd + 4
	const end = start + contentLen
	if (buf.length < end) return null

	return {
		message: JSON.parse(buf.slice(start, end).toString()),
		remaining: buf.subarray(end),
	}
}

async function writeMessage(
	proc: BunProcess,
	msg: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const content = JSON.stringify(msg)
	const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`
	proc.stdin.write(header + content)
	if (proc.stdin.flush) await proc.stdin.flush()
}

// =============================================================================
// Message Reader
// =============================================================================

async function startMessageReader(client: LspClient): Promise<void> {
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
					// Reply null to server-initiated requests so servers don't block waiting for a response.
					// (e.g. window/workDoneProgress/create, workspace/configuration)
					if ("method" in message) {
						const response: LspJsonRpcResponse = { jsonrpc: "2.0", id: message.id as number, result: null }
						writeMessage(client.proc, response).catch(() => {})
					}
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
		// Bun global available at runtime but not typed — use globalThis cast
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		const Bun = (globalThis as any).Bun
		const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as BunProcess

		let resolveProjectLoaded!: () => void
		const projectLoaded = new Promise<void>((resolve) => {
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

		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		;(proc as any).exited.then(() => {
			clients.delete(key)
			clientLocks.delete(key)
			client.resolveProjectLoaded()
			// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
			const err = new Error(`LSP server exited (code ${(proc as any).exitCode})`)
			for (const pending of client.pendingRequests.values()) pending.reject(err)
			client.pendingRequests.clear()
		})

		startMessageReader(client)
		// Drain stderr to prevent pipe buffer filling and blocking gopls stdout
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
			await sendRequest(client, "initialize", {
				processId: process.pid,
				rootUri: fileToUri(cwd),
				rootPath: cwd,
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: config.initOptions ?? {},
				workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split("/").pop() ?? "workspace" }],
			})
			await sendNotification(client, "initialized", {})
			await client.projectLoaded
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
			resolve: (v) => {
				clearTimeout(timer)
				resolve(v)
			},
			reject: (e) => {
				clearTimeout(timer)
				reject(e)
			},
			method,
		})

		writeMessage(client.proc, request).catch((err) => {
			clearTimeout(timer)
			client.pendingRequests.delete(id)
			reject(err)
		})
	})
}

export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = { jsonrpc: "2.0", method, params }
	client.lastActivity = Date.now()
	await writeMessage(client.proc, notification)
}

// =============================================================================
// File Sync
// =============================================================================

export async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
	const uri = fileToUri(filePath)
	if (client.openFiles.has(uri)) return

	const lockKey = `${client.name}:${uri}`
	const existingLock = fileOperationLocks.get(lockKey)
	if (existingLock) {
		await existingLock
		return
	}

	const openPromise = (async () => {
		if (client.openFiles.has(uri)) return
		let content: string
		try {
			// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
			const Bun = (globalThis as any).Bun
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
	try {
		await openPromise
	} finally {
		fileOperationLocks.delete(lockKey)
	}
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
			// Send didSave after didOpen so servers like gopls publish diagnostics
			const uri = fileToUri(filePath)
			await sendNotification(client, "textDocument/didSave", { textDocument: { uri } })
			return
		}

		let content: string
		try {
			// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
			const Bun = (globalThis as any).Bun
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
	try {
		await refreshPromise
	} finally {
		fileOperationLocks.delete(lockKey)
	}
}

export function getAllClients(): LspClient[] {
	return Array.from(clients.values())
}
