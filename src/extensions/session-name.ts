/**
 * Session Name Extension
 *
 * Manages session naming via:
 * - CLI flag: --name <value>
 * - Slash command: /rename <name>
 * - Auto-naming: automatically names session from first message after first turn
 *
 * Updates terminal title dynamically and exposes the name for footer display.
 */

import { basename } from "node:path"
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../config.js"
import { getSessionName, setSessionName as setStartupSessionName } from "../startup-context.js"

// No process-level mutable state — all state lives inside the factory closure
// to keep the extension reentrant per the ExtensionAPI contract.

// System prompt for session name generation - keep it simple; cheap models choke
// on negative constraints, formatting demands, and multi-step instructions.
const SESSION_NAME_SYSTEM_PROMPT =
	"You are a title generator. Respond with ONLY a short title. 1-5 words, no quotes, no explanation, no markdown."

/** Max chars to feed from the user message so we don't bloat the prompt. */
const HINT_MAX_LEN = 500

function capHint(hint: string): string {
	if (hint.length <= HINT_MAX_LEN) return hint
	return `${hint.slice(0, HINT_MAX_LEN).trimEnd()}...`
}

/**
 * Extract the earliest user messages from the session.
 * We search from the START (oldest) because the first message typically
 * describes the actual task — later messages are just follow-ups,
 * confirmations, or corrections ("yeah", "apply it", etc.).
 */
export function extractFirstUserMessage(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch()
	const fromBranch = extractEarlyUserText(branch)
	if (fromBranch) return fromBranch

	const entries = ctx.sessionManager.getEntries()
	return extractEarlyUserText(entries)
}

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>

/**
 * Iterate forward and collect text from the first few user messages.
 * Bundles up to 3 messages for richer context, capped in total length.
 */
function extractEarlyUserText(entries: SessionEntries): string | null {
	const texts: string[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const msg = entry.message
		if (msg.role !== "user") continue
		if (!("content" in msg)) continue

		let text: string | null = null
		if (typeof msg.content === "string") {
			text = msg.content.trim()
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (
					typeof part === "object" &&
					part !== null &&
					"type" in part &&
					(part as { type: string }).type === "text" &&
					"text" in (part as { text?: string })
				) {
					text = (part as { text: string }).text.trim()
					break
				}
			}
		}

		if (text && text.length > 0) {
			texts.push(text)
			if (texts.length >= 3) break
		}
	}

	if (texts.length === 0) return null
	return texts.join("\n---\n")
}

/**
 * Deterministic fallback: truncate name at 35 chars at last space.
 */
export function deterministicFallback(input: string): string {
	const max = 35
	if (input.length <= max) return input.trim()
	const truncated = input.slice(0, max)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

/**
 * Suggest a session name using the cheap Cast AI LLM.
 * Falls back to deterministic truncation on any error, with diagnostics.
 * When quiet is true, suppresses all user-facing error output (for background auto-naming).
 */
export async function suggestSessionName(ctx: ExtensionContext, hint?: string, quiet = false): Promise<string> {
	const base = basename(ctx.cwd)
	const resolvedHint = hint ?? extractFirstUserMessage(ctx)

	// If there's no user message to work with, skip the LLM entirely.
	if (!resolvedHint) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: no user message found in this session yet.", "error")
			} else {
				console.error("[kimchi] auto-naming failed: no user message found")
			}
		}
		return deterministicFallback(base)
	}

	const config = loadConfig()
	const apiKey = config.apiKey || process.env.KIMCHI_API_KEY || ""

	if (!apiKey) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: no API key configured.", "error")
			} else {
				console.error("[kimchi] auto-naming failed: no API key")
			}
		}
		return deterministicFallback(base)
	}

	try {
		const payload = {
			model: "nemotron-3-super-fp4",
			messages: [
				{ role: "system", content: SESSION_NAME_SYSTEM_PROMPT },
				// Frame the message exactly like shortenTitle does - cheap models need
				// an explicit task, not raw text.
				{ role: "user", content: `Short title for this conversation:\n\n${capHint(resolvedHint)}` },
			],
			// Cheap think-models spend tokens on reasoning before outputting.
			// Give enough room for both reasoning and the final title.
			max_tokens: 100,
			temperature: 0,
			reasoning_effort: "none",
		}
		const body = JSON.stringify(payload)

		const response = await fetch(`${config.llmEndpoint}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body,
		})

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "")
			if (!quiet) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Auto-naming: API error ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ""}`,
						"error",
					)
				} else {
					console.error(`[kimchi] auto-naming API error: ${response.status} ${response.statusText} ${errorBody}`)
				}
			}
			return deterministicFallback(base)
		}

		const data = (await response.json()) as unknown

		const cast = data as {
			choices?: Array<{ message?: { content?: string } }>
		}
		const suggestion = cast.choices?.[0]?.message?.content?.trim() ?? ""
		if (suggestion.length > 0) {
			return suggestion
		}
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-naming: LLM returned empty suggestion.", "error")
			} else {
				console.error("[kimchi] auto-naming: LLM returned empty suggestion")
			}
		}
		return deterministicFallback(base)
	} catch (err) {
		if (!quiet) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Auto-naming: ${err instanceof Error ? err.message : String(err)}`, "error")
			} else {
				console.error(`[kimchi] auto-naming exception: ${err}`)
			}
		}
		return deterministicFallback(base)
	}
}

/**
 * Strip ASCII control characters from a string to prevent terminal injection.
 * Removes \x00–\x1f and \x7f, preserving common whitespace (space, tab, newline).
 */
function sanitizeSessionName(name: string): string {
	return [...name]
		.filter((c) => {
			const cp = c.charCodeAt(0)
			return cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp !== 0x7f)
		})
		.join("")
		.trim()
}

/**
 * Update the terminal title with OSC sequence and process.title.
 * Format: "kimchi \u00b7 {name} \u00b7 {basename(cwd)}"
 * Only runs when UI is available.
 */
export function updateTerminalTitle(ctx: ExtensionContext, name: string): void {
	if (!ctx.hasUI || !name) return

	const cwdBasename = basename(ctx.cwd)
	const safeName = sanitizeSessionName(name)
	const title = `kimchi \u00b7 ${safeName} \u00b7 ${cwdBasename}`

	// OSC 0 sequence to set window/tab title
	process.stdout.write(`\x1b]0;${title}\x07`)
	// Also set process.title for ps/htop etc.
	process.title = title
}

/**
 * Set the session name and update terminal title.
 * Note: pi.setSessionName is available on ExtensionAPI, not ExtensionContext.
 */
function setAndUpdateSessionName(
	name: string,
	currentNameRef: { value: string | undefined },
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void {
	const safeName = sanitizeSessionName(name)
	currentNameRef.value = safeName
	setStartupSessionName(safeName)
	pi.setSessionName(safeName)
	updateTerminalTitle(ctx, safeName)
}

/**
 * Create the session name extension factory.
 * @param initialName - Optional initial session name from CLI --name flag
 */
export default function sessionNameExtension(initialName?: string) {
	return (pi: ExtensionAPI) => {
		// Per-instance mutable state — each factory invocation gets its own
		// variables so the extension is reentrant and test-safe.
		let currentSessionName: string | undefined = undefined
		let hasAutoNamed = false

		// On session_start: reset the auto-naming tracker so background auto-naming
		// can run for new sessions. If initial name was provided at startup, apply it.
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			hasAutoNamed = false
			if (initialName) {
				setAndUpdateSessionName(initialName, { value: currentSessionName }, pi, ctx)
			} else {
				const existingName = ctx.sessionManager.getSessionName()
				if (existingName) {
					currentSessionName = existingName
					updateTerminalTitle(ctx, existingName)
				}
			}
		})

		// Auto-name sessions after the first turn when no name was set.
		pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
			if (hasAutoNamed) return
			if (ctx.sessionManager.getSessionName()) {
				hasAutoNamed = true
				return
			}
			const hint = extractFirstUserMessage(ctx)
			if (!hint) {
				hasAutoNamed = true
				return
			}
			hasAutoNamed = true
			suggestSessionName(ctx, hint, true)
				.then((suggestion) => {
					if (suggestion && !ctx.sessionManager.getSessionName()) {
						setAndUpdateSessionName(suggestion, { value: currentSessionName }, pi, ctx)
					}
				})
				.catch(() => {
					// Silently ignore background auto-naming failures
				})
		})

		// Register the /rename command
		pi.registerCommand("rename", {
			description:
				"Rename the current session. If called without arguments, suggests a name based on your task and prompts for confirmation.",
			getArgumentCompletions: (prefix) => {
				// No autocomplete when empty - we use auto-suggestion flow instead
				if (!prefix) {
					return []
				}
				// Offer the current name as completion base
				const current = currentSessionName || ""
				if (current) {
					return [{ value: current, label: current, description: "Current session name" }]
				}
				return []
			},
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				let name = args.trim()

				if (!name) {
					// Auto-suggest mode
					if (!ctx.hasUI) {
						ctx.ui.notify("Session rename with auto-suggestion requires interactive mode.", "error")
						return
					}
					const suggestion = await suggestSessionName(ctx as ExtensionContext)
					const accepted = await ctx.ui.confirm("Rename Session", `Suggested name: "${suggestion}"\n\nUse this name?`)
					if (!accepted) {
						ctx.ui.notify("Rename cancelled", "info")
						return
					}
					name = suggestion
				}

				// Validate the name (from existing validation logic)
				if (!name) {
					if (ctx.hasUI) {
						ctx.ui.notify("Usage: /rename <name>\nProvide a non-empty session name.", "error")
					} else {
						console.error("Usage: /rename <name>")
					}
					return
				}

				// Set the new name using the closure pi reference
				setAndUpdateSessionName(name, { value: currentSessionName }, pi, ctx as ExtensionContext)

				// Notify user
				if (ctx.hasUI) {
					ctx.ui.notify(`Session renamed to: ${name}`, "info")
				} else {
					console.log(`Session renamed to: ${name}`)
				}
			},
		})

		// Register a tool to get the current session name (for other extensions)
		pi.registerTool({
			name: "get_session_name",
			label: "Get Session Name",
			description: "Get the current session name",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
			async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
				return {
					content: [{ type: "text", text: currentSessionName || "(no session name)" }],
					details: { name: currentSessionName },
				}
			},
		})
	}
}
