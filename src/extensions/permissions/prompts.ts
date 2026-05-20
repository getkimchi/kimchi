import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { numberedChoices, stripChoiceNumber } from "./select-utils.js"
import { suggestScope } from "./session-memory.js"
import type { Rule } from "./types.js"

export async function withWorkingHidden<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
	ctx.ui.setWorkingVisible?.(false)
	try {
		return await fn()
	} finally {
		ctx.ui.setWorkingVisible?.(true)
	}
}

export type ApprovalOutcome =
	| { kind: "allow-once" }
	| { kind: "allow-remember"; rule: Rule }
	| { kind: "allow-remember-wildcard"; rule: Rule }
	| { kind: "deny-with-feedback"; feedback: string }
	| { kind: "deny" }
	| { kind: "aborted" }

export interface CompoundSubcommand {
	command: string
	description: string
}

export type CompoundApprovalOutcome =
	| { kind: "allow-all-once" }
	| { kind: "allow-all-remember"; rules: Rule[] }
	| { kind: "pick-per-subcommand" }
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
	const yesWildcard = scope.wildcardContent
		? `Yes — don't ask again for ${scope.wildcardContent} this session`
		: undefined

	// Add wildcard option for bash commands
	const choices = numberedChoices(
		yesWildcard ? [yesOnce, yesRemember, yesWildcard, noWithFeedback] : [yesOnce, yesRemember, noWithFeedback],
	)

	const choice = await withWorkingHidden(ctx, () => ctx.ui.select(lines.join("\n"), choices, { signal: opts.signal }))

	if (choice === undefined && opts.signal?.aborted) return { kind: "aborted" }

	const selected = choice ? stripChoiceNumber(choice) : undefined

	if (selected === yesOnce) return { kind: "allow-once" }

	if (selected === yesRemember) {
		const rule: Rule = {
			toolName: scope.toolName,
			content: scope.content,
			behavior: "allow",
			source: "session",
		}
		return { kind: "allow-remember", rule }
	}

	// Check if wildcard was selected (only applicable for bash)
	if (yesWildcard && selected === yesWildcard) {
		const rule: Rule = {
			toolName: scope.toolName,
			content: `${scope.wildcardContent}`,
			behavior: "allow",
			source: "session",
		}
		return { kind: "allow-remember-wildcard", rule }
	}

	if (selected === noWithFeedback) {
		const feedback = await withWorkingHidden(ctx, () => ctx.ui.input("Tell the assistant what to do differently:"))
		const text = feedback?.trim()
		if (text) return { kind: "deny-with-feedback", feedback: text }
		return { kind: "deny" }
	}

	return { kind: "deny" }
}

/**
 * Prompt the user for compound command approval.
 * Returns the user's choice of how to handle the compound command.
 */
export async function promptForCompoundApproval(opts: {
	toolName: string
	commands: CompoundSubcommand[]
	ctx: ExtensionContext
	subtitle?: string
	signal?: AbortSignal
}): Promise<CompoundApprovalOutcome> {
	const { ctx, commands } = opts
	if (!ctx.hasUI) return { kind: "deny" }

	const descriptions = commands.map((c) => c.description)
	const lines = [
		`The assistant wants to run a compound command with ${commands.length} subcommand(s):`,
		...descriptions,
	]
	if (opts.subtitle) lines.push(opts.subtitle)

	const compoundChoices = [
		"Run all (once)",
		"Allow all from now on",
		"Pick permissions per subcommand",
		"No — tell the assistant what to do differently",
	]
	const choices = numberedChoices(compoundChoices)

	const choice = await withWorkingHidden(ctx, () => ctx.ui.select(lines.join("\n"), choices, { signal: opts.signal }))

	if (choice === undefined && opts.signal?.aborted) return { kind: "aborted" }

	const selected = choice ? stripChoiceNumber(choice) : undefined

	if (selected === compoundChoices[0]) return { kind: "allow-all-once" }
	if (selected === compoundChoices[1]) {
		const rules: Rule[] = commands.map((cmd) => ({
			toolName: opts.toolName,
			content: `${cmd.command.split(" ")[0]} *`,
			behavior: "allow",
			source: "session",
		}))
		return { kind: "allow-all-remember", rules }
	}
	if (selected === compoundChoices[2]) return { kind: "pick-per-subcommand" }
	if (selected === compoundChoices[3]) {
		const feedback = await withWorkingHidden(ctx, () => ctx.ui.input("Tell the assistant what to do differently:"))
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

// Exported for testing
export function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}
