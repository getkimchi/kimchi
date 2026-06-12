import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { registerTodoPromptBlock } from "./prompt-block.js"
import { clearTodoStore, subscribeTodoStore } from "./store.js"
import { registerTodosTool } from "./tool.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./types.js"
export * from "./scope.js"
export * from "./reducer.js"
export * from "./store.js"
export * from "./tool.js"
export * from "./widget.js"
export * from "./command.js"
export * from "./prompt-block.js"

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)

	if (isAgentWorker()) return

	let latestCtx: ExtensionContext | undefined
	let unsubscribeTodoStore: (() => void) | undefined

	registerTodosCommand(pi)
	registerTodoShortcut(pi)

	pi.on("session_start", (event, ctx) => {
		latestCtx = ctx
		if (event.reason === "new") clearTodoStore()
		resetTodoWidgetState()
		ensureTodoWidget(ctx)
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore(() => {
			if (!latestCtx?.hasUI) return
			syncTodoWidget(latestCtx)
		})
		syncTodoWidget(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		latestCtx = undefined
		disposeTodoWidget(ctx)
	})
}
