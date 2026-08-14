import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ConsentManager } from "./consent-manager.js"
import { ServerError, wrapError } from "./errors.js"
import { applyCspMeta, buildCspMetaContent, buildHostHtmlTemplate } from "./host-html-template.js"
import { logger } from "./logger.js"
import type { McpServerManager } from "./server-manager.js"
import {
	extractUiPromptText,
	getVisualizationStreamEnvelope,
	type UiDisplayMode,
	type UiDisplayModeRequest,
	type UiDisplayModeResult,
	type UiHostContext,
	type UiMessageParams,
	type UiModelContextParams,
	type UiOpenLinkResult,
	type UiProxyRequestBody,
	type UiProxyResult,
	type UiResourceContent,
	type UiSessionMessages,
	type UiStreamSummary,
} from "./types.js"

const MAX_BODY_SIZE = 2 * 1024 * 1024
const ABANDONED_GRACE_MS = 60_000
const WATCHDOG_INTERVAL_MS = 5_000
const MAX_EVENT_LOG = 128

export interface UiServerOptions {
	serverName: string
	toolName: string
	toolArgs: Record<string, unknown>
	resource: UiResourceContent
	manager: McpServerManager
	consentManager: ConsentManager
	hostContext?: UiHostContext
	initialResultPromise?: Promise<CallToolResult>
	sessionToken?: string
	port?: number
	onMessage?: (params: UiMessageParams) => Promise<void> | void
	onContextUpdate?: (params: UiModelContextParams) => Promise<void> | void
	onComplete?: (reason: string) => void
}

export interface UiServerHandle {
	url: string
	port: number
	sessionToken: string
	serverName: string
	toolName: string
	close: (reason?: string) => void
	sendToolInput: (args: Record<string, unknown>) => void
	sendToolResult: (result: CallToolResult) => void
	sendResultPatch: (result: CallToolResult) => void
	sendToolCancelled: (reason: string) => void
	sendHostContext: (context: UiHostContext) => void
	/** Get accumulated messages from this session */
	getSessionMessages: () => UiSessionMessages
	getStreamSummary: () => UiStreamSummary | undefined
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
	const sessionToken = options.sessionToken ?? randomUUID()
	const log = logger.child({
		component: "UiServer",
		server: options.serverName,
		tool: options.toolName,
		session: sessionToken.slice(0, 8),
	})

	log.debug("Starting UI server")

	const sseClients = new Set<ServerResponse>()
	let completed = false
	let lastHeartbeatAt = Date.now()
	let watchdog: NodeJS.Timeout | null = null
	let currentDisplayMode: UiDisplayMode = options.hostContext?.displayMode ?? "inline"
	let nextEventId = 1
	const eventLog: Array<{ id: number; name: string; payload: unknown }> = []
	let streamSummary: UiStreamSummary | undefined

	// Track messages from UI for retrieval
	const sessionMessages: UiSessionMessages = {
		prompts: [],
		notifications: [],
		intents: [],
	}

	const hostContext: UiHostContext = {
		displayMode: currentDisplayMode,
		availableDisplayModes: ["inline", "fullscreen", "pip"],
		platform: "desktop",
		...options.hostContext,
		// Only include toolInfo if caller provides full tool definition with inputSchema
		// The App validates toolInfo.tool.inputSchema as required object
	}

	const initialStreamContext = hostContext["pi-mcp-adapter/stream"]
	if (initialStreamContext && typeof initialStreamContext === "object") {
		const streamId = (initialStreamContext as { streamId?: unknown }).streamId
		const mode = (initialStreamContext as { mode?: unknown }).mode
		if (typeof streamId === "string" && (mode === "eager" || mode === "stream-first")) {
			streamSummary = {
				streamId,
				mode,
				frames: 0,
				phases: [],
			}
		}
	}

	const touchHeartbeat = () => {
		lastHeartbeatAt = Date.now()
	}

	const updateStreamSummary = (payload: unknown) => {
		const envelope = getVisualizationStreamEnvelope(
			(payload as { structuredContent?: unknown } | null)?.structuredContent,
		)
		if (!envelope) return
		if (!streamSummary) {
			streamSummary = {
				streamId: envelope.streamId,
				mode: "eager",
				frames: 0,
				phases: [],
			}
		}
		streamSummary.frames += 1
		if (!streamSummary.phases.includes(envelope.phase)) {
			streamSummary.phases.push(envelope.phase)
		}
		streamSummary.finalStatus = envelope.status
		streamSummary.lastMessage = envelope.message
	}

	const serializeEvent = (eventId: number, name: string, payload: unknown): string => {
		return `id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
	}

	const getLatestCheckpointIndex = () => {
		for (let index = eventLog.length - 1; index >= 0; index -= 1) {
			const entry = eventLog[index]
			const envelope = getVisualizationStreamEnvelope(
				(entry.payload as { structuredContent?: unknown } | null)?.structuredContent,
			)
			if (envelope?.frameType === "checkpoint" || envelope?.frameType === "final") {
				return index
			}
		}
		return -1
	}

	const pruneEventLog = () => {
		if (eventLog.length <= MAX_EVENT_LOG) return
		const latestCheckpointIndex = getLatestCheckpointIndex()

		if (latestCheckpointIndex > 0) {
			eventLog.splice(0, latestCheckpointIndex)
		}

		if (eventLog.length > MAX_EVENT_LOG) {
			eventLog.splice(0, eventLog.length - MAX_EVENT_LOG)
		}
	}

	const pushEvent = (name: string, payload: unknown) => {
		if (completed) return
		const eventId = nextEventId++
		eventLog.push({ id: eventId, name, payload })
		updateStreamSummary(payload)
		pruneEventLog()
		const chunk = serializeEvent(eventId, name, payload)
		for (const client of sseClients) {
			try {
				client.write(chunk)
			} catch {
				sseClients.delete(client)
			}
		}
	}

	const replayEvents = (res: ServerResponse, lastEventIdHeader?: string | null) => {
		const parsedLastId = lastEventIdHeader ? Number(lastEventIdHeader) : Number.NaN
		const eventsToReplay = Number.isFinite(parsedLastId)
			? eventLog.filter((entry) => entry.id > parsedLastId)
			: (() => {
					const latestCheckpointIndex = getLatestCheckpointIndex()
					return latestCheckpointIndex >= 0 ? eventLog.slice(latestCheckpointIndex) : eventLog
				})()

		for (const entry of eventsToReplay) {
			try {
				res.write(serializeEvent(entry.id, entry.name, entry.payload))
			} catch {
				sseClients.delete(res)
				return
			}
		}
	}

	const closeSse = () => {
		for (const client of sseClients) {
			try {
				client.end()
			} catch {}
		}
		sseClients.clear()
	}

	const stopWatchdog = () => {
		if (!watchdog) return
		clearInterval(watchdog)
		watchdog = null
	}

	const markCompleted = (reason: string) => {
		if (completed) return
		log.debug("Session completed", { reason })
		pushEvent("session-complete", { reason })
		completed = true
		stopWatchdog()
		options.onComplete?.(reason)
	}

	const server = http.createServer(async (req, res) => {
		try {
			const method = req.method || "GET"
			const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)

			if (method === "GET" && url.pathname === "/") {
				if (!validateTokenQuery(url, sessionToken, res)) return
				touchHeartbeat()

				const html = buildHostHtmlTemplate({
					sessionToken,
					serverName: options.serverName,
					toolName: options.toolName,
					toolArgs: options.toolArgs,
					resource: options.resource,
					allowAttribute: buildAllowAttribute(options.resource.meta.permissions),
					requireToolConsent: options.consentManager.requiresPrompt(options.serverName),
					cacheToolConsent: options.consentManager.shouldCacheConsent(),
					hostContext,
				})

				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				})
				res.end(html)
				return
			}

			if (method === "GET" && url.pathname === "/events") {
				if (!validateTokenQuery(url, sessionToken, res)) return
				touchHeartbeat()
				log.debug("SSE client connected", { clientCount: sseClients.size + 1 })
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				})
				res.write(": connected\n\n")
				sseClients.add(res)
				replayEvents(res, req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : null)
				req.on("close", () => {
					sseClients.delete(res)
				})
				return
			}

			if (method === "GET" && url.pathname === "/health") {
				if (!validateTokenQuery(url, sessionToken, res)) return
				sendJson(res, 200, { ok: true, result: { healthy: true } })
				return
			}

			if (method === "GET" && url.pathname === "/ui-app") {
				if (!validateTokenQuery(url, sessionToken, res)) return
				touchHeartbeat()
				// Serve the MCP app's UI HTML directly (avoids blob URL security issues)
				// Apply CSP meta tag if specified in resource metadata
				const cspContent = buildCspMetaContent(options.resource.meta.csp)
				const appHtml = applyCspMeta(options.resource.html, cspContent)
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				})
				res.end(appHtml)
				return
			}

			if (method === "GET" && url.pathname === "/app-bridge.bundle.js") {
				// Serve the pre-bundled AppBridge module
				const bundlePath = path.join(import.meta.dirname, "app-bridge.bundle.js")
				try {
					const content = await fs.readFile(bundlePath, "utf-8")
					res.writeHead(200, {
						"Content-Type": "application/javascript",
						"Cache-Control": "public, max-age=31536000",
					})
					res.end(content)
				} catch {
					sendJson(res, 500, { ok: false, error: "Bundle not found" })
				}
				return
			}

			if (method !== "POST") {
				sendJson(res, 404, { ok: false, error: "Not found" })
				return
			}

			const body = await parseBody(req, res)
			if (!body) return
			if (!validateTokenBody(body, sessionToken, res)) return
			const params = body.params ?? {}
			touchHeartbeat()

			if (url.pathname === "/proxy/tools/call") {
				options.consentManager.ensureApproved(options.serverName)
				const callParams = params as CallToolRequest["params"]
				if (!callParams || typeof callParams.name !== "string" || !callParams.name.trim()) {
					sendJson(res, 400, { ok: false, error: "Invalid tools/call params" })
					return
				}

				const connection = options.manager.getConnection(options.serverName)
				if (connection?.status !== "connected") {
					sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is not connected` })
					return
				}

				try {
					options.manager.touch(options.serverName)
					options.manager.incrementInFlight(options.serverName)
					const result = await connection.client.callTool({
						name: callParams.name,
						arguments:
							callParams.arguments && typeof callParams.arguments === "object" && !Array.isArray(callParams.arguments)
								? callParams.arguments
								: {},
					})
					sendJson(res, 200, { ok: true, result })
				} finally {
					options.manager.decrementInFlight(options.serverName)
					options.manager.touch(options.serverName)
				}
				return
			}

			if (url.pathname === "/proxy/ui/consent") {
				const approved = !!(params as { approved?: boolean }).approved
				options.consentManager.registerDecision(options.serverName, approved)
				sendJson(res, 200, { ok: true, result: { approved } })
				return
			}

			if (url.pathname === "/proxy/ui/message") {
				const msgParams = params as UiMessageParams
				const promptText = extractUiPromptText(msgParams)

				// Track messages by type (order: prompt → intent → notify)
				// Must match the order in index.ts onMessage handler
				if (promptText) {
					sessionMessages.prompts.push(promptText)
					log.debug("UI prompt received", { prompt: promptText.slice(0, 100) })
				} else if (msgParams.type === "intent" || msgParams.intent) {
					const intentName = msgParams.intent ?? ""
					if (intentName) {
						sessionMessages.intents.push({
							intent: intentName,
							params: msgParams.params,
						})
						log.debug("UI intent received", { intent: intentName })
					}
				} else if (msgParams.type === "notify" || msgParams.message) {
					const notifyText = msgParams.message ?? ""
					if (notifyText) {
						sessionMessages.notifications.push(notifyText)
						log.debug("UI notification", { message: notifyText.slice(0, 100) })
					}
				}

				await options.onMessage?.(msgParams)
				sendJson(res, 200, { ok: true, result: {} })
				return
			}

			if (url.pathname === "/proxy/ui/context") {
				const ctxParams = params as UiModelContextParams
				log.debug("UI context update", { hasContent: !!ctxParams.content })
				await options.onContextUpdate?.(ctxParams)
				sendJson(res, 200, { ok: true, result: {} })
				return
			}

			if (url.pathname === "/proxy/ui/open-link") {
				const openParams = params as { url?: string }
				if (!openParams?.url || typeof openParams.url !== "string") {
					sendJson(res, 400, { ok: false, error: "Invalid open-link params" })
					return
				}
				let result: UiOpenLinkResult = {}
				try {
					new URL(openParams.url)
				} catch {
					result = { isError: true }
				}
				sendJson(res, 200, { ok: true, result })
				return
			}

			if (url.pathname === "/proxy/ui/download-file") {
				sendJson(res, 200, { ok: true, result: { isError: true } })
				return
			}

			if (url.pathname === "/proxy/ui/request-display-mode") {
				const displayParams = params as UiDisplayModeRequest
				const requested = displayParams?.mode
				const available = hostContext.availableDisplayModes ?? ["inline"]
				if (requested && available.includes(requested)) {
					currentDisplayMode = requested
				}
				hostContext.displayMode = currentDisplayMode
				pushEvent("host-context", { displayMode: currentDisplayMode })
				const result: UiDisplayModeResult = { mode: currentDisplayMode }
				sendJson(res, 200, { ok: true, result })
				return
			}

			if (url.pathname === "/proxy/ui/heartbeat") {
				sendJson(res, 200, { ok: true, result: {} })
				return
			}

			if (url.pathname === "/proxy/ui/complete") {
				const reason =
					typeof (params as { reason?: string }).reason === "string" ? (params as { reason: string }).reason : "done"
				markCompleted(reason)
				sendJson(res, 200, { ok: true, result: {} })
				setTimeout(() => {
					try {
						server.close()
					} catch {}
					closeSse()
				}, 20).unref()
				return
			}

			sendJson(res, 404, { ok: false, error: "Not found" })
		} catch (error) {
			const wrapped = wrapError(error, { server: options.serverName, tool: options.toolName })
			const status = /approval required|denied/i.test(wrapped.message) ? 403 : 500
			if (status === 500) {
				log.error("Request handler error", error instanceof Error ? error : undefined)
			}
			sendJson(res, status, { ok: false, error: wrapped.message })
		}
	})

	if (options.initialResultPromise) {
		options.initialResultPromise.then(
			(result) => pushEvent("tool-result", result),
			(error) => {
				const reason = error instanceof Error ? error.message : String(error)
				pushEvent("tool-cancelled", { reason })
			},
		)
	}

	watchdog = setInterval(() => {
		if (completed) return
		if (Date.now() - lastHeartbeatAt <= ABANDONED_GRACE_MS) return
		markCompleted("stale")
		try {
			server.close()
		} catch {}
		closeSse()
	}, WATCHDOG_INTERVAL_MS)
	watchdog.unref()

	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			log.error("Failed to start server", error)
			reject(new ServerError(error.message, { port: options.port, cause: error }))
		}

		server.once("error", onError)
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", onError)
			const address = server.address()
			if (!address || typeof address === "string") {
				const err = new ServerError("invalid address")
				log.error("Invalid server address", err)
				reject(err)
				return
			}

			log.debug("Server started", { port: address.port })

			const handle: UiServerHandle = {
				url: `http://localhost:${address.port}/?session=${sessionToken}`,
				port: address.port,
				sessionToken,
				serverName: options.serverName,
				toolName: options.toolName,
				close: (reason?: string) => {
					markCompleted(reason ?? "closed")
					try {
						server.close()
					} catch {}
					closeSse()
				},
				sendToolInput: (args: Record<string, unknown>) => {
					pushEvent("tool-input", { arguments: args })
				},
				sendToolResult: (result: CallToolResult) => {
					pushEvent("tool-result", result)
				},
				sendResultPatch: (result: CallToolResult) => {
					pushEvent("result-patch", result)
				},
				sendToolCancelled: (reason: string) => {
					pushEvent("tool-cancelled", { reason })
				},
				sendHostContext: (context: UiHostContext) => {
					Object.assign(hostContext, context)
					pushEvent("host-context", context)
				},
				getSessionMessages: () => ({ ...sessionMessages }),
				getStreamSummary: () => (streamSummary ? { ...streamSummary, phases: [...streamSummary.phases] } : undefined),
			}

			resolve(handle)
		})
	})
}

async function parseBody(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<UiProxyRequestBody<Record<string, unknown>> | null> {
	try {
		const body = await readBody(req)
		if (!body || typeof body !== "object") {
			sendJson(res, 400, { ok: false, error: "Invalid request body" })
			return null
		}
		return body as UiProxyRequestBody<Record<string, unknown>>
	} catch (error) {
		sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid body" })
		return null
	}
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []

		req.on("data", (chunk: Buffer) => {
			size += chunk.length
			if (size > MAX_BODY_SIZE) {
				req.destroy()
				reject(new Error("Request body too large"))
				return
			}
			chunks.push(chunk)
		})

		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")))
			} catch (error) {
				reject(error)
			}
		})

		req.on("error", reject)
	})
}

function validateTokenQuery(url: URL, expected: string, res: ServerResponse): boolean {
	const token = url.searchParams.get("session")
	if (token !== expected) {
		sendJson(res, 403, { ok: false, error: "Invalid session" })
		return false
	}
	return true
}

function validateTokenBody(
	body: UiProxyRequestBody<Record<string, unknown>>,
	expected: string,
	res: ServerResponse,
): boolean {
	if (body.token !== expected) {
		sendJson(res, 403, { ok: false, error: "Invalid session" })
		return false
	}
	return true
}

function sendJson<T>(res: ServerResponse, status: number, payload: UiProxyResult<T>): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	})
	res.end(JSON.stringify(payload))
}
