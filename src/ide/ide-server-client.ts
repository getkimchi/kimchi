/**
 * IDE Server Client - connects to the JetBrains plugin's WebSocket MCP server.
 *
 * Protocol:
 *   1. Plugin writes ~/.config/kimchi/ide/<port>.lock with port, authToken, workspaceFolders.
 *   2. CLI scans that directory, finds the lockfile whose workspaceFolders matches cwd.
 *   3. CLI connects via WebSocket, sending authToken in x-claude-code-ide-authorization header.
 *   4. CLI sends MCP initialize request over JSON-RPC 2.0.
 *   5. Plugin sends selection_changed and at_mentioned notifications.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

export interface IdeContext {
	filePath?: string
	lineStart?: number
	lineEnd?: number
}

interface LockFile {
	port: number
	authToken: string
	ideName: string
	ideVersion: string
	workspaceFolders: string[]
}

let connection: IdeWebSocketConnection | null = null
let editorInjector: ((text: string) => boolean) | null = null

export function setEditorInjector(fn: (text: string) => boolean): void {
	editorInjector = fn
}

export function isIdeConnected(): boolean {
	return connection?.isConnected() ?? false
}

export function getIdeContext(): IdeContext | null {
	return connection?.getContext() ?? null
}

export function consumePendingAtMentions(): string[] {
	return connection?.consumeAtMentions() ?? []
}

export async function connectToIde(cwd: string): Promise<boolean> {
	const lockDir = getLockDir()
	if (!existsSync(lockDir)) {
		console.error(`[kimchi-ide] Lock dir not found: ${lockDir} — JetBrains plugin not running`)
		return false
	}

	const lockFile = findMatchingLockFile(lockDir, cwd)
	if (!lockFile) {
		console.error(`[kimchi-ide] No matching lockfile in ${lockDir} for cwd=${cwd}`)
		return false
	}

	console.error(`[kimchi-ide] Found IDE on port ${lockFile.port} (${lockFile.ideName} ${lockFile.ideVersion})`)
	const conn = new IdeWebSocketConnection(lockFile)
	const ok = await conn.connect()
	if (ok) {
		connection = conn
	}
	return ok
}

function getLockDir(): string {
	const base = process.env.KIMCHI_CONFIG_DIR ?? resolve(homedir(), ".config", "kimchi")
	return resolve(base, "ide")
}

function findMatchingLockFile(lockDir: string, cwd: string): LockFile | null {
	let files: string[]
	try {
		files = readdirSync(lockDir).filter((f) => f.endsWith(".lock"))
	} catch {
		return null
	}

	for (const file of files) {
		try {
			const content = readFileSync(resolve(lockDir, file), "utf-8")
			const lock = JSON.parse(content) as LockFile
			if (lock.workspaceFolders?.some((folder) => cwd.startsWith(folder) || folder.startsWith(cwd))) {
				return lock
			}
		} catch {
			// Skip malformed lock files
		}
	}
	return null
}

class IdeWebSocketConnection {
	private ws: WebSocket | null = null
	private context: IdeContext = {}
	private pendingAtMentions: string[] = []
	private requestId = 1
	private connected = false

	constructor(private readonly lock: LockFile) {}

	isConnected(): boolean {
		return this.connected
	}

	getContext(): IdeContext | null {
		if (!this.context.filePath && this.context.lineStart === undefined) return null
		return { ...this.context }
	}

	consumeAtMentions(): string[] {
		const mentions = this.pendingAtMentions
		this.pendingAtMentions = []
		return mentions
	}

	async connect(): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				const url = `ws://127.0.0.1:${this.lock.port}`
				const ws = new WebSocket(url, {
					headers: {
						"x-claude-code-ide-authorization": this.lock.authToken,
					},
				} as unknown as string[])

				const timeout = setTimeout(() => {
					ws.close()
					resolve(false)
				}, 5000)

				ws.addEventListener("open", () => {
					clearTimeout(timeout)
					this.ws = ws
					this.connected = true
					this.sendInitialize()
					resolve(true)
				})

				ws.addEventListener("message", (event) => {
					this.handleMessage(event.data as string)
				})

				ws.addEventListener("close", () => {
					this.connected = false
					this.ws = null
				})

				ws.addEventListener("error", () => {
					clearTimeout(timeout)
					this.connected = false
					resolve(false)
				})
			} catch {
				resolve(false)
			}
		})
	}

	private sendInitialize(): void {
		const id = this.requestId++
		this.send({
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "kimchi", version: "1.0.0" },
			},
		})
	}

	private handleMessage(text: string): void {
		try {
			const msg = JSON.parse(text) as {
				jsonrpc: string
				id?: unknown
				method?: string
				params?: Record<string, unknown>
				result?: unknown
			}

			if (msg.method) {
				this.handleNotification(msg.method, msg.params ?? {})
			}
			// Responses (with id) are ignored — we don't need to act on them
		} catch {
			// Ignore parse errors
		}
	}

	private handleNotification(method: string, params: Record<string, unknown>): void {
		switch (method) {
			case "selection_changed": {
				const filePath = params.filePath as string | undefined
				const lineStart = params.lineStart as number | undefined
				const lineEnd = params.lineEnd as number | undefined
				if (filePath) {
					this.context = { filePath, lineStart, lineEnd }
				}
				break
			}
			case "at_mentioned": {
				const filePath = params.filePath as string | undefined
				const lineStart = params.lineStart as number | undefined
				const lineEnd = params.lineEnd as number | undefined
				if (filePath) {
					const ref =
						lineStart !== undefined && lineEnd !== undefined ? `@${filePath}:${lineStart}-${lineEnd}` : `@${filePath}`
					// Inject directly into the terminal editor when possible so the user
					// sees the reference immediately. Fall back to the queue when the
					// editor isn't available yet (e.g. before the first session starts).
					const injected = editorInjector?.(ref) ?? false
					if (!injected) {
						this.pendingAtMentions.push(ref)
					}
				}
				break
			}
		}
	}

	private send(msg: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg))
		}
	}
}
