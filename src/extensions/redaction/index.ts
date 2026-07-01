import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { redact } from "./engine.js"
import { collectKnownSecrets } from "./secret-registry.js"
import { scrubSessionFile } from "./session-scrub.js"

export default function createRedactionExtension(pi: ExtensionAPI): void {
	// Per-instance secrets set — not module-scoped, so concurrent sessions
	// don't cross-contaminate each other's redaction state.
	let knownSecrets = new Set<string>()

	pi.on("session_start", () => {
		try {
			knownSecrets = collectKnownSecrets()
		} catch {
			knownSecrets = new Set()
		}
	})

	// Hook 1: Scrub secrets in tool-result content before they reach the model.
	// Also scrub event.input (tool-call args echoed in the result) in place,
	// since the ToolResultEventResult type doesn't support returning a modified
	// input — mutating it ensures secrets don't leak through that field.
	pi.on("tool_result", (event) => {
		// 1a. Scrub string values in event.input in place (side effect).
		if (event.input && typeof event.input === "object") {
			scrubStringValuesInPlace(event.input, knownSecrets)
		}

		// 1b. Scrub text content blocks (returned via result).
		if (!event.content || !Array.isArray(event.content)) return

		let modified = false
		const scrubbed = event.content.map((block) => {
			if (block.type !== "text") return block
			const original = block.text
			let redacted: string
			try {
				redacted = redact(original, knownSecrets)
			} catch {
				// Best-effort: if redact throws, leave the block unchanged.
				// A crash must never block tool results from reaching the model.
				return block
			}
			if (redacted !== original) {
				modified = true
				return { ...block, text: redacted }
			}
			return block
		})

		if (!modified) return
		return { content: scrubbed }
	})

	// Hook 2: Scrub tool-call args in the cloned message array sent to the LLM.
	// pi-mono passes a structuredClone, so this does NOT affect stored messages
	// or tool execution — only what the model sees on subsequent turns.
	pi.on("context", (event) => {
		let modified = false
		const messages = event.messages.map((msg) => {
			if (msg.role !== "assistant") return msg
			if (!Array.isArray(msg.content)) return msg

			let messageModified = false
			const scrubbedContent = msg.content.map((block) => {
				if (block.type !== "toolCall") return block
				if (!block.arguments) return block
				const scrubbedArgs: Record<string, unknown> = {}
				let argsModified = false
				for (const [key, value] of Object.entries(block.arguments)) {
					if (typeof value === "string") {
						const redacted = redact(value, knownSecrets)
						scrubbedArgs[key] = redacted
						if (redacted !== value) argsModified = true
					} else {
						scrubbedArgs[key] = value
					}
				}
				if (argsModified) {
					messageModified = true
					return { ...block, arguments: scrubbedArgs }
				}
				return block
			})

			if (messageModified) {
				modified = true
				return { ...msg, content: scrubbedContent }
			}
			return msg
		})

		if (!modified) return
		return { messages }
	})

	// Hook 3: Scrub the session file at rest after each turn.
	// Fires after all tools have executed and messages have been persisted.
	pi.on("turn_end", (_event, ctx) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile()
			if (!sessionFile) return
			scrubSessionFile(sessionFile, knownSecrets)
		} catch {
			// Best-effort — a crash must never block the turn
		}
	})
}

/**
 * Recursively scrub string values in an object in place using the redaction engine.
 * Mutates the object directly — used for event.input where the return type
 * doesn't support a modified input field.
 */
function scrubStringValuesInPlace(obj: Record<string, unknown>, knownSecrets: Set<string>): void {
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			obj[key] = redact(value, knownSecrets)
		} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			scrubStringValuesInPlace(value as Record<string, unknown>, knownSecrets)
		}
	}
}
