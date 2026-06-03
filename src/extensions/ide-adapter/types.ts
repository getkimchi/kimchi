/** Data written by the IDE plugin into ~/.config/kimchi/ide/<port>.lock */
export interface LockfileData {
	port: number
	pid: number
	ideName: string
	ideVersion: string
	transport: string
	workspaceFolders: string[]
	authToken: string
}

/** A tool exposed by the IDE over MCP */
export interface IdeTool {
	name: string
	description?: string
	inputSchema?: unknown
}

/** Active connection to an IDE plugin */
export interface IdeConnection {
	/** Parsed lockfile data */
	lockfile: LockfileData
	/** Disconnect and clean up */
	close(): Promise<void>
	/** List tools exposed by this IDE */
	listTools(): Promise<IdeTool[]>
	/** Call a tool by name */
	callTool(name: string, args: unknown): Promise<unknown>
	/** Register a callback for JSON-RPC notifications from the IDE */
	setNotificationHandler(handler: (msg: unknown) => void): void
	/** Optional callback invoked when the transport closes unexpectedly */
	onDisconnect?: () => void
}

/** Notification sent by the IDE when user selects "Send to Kimchi" */
export interface AtMentionNotification {
	filePath: string
	lineStart: number
	lineEnd: number
}

/** Notification sent by the IDE when the cursor/selection changes */
export interface SelectionChangedNotification {
	filePath: string
	lineStart: number
	lineEnd: number
}
