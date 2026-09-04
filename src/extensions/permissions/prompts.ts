import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { ERROR_FG, ORANGE_FG, RST, RST_FG, SUCCESS_FG } from "../../ansi.js"
import { highlightCode } from "../tool-rendering.js"
import { withWorkingHidden } from "../ui.js"
import type { PermissionChoice, ToolPermissionPrompter } from "./prompter.js"
import { numberedChoices, stripChoiceNumber } from "./select-utils.js"
import { suggestScope } from "./session-memory.js"
import type { RiskScore, Rule } from "./types.js"

export { withWorkingHidden }

export type ApprovalOutcome =
	| { kind: "allow-once" }
	| { kind: "allow-remember"; rule: Rule }
	| { kind: "allow-remember-wildcard"; rule: Rule }
	| { kind: "deny-with-feedback"; feedback: string }
	| { kind: "deny" }
	| { kind: "aborted" }

export interface CompoundSubcommand {
	command: string
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
	/** Risk score from the classifier LLM, for display in the prompt. */
	riskScore?: RiskScore
	/** Structured choices to present. Defaults to the standard per-tool choices. */
	choices?: PermissionChoice[]
	/** Signal to programmatically dismiss the prompt (e.g. when permission mode changes). */
	signal?: AbortSignal
}

export function terminalPrompter(ctx: ExtensionContext): ToolPermissionPrompter {
	return {
		request: (req) =>
			promptForApproval({
				toolName: req.toolName,
				input: req.input,
				ctx,
				subtitle: req.subtitle,
				riskScore: req.riskScore,
				choices: req.choices,
				signal: req.signal,
			}),
	}
}

export function buildPermissionChoices(toolName: string, input: Record<string, unknown>): PermissionChoice[] {
	const scope = suggestScope(toolName, input)

	const choices: PermissionChoice[] = [
		{ kind: "allow-once", label: "Yes — just this call" },
		{
			kind: "allow-remember",
			label: `Yes — don't ask again for ${scope.label} this session`,
			rule: {
				toolName: scope.toolName,
				content: scope.content,
				behavior: "allow",
				source: "session",
			},
		},
	]

	if (scope.wildcardContent) {
		choices.push({
			kind: "allow-remember-wildcard",
			label: `Yes — don't ask again for ${scope.wildcardContent} this session`,
			rule: {
				toolName: scope.toolName,
				content: `${scope.wildcardContent}`,
				behavior: "allow",
				source: "session",
			},
		})
	}

	choices.push({ kind: "deny", label: "No — tell the assistant what to do differently" })
	return choices
}

export async function promptForApproval(opts: PromptOptions): Promise<ApprovalOutcome> {
	const { ctx, toolName, input, subtitle, riskScore } = opts
	if (!ctx.hasUI) return { kind: "deny" }

	const callDescription = await describeCallHighlighted(toolName, input)

	const lines: string[] = []
	const termWidth = process.stdout.columns || 80
	const badge = riskScore ? formatRiskBadge(riskScore) : ""
	const wrapWidth = badge ? Math.max(1, termWidth - visibleWidth(badge) - 2) : Math.max(1, termWidth)
	const wrappedCommand = wrapTextWithAnsi(callDescription, wrapWidth).join("\n")
	lines.push(badge ? `${badge} ${wrappedCommand}` : wrappedCommand)
	if (subtitle) lines.push(subtitle)
	lines.push("")
	lines.push(ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Allow the assistant to run this?")))

	const permissionChoices = opts.choices ?? buildPermissionChoices(toolName, input)
	const choices = numberedChoices(permissionChoices.map((choice) => choice.label))

	const choice = await withWorkingHidden(ctx, () => ctx.ui.select(lines.join("\n"), choices, { signal: opts.signal }))

	if (choice === undefined && opts.signal?.aborted) return { kind: "aborted" }

	const selected = choice ? stripChoiceNumber(choice) : undefined
	const selectedChoice = permissionChoices.find((candidate) => candidate.label === selected)

	if (selectedChoice?.kind === "allow-once") return { kind: "allow-once" }

	if (selectedChoice?.kind === "allow-remember") {
		return { kind: "allow-remember", rule: selectedChoice.rule }
	}

	if (selectedChoice?.kind === "allow-remember-wildcard") {
		return { kind: "allow-remember-wildcard", rule: selectedChoice.rule }
	}

	if (selectedChoice?.kind === "deny") {
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

	const termWidth = process.stdout.columns || 80
	const descriptions = await Promise.all(
		commands.map(async (cmd) => {
			const highlighted = await describeCallHighlighted(opts.toolName, { command: cmd.command })
			return wrapTextWithAnsi(highlighted, Math.max(1, termWidth)).join("\n")
		}),
	)
	const lines = [
		`The assistant wants to run a compound command with ${commands.length} subcommand(s):`,
		...descriptions,
	]
	if (opts.subtitle) lines.push(opts.subtitle)
	lines.push("")
	lines.push(ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Allow the assistant to run this?")))

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
		const rules = commands.flatMap<Rule>((cmd) => {
			const scope = suggestScope(opts.toolName, { command: cmd.command })
			const content = scope.wildcardContent
			return content ? [{ toolName: scope.toolName, content, behavior: "allow", source: "session" }] : []
		})
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

/** Describe a tool call as a single-line string (no highlighting). */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
	const lower = toolName.toLowerCase()
	if (lower === "bash" && typeof input.command === "string") {
		return `bash(${input.command})`
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

/** Like describeCall, but applies shiki syntax highlighting when the tool/language is supported. */
export async function describeCallHighlighted(toolName: string, input: Record<string, unknown>): Promise<string> {
	const lower = toolName.toLowerCase()
	if (lower === "bash" && typeof input.command === "string") {
		const highlighted = await highlightCode(input.command, "bash")
		return `${RST}bash(${highlighted}${RST})`
	}
	return describeCall(toolName, input)
}

// Exported for testing
export function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}

/** Format the risk badge: colored symbol + label, e.g. "● high risk". */
export function formatRiskBadge(score: RiskScore): string {
	const color = score === "low" ? SUCCESS_FG : score === "medium" ? ORANGE_FG : ERROR_FG
	return `${color}\u25CF ${score} risk${RST_FG}`
}
