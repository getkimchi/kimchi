import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { suggestScope } from "./session-memory.js"
import type { Rule } from "./types.js"

export type ApprovalOutcome =
	| { kind: "allow-once" }
	| { kind: "allow-remember"; rule: Rule }
	| { kind: "deny-with-feedback"; feedback: string }
	| { kind: "deny" }
	| { kind: "aborted" }

interface PromptOptions {
	toolName: string
	input: Record<string, unknown>
	ctx: ExtensionContext
	/** Extra context line shown above the choices (e.g. classifier reason). */
	subtitle?: string
	/** Signal to programmatically dismiss the prompt (e.g. when permission mode changes). */
	signal?: AbortSignal
}

export async function promptForApproval(opts: PromptOptions): Promise<ApprovalOutcome> {
	const { ctx, toolName, input, subtitle } = opts
	if (!ctx.hasUI) return { kind: "deny" }

	const scope = suggestScope(toolName, input)
	const callDescription = describeCall(toolName, input)

	const lines = [`The assistant wants to run: ${callDescription}`]
	if (subtitle) lines.push(subtitle)

	const yesOnce = "Yes — just this call"
	const yesRemember = `Yes — don't ask again for ${scope.label} this session`
	const noWithFeedback = "No — tell the assistant what to do differently"

	const choice = await ctx.ui.select(lines.join("\n"), [yesOnce, yesRemember, noWithFeedback], {
		signal: opts.signal,
	})

	if (choice === undefined && opts.signal?.aborted) return { kind: "aborted" }

	if (choice === yesOnce) return { kind: "allow-once" }

	if (choice === yesRemember) {
		const rule: Rule = {
			toolName: scope.toolName,
			content: scope.content,
			behavior: "allow",
			source: "session",
		}
		return { kind: "allow-remember", rule }
	}

	if (choice === noWithFeedback) {
		const feedback = await ctx.ui.input("Tell the assistant what to do differently:")
		const text = feedback?.trim()
		if (text) return { kind: "deny-with-feedback", feedback: text }
		return { kind: "deny" }
	}

	return { kind: "deny" }
}

function describeCall(toolName: string, input: Record<string, unknown>): string {
	const lower = toolName.toLowerCase()
	if (lower === "bash" && typeof input.command === "string") {
		return `bash(${truncate(input.command, 200)})`
	}
	if (typeof input.path === "string") {
		return `${lower}(${truncate(input.path, 200)})`
	}
	try {
		const preview = truncate(JSON.stringify(input), 120)
		return `${lower}(${preview})`
	} catch {
		return lower
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}
