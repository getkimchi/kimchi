// Upstream deep imports are not exported from the main package, but they
// are on disk in node_modules after install. We use them via deep-module
// paths to avoid duplicating upstream logic.

declare module "@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js" {
	export type ClipboardImage = {
		bytes: Uint8Array
		mimeType: string
	}
	export function isWaylandSession(env?: NodeJS.ProcessEnv): boolean
	export function extensionForImageMimeType(mimeType: string): string | null
	export function readClipboardImage(options?: {
		env?: NodeJS.ProcessEnv
		platform?: NodeJS.Platform
	}): Promise<ClipboardImage | null>
}

declare module "@earendil-works/pi-coding-agent/dist/cli/file-processor.js" {
	/** Process @file CLI arguments into text content and image attachments
	 *  (upstream inlines non-image files as lossy UTF-8 text). Types only —
	 *  runtime loads it by file URL (see intake.test.ts), as the deep path is
	 *  outside the package's exports map. */
	export function processFileArguments(
		fileArgs: string[],
		options?: { autoResizeImages?: boolean },
	): Promise<{
		text: string
		images: Array<{ type: "image"; mimeType: string; data: string }>
	}>
}

declare module "@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js" {
	/** Minimal typed surface for the telemetry nested-call integration pin
	 *  (telemetry/index.test.ts): the runner itself builds the tool_execution_*
	 *  events — carrying `parentToolCallId` — and hands them to `host.emit`.
	 *  Types only; the deep path is outside the package's exports map. */
	export interface NestedToolExecutionEvent {
		type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
		toolCallId: string
		toolName: string
		parentToolCallId: string
		args?: unknown
		partialResult?: unknown
		result?: unknown
		isError?: boolean
		durationMs?: number
	}
	export interface NestedToolCallHost {
		getTools(): readonly { name: string; executionMode?: string }[]
		isSequential(): boolean
		runToolCall(
			toolCall: { type: "toolCall"; id: string; name: string; arguments: unknown },
			parentToolCallId: string,
			signal: AbortSignal | undefined,
			onUpdate: (partialResult: unknown) => Promise<void>,
		): Promise<{ toolCall: { id: string }; result: unknown; isError: boolean; durationMs?: number }>
		emit(event: NestedToolExecutionEvent): Promise<void>
	}
	export class NestedToolCallRunner {
		constructor(host: NestedToolCallHost)
		execute(
			callerId: string,
			name: string,
			args: unknown,
			options?: { signal?: AbortSignal },
		): Promise<{ toolCall: { id: string }; result: unknown; isError: boolean; durationMs?: number }>
	}
}
