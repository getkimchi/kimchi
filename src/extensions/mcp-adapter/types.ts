import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
// types.ts - Core type definitions
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { UiStreamMode } from "./ui-stream-types.js"

// Transport type (stdio + HTTP)
export type Transport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

// Import sources for config
export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "codex" | "windsurf" | "vscode"

// Tool definition from MCP server
export interface McpTool {
	name: string
	title?: string
	description?: string
	inputSchema?: unknown // JSON Schema
	_meta?: Record<string, unknown>
}

// Resource definition from MCP server
export interface McpResource {
	uri: string
	name: string
	description?: string
	mimeType?: string
	_meta?: Record<string, unknown>
}

export interface UiResourceMeta {
	csp?: UiResourceCsp
	permissions?: UiResourcePermissions
	domain?: string
	prefersBorder?: boolean
}

export interface UiResourceContent {
	uri: string
	html: string
	mimeType?: string
	meta: UiResourceMeta
}

export interface UiProxyRequestBody<TParams> {
	token: string
	params: TParams
}

export interface UiProxyResult<T = Record<string, unknown>> {
	ok: boolean
	result?: T
	error?: string
}

export interface UiResourceCsp {
	connectDomains?: string[]
	scriptDomains?: string[]
	styleDomains?: string[]
	fontDomains?: string[]
	imgDomains?: string[]
	mediaDomains?: string[]
	frameDomains?: string[]
	workerDomains?: string[]
	baseUriDomains?: string[]
}

export interface UiResourcePermissions {
	camera?: {}
	microphone?: {}
	geolocation?: {}
	clipboardWrite?: {}
}

export interface UiToolInfo {
	id?: string | number
	tool: {
		name: string
		description?: string
		inputSchema?: unknown
	}
}

export interface UiHostContext {
	toolInfo?: UiToolInfo
	theme?: "light" | "dark"
	styles?: Record<string, unknown>
	displayMode?: UiDisplayMode
	availableDisplayModes?: UiDisplayMode[]
	containerDimensions?: {
		width?: number
		maxWidth?: number
		height?: number
		maxHeight?: number
	}
	[key: string]: unknown
}

export type UiDisplayMode = "inline" | "fullscreen" | "pip"

// Re-export stream types from the shared lightweight module.
// This allows the example package to import stream schemas without pulling the full types.ts dependency graph.
export {
	UI_STREAM_HOST_CONTEXT_KEY,
	UI_STREAM_REQUEST_META_KEY,
	UI_STREAM_RESULT_PATCH_METHOD,
	SERVER_STREAM_RESULT_PATCH_METHOD,
	UI_STREAM_STRUCTURED_CONTENT_KEY,
	uiStreamModeSchema,
	visualizationStreamPhaseSchema,
	visualizationStreamFrameTypeSchema,
	visualizationStreamStatusSchema,
	uiStreamHostContextSchema,
	visualizationStreamEnvelopeSchema,
	uiStreamCallToolResultSchema,
	uiStreamResultPatchNotificationSchema,
	serverStreamResultPatchNotificationSchema,
	getUiStreamHostContext,
	getVisualizationStreamEnvelope,
	type UiStreamMode,
	type VisualizationStreamPhase,
	type VisualizationStreamFrameType,
	type VisualizationStreamStatus,
	type UiStreamHostContext,
	type VisualizationStreamEnvelope,
	type UiStreamCallToolResult,
	type UiStreamResultPatchNotification,
	type ServerStreamResultPatchNotification,
	type UiStreamSummary,
} from "./ui-stream-types.js"

export interface UiMessageParams {
	role?: string
	content?: unknown[]
	type?: "prompt" | "notify" | "intent" | "message"
	message?: string
	prompt?: string
	intent?: string
	params?: Record<string, unknown>
	[key: string]: unknown
}

/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export function extractUiPromptText(params: UiMessageParams): string | undefined {
	if (params.type === "prompt" || params.prompt) {
		const prompt = params.prompt ?? String(params.message ?? "")
		return prompt || undefined
	}

	if (params.role === "user" && Array.isArray(params.content)) {
		const text = params.content
			.map((block) =>
				block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : "",
			)
			.filter(Boolean)
			.join("\n\n")
		return text || undefined
	}

	return undefined
}

/**
 * Structured UI handoff recovered from a canonical prompt envelope.
 */
export interface UiPromptHandoff {
	intent: string
	params: Record<string, unknown>
	raw: string
}

/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined {
	const newlineIndex = prompt.indexOf("\n")
	if (newlineIndex <= 0) {
		return undefined
	}

	const intent = prompt.slice(0, newlineIndex).trim()
	const payloadText = prompt.slice(newlineIndex + 1).trim()
	if (!intent || !payloadText) {
		return undefined
	}

	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
		return undefined
	}

	try {
		const parsed = JSON.parse(payloadText)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined
		}
		return {
			intent,
			params: parsed as Record<string, unknown>,
			raw: prompt,
		}
	} catch {
		return undefined
	}
}

/**
 * Accumulated messages from a UI session.
 * Collected during the session and available when it ends.
 */
export interface UiSessionMessages {
	prompts: string[]
	notifications: string[]
	intents: Array<{ intent: string; params?: Record<string, unknown> }>
}

export interface UiModelContextParams {
	content?: unknown[]
	structuredContent?: Record<string, unknown>
	[key: string]: unknown
}

export interface UiOpenLinkResult {
	isError?: boolean
	[key: string]: unknown
}

export interface UiDisplayModeRequest {
	mode?: UiDisplayMode
}

export interface UiDisplayModeResult {
	mode: UiDisplayMode
	[key: string]: unknown
}

// Content types from MCP
export interface McpContent {
	type: "text" | "image" | "audio" | "resource" | "resource_link"
	text?: string
	data?: string
	mimeType?: string
	resource?: {
		uri: string
		text?: string
		blob?: string
	}
	uri?: string
	name?: string
	description?: string
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent

// OAuth configuration (SDK handles auto-discovery and dynamic registration)
export interface OAuthConfig {
	/** OAuth grant type (defaults to authorization_code) */
	grantType?: "authorization_code" | "client_credentials"
	/** Pre-registered client ID (optional, dynamic registration used if not provided) */
	clientId?: string
	/** Client secret for confidential clients */
	clientSecret?: string
	/** Requested OAuth scopes */
	scope?: string
}

// Server configuration
export interface ServerEntry {
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	// HTTP fields
	url?: string
	headers?: Record<string, string>
	/**
	 * Authentication type:
	 * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
	 * - 'bearer' - Use static Bearer token
	 * - false - Disable authentication
	 * If not specified and url is present, OAuth will be auto-detected
	 */
	auth?: "oauth" | "bearer" | false
	bearerToken?: string
	bearerTokenEnv?: string
	/**
	 * OAuth configuration (optional).
	 * If not provided, the SDK will attempt dynamic client registration.
	 * Set to false to explicitly disable OAuth for this server.
	 */
	oauth?: OAuthConfig | false
	lifecycle?: "keep-alive" | "lazy" | "eager"
	idleTimeout?: number // minutes, overrides global setting
	// Resource handling
	exposeResources?: boolean
	// Direct tool registration
	directTools?: boolean | string[]
	// Exclude specific MCP tools/resources by original or prefixed name
	excludeTools?: string[]
	// Debug
	debug?: boolean // Show server stderr (default: false)
}

// Settings
export interface McpSettings {
	toolPrefix?: "server" | "none" | "short"
	idleTimeout?: number // minutes, default 10, 0 to disable
	directTools?: boolean
	disableProxyTool?: boolean
	autoAuth?: boolean
}

// Root config
export interface McpConfig {
	mcpServers: Record<string, ServerEntry>
	imports?: ImportKind[]
	settings?: McpSettings
}

// Alias for clarity
export type ServerDefinition = ServerEntry

export interface ToolMetadata {
	name: string // Prefixed tool name (e.g., "xcodebuild_list_sims")
	originalName: string // Original MCP tool name (e.g., "list_sims")
	description: string
	resourceUri?: string // For resource tools: the URI to read
	uiResourceUri?: string // For app-enabled tools: the UI resource URI
	inputSchema?: unknown // JSON Schema for parameters (stored for describe/errors)
	uiStreamMode?: UiStreamMode
}

export interface DirectToolSpec {
	serverName: string
	originalName: string
	prefixedName: string
	description: string
	inputSchema?: unknown
	resourceUri?: string
	uiResourceUri?: string
	uiStreamMode?: UiStreamMode
	/** Cached schema for auto-fill and retry decisions */
	metadata?: ToolMetadata
}

export interface ServerProvenance {
	path: string
	kind: "user" | "project" | "import"
	importKind?: string
}

export interface McpPanelCallbacks {
	reconnect: (serverName: string) => Promise<boolean>
	getConnectionStatus: (serverName: string) => "connected" | "idle" | "failed" | "needs-auth"
	refreshCacheAfterReconnect: (serverName: string) => import("./metadata-cache.js").ServerCacheEntry | null
}

export interface McpPanelResult {
	changes: Map<string, true | string[] | false>
	cancelled: boolean
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: "server" | "none" | "short"): string {
	if (mode === "none") return ""
	if (mode === "short") {
		let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_")
		if (!short) short = "mcp"
		return short
	}
	return serverName.replace(/-/g, "_")
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: "server" | "none" | "short"): string {
	const p = getServerPrefix(serverName, prefix)
	return p ? `${p}_${toolName}` : toolName
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_")
}

export function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	excludeTools?: unknown,
): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false

	const candidates = new Set<string>([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	])

	for (const excluded of excludeTools) {
		if (typeof excluded !== "string") continue
		if (candidates.has(normalizeToolName(excluded))) {
			return true
		}
	}

	return false
}
