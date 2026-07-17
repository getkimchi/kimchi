import { randomUUID } from "node:crypto"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { isGlimpseAvailable, openGlimpseWindow } from "./glimpse-ui.js"
import { logger } from "./logger.js"
import type { McpExtensionState } from "./state.js"
import {
	extractUiPromptText,
	UI_STREAM_HOST_CONTEXT_KEY,
	UI_STREAM_REQUEST_META_KEY,
	UI_STREAM_STRUCTURED_CONTENT_KEY,
	type UiHostContext,
	type UiMessageParams,
	type UiModelContextParams,
	type UiStreamMode,
} from "./types.js"
import { startUiServer, type UiServerHandle } from "./ui-server.js"

let activeGlimpseWindow: { close(): void } | null = null

export interface UiSessionRequest {
	serverName: string
	toolName: string
	toolArgs: Record<string, unknown>
	uiResourceUri: string
	streamMode?: UiStreamMode
}

export interface UiSessionRuntime {
	serverName: string
	toolName: string
	reused: boolean
	streamId?: string
	streamToken?: string
	streamMode?: UiStreamMode
	requestMeta?: Record<string, unknown>
	url: string
	isActive: () => boolean
	sendToolResult: (result: CallToolResult) => void
	sendResultPatch: (result: CallToolResult) => void
	sendToolCancelled: (reason: string) => void
	close: (reason?: string) => void
}

const MAX_COMPLETED_SESSIONS = 10

function withStreamEnvelope(result: CallToolResult, streamId: string | undefined, sequence: number): CallToolResult {
	if (!streamId) {
		return result
	}

	const structuredContent =
		result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
			? { ...result.structuredContent }
			: {}

	const rawEnvelope = structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY]
	const envelope =
		rawEnvelope && typeof rawEnvelope === "object" && !Array.isArray(rawEnvelope)
			? { ...(rawEnvelope as Record<string, unknown>) }
			: {
					frameType: "final",
					phase: "settled",
					status: result.isError ? "error" : "ok",
				}

	structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY] = {
		...envelope,
		streamId,
		sequence,
	}

	return {
		...result,
		structuredContent,
	}
}

async function openInBrowser(state: McpExtensionState, url: string): Promise<void> {
	try {
		await state.openBrowser(url)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		state.ui?.notify(`MCP UI browser open failed: ${message}`, "warning")
		state.ui?.notify(`Open manually: ${url}`, "info")
	}
}

export async function maybeStartUiSession(
	state: McpExtensionState,
	request: UiSessionRequest,
): Promise<UiSessionRuntime | null> {
	const log = logger.child({
		component: "UiSession",
		server: request.serverName,
		tool: request.toolName,
	})

	try {
		if (
			state.uiServer &&
			state.uiServer.serverName === request.serverName &&
			state.uiServer.toolName === request.toolName
		) {
			const existingHandle = state.uiServer
			const streamMode = request.streamMode
			const streamId = streamMode ? randomUUID() : undefined
			const streamToken = streamMode ? randomUUID() : undefined
			let active = true
			let nextStreamSequence = 0

			const cleanupStreamListener = () => {
				if (streamToken) {
					state.manager.removeUiStreamListener(streamToken)
				}
			}

			existingHandle.sendToolInput(request.toolArgs)

			if (streamToken) {
				state.manager.registerUiStreamListener(streamToken, (serverName, notification) => {
					if (!active || state.uiServer !== existingHandle) return
					if (serverName !== request.serverName) return
					nextStreamSequence += 1
					existingHandle.sendResultPatch(
						withStreamEnvelope(notification.result as CallToolResult, streamId, nextStreamSequence),
					)
				})
			}

			return {
				serverName: request.serverName,
				toolName: request.toolName,
				reused: true,
				streamId,
				streamToken,
				streamMode,
				requestMeta: streamToken ? { [UI_STREAM_REQUEST_META_KEY]: streamToken } : undefined,
				url: existingHandle.url,
				isActive: () => active && state.uiServer === existingHandle,
				sendToolResult: (result: CallToolResult) => {
					if (!active || state.uiServer !== existingHandle) return
					nextStreamSequence += 1
					existingHandle.sendToolResult(withStreamEnvelope(result, streamId, nextStreamSequence))
				},
				sendResultPatch: (result: CallToolResult) => {
					if (!active || state.uiServer !== existingHandle) return
					nextStreamSequence += 1
					existingHandle.sendResultPatch(withStreamEnvelope(result, streamId, nextStreamSequence))
				},
				sendToolCancelled: (reason: string) => {
					if (!active || state.uiServer !== existingHandle) return
					nextStreamSequence += 1
					existingHandle.sendToolResult(
						withStreamEnvelope(
							{
								isError: true,
								content: [{ type: "text", text: reason }],
							},
							streamId,
							nextStreamSequence,
						),
					)
				},
				close: () => {
					active = false
					cleanupStreamListener()
				},
			}
		}

		const resource = await state.uiResourceHandler.readUiResource(request.serverName, request.uiResourceUri)

		if (state.uiServer) {
			state.uiServer.close("replaced")
			state.uiServer = null
		}
		if (activeGlimpseWindow) {
			activeGlimpseWindow.close()
			activeGlimpseWindow = null
		}

		const streamMode = request.streamMode
		const streamId = streamMode ? randomUUID() : undefined
		const streamToken = streamMode ? randomUUID() : undefined
		const hostContext: UiHostContext | undefined =
			streamMode && streamId
				? {
						[UI_STREAM_HOST_CONTEXT_KEY]: {
							mode: streamMode,
							streamId,
							intermediateResultPatches: streamMode === "stream-first",
							partialInput: false,
						},
					}
				: undefined

		let active = true
		let nextStreamSequence = 0
		let handle: UiServerHandle | null = null

		const cleanupStreamListener = () => {
			if (streamToken) {
				state.manager.removeUiStreamListener(streamToken)
			}
		}

		handle = await startUiServer({
			serverName: request.serverName,
			toolName: request.toolName,
			toolArgs: streamMode === "stream-first" ? {} : request.toolArgs,
			resource,
			manager: state.manager,
			consentManager: state.consentManager,
			hostContext,

			onMessage: (params: UiMessageParams) => {
				const prompt = extractUiPromptText(params)
				if (prompt) {
					if (state.sendMessage) {
						state.sendMessage(
							{
								customType: "mcp-ui-prompt",
								content: [{ type: "text", text: `User sent prompt from ${request.serverName} UI: "${prompt}"` }],
								display: true,
								details: { server: request.serverName, tool: request.toolName, prompt },
							},
							{ triggerTurn: true },
						)
						log.debug("Triggered agent turn for UI prompt", { prompt: prompt.slice(0, 50) })
					}
				} else if (params.type === "intent" || params.intent) {
					const intent = params.intent ?? ""
					const intentParams = params.params
					if (intent && state.sendMessage) {
						const paramsStr = intentParams ? ` ${JSON.stringify(intentParams)}` : ""
						state.sendMessage(
							{
								customType: "mcp-ui-intent",
								content: [
									{ type: "text", text: `User triggered intent from ${request.serverName} UI: ${intent}${paramsStr}` },
								],
								display: true,
								details: { server: request.serverName, tool: request.toolName, intent, params: intentParams },
							},
							{ triggerTurn: true },
						)
						log.debug("Triggered agent turn for UI intent", { intent })
					}
				} else if (params.type === "notify" || params.message) {
					const text = params.message ?? ""
					if (text && state.ui) {
						state.ui.notify(`[${request.serverName}] ${text}`, "info")
					}
				}
			},

			onContextUpdate: (params: UiModelContextParams) => {
				log.debug("Model context update from UI", {
					hasContent: !!params.content,
					hasStructured: !!params.structuredContent,
				})
			},

			onComplete: (reason: string) => {
				active = false
				cleanupStreamListener()

				if (state.uiServer === handle && handle) {
					const messages = handle.getSessionMessages()
					const stream = handle.getStreamSummary()
					const hasContent =
						messages.prompts.length > 0 || messages.intents.length > 0 || messages.notifications.length > 0 || !!stream

					if (hasContent) {
						state.completedUiSessions.push({
							serverName: handle.serverName,
							toolName: handle.toolName,
							completedAt: new Date(),
							reason,
							messages,
							stream,
						})

						while (state.completedUiSessions.length > MAX_COMPLETED_SESSIONS) {
							state.completedUiSessions.shift()
						}

						log.debug("Session completed", {
							reason,
							prompts: messages.prompts.length,
							intents: messages.intents.length,
							notifications: messages.notifications.length,
							streamFrames: stream?.frames ?? 0,
						})
					}

					state.uiServer = null
					if (activeGlimpseWindow) {
						activeGlimpseWindow.close()
						activeGlimpseWindow = null
					}
				}
			},
		})

		if (streamToken) {
			state.manager.registerUiStreamListener(streamToken, (serverName, notification) => {
				if (!active || state.uiServer !== handle) return
				if (serverName !== request.serverName) return
				nextStreamSequence += 1
				handle.sendResultPatch(withStreamEnvelope(notification.result as CallToolResult, streamId, nextStreamSequence))
			})
		}

		state.uiServer = handle

		const glimpseDetected = isGlimpseAvailable()
		const viewerPref = process.env.MCP_UI_VIEWER?.toLowerCase()
		const useGlimpse = viewerPref === "glimpse" || (viewerPref !== "browser" && glimpseDetected)

		if (useGlimpse) {
			try {
				const glimpseHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden}iframe{width:100%;height:100%;border:none}</style></head><body><iframe src="${handle.url}"></iframe></body></html>`
				activeGlimpseWindow = await openGlimpseWindow(glimpseHtml, {
					title: `MCP · ${request.serverName} · ${request.toolName}`,
					width: 1000,
					height: 800,
					onClosed: () => {
						if (active) handle.close("glimpse-closed")
					},
				})
			} catch (error) {
				log.debug("Glimpse unavailable, using browser", {
					error: error instanceof Error ? error.message : String(error),
				})
				await openInBrowser(state, handle.url)
			}
		} else {
			await openInBrowser(state, handle.url)
		}

		return {
			serverName: request.serverName,
			toolName: request.toolName,
			reused: false,
			streamId,
			streamToken,
			streamMode,
			requestMeta: streamToken ? { [UI_STREAM_REQUEST_META_KEY]: streamToken } : undefined,
			url: handle.url,
			isActive: () => active && state.uiServer === handle,
			sendToolResult: (result: CallToolResult) => {
				if (!active || state.uiServer !== handle) return
				nextStreamSequence += 1
				handle.sendToolResult(withStreamEnvelope(result, streamId, nextStreamSequence))
			},
			sendResultPatch: (result: CallToolResult) => {
				if (!active || state.uiServer !== handle) return
				nextStreamSequence += 1
				handle.sendResultPatch(withStreamEnvelope(result, streamId, nextStreamSequence))
			},
			sendToolCancelled: (reason: string) => {
				if (!active || state.uiServer !== handle) return
				handle.sendToolCancelled(reason)
			},
			close: (reason?: string) => {
				active = false
				cleanupStreamListener()
				handle.close(reason)
			},
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log.error("Failed to start UI session", error instanceof Error ? error : undefined)
		state.ui?.notify(`MCP UI unavailable for ${request.toolName} (${request.serverName}): ${message}`, "warning")
		return null
	}
}
