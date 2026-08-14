import type { ToolRenderContext } from "../tool-rendering.js"

export function createToolRenderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		toolCallId: "test-tool-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	}
}
