import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { ERROR_FG, ORANGE_FG, RST, RST_FG, SUCCESS_FG } from "../../ansi.js"
import { highlightCode } from "../tool-rendering.js"
import { withWorkingHidden } from "../ui.js"
import type { PermissionChoice, ToolPermissionPrompter } from "./prompter.js"
import { numberedChoices, stripChoiceNumber } from "./select-utils.js"
import { bashSegmentScope, suggestBashCommandScopes, suggestScope } from "./session-memory.js"
import { isCompoundCommand, isReadOnlyBashCommand } from "./taxonomy.js"
import type { RiskScore, Rule } from "./types.js"

export { withWorkingHidden }

export type ApprovalOutcome =
	| { kind: "allow-once" }
	| { kind: "allow-remember"; rules: Rule[] }
	| { kind: "allow-remember-wildcard"; rules: Rule[] }
	| { kind: "deny-with-feedback"; feedback: string }
	| { kind: "deny" }
	| { kind: "aborted" }

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
	const lower = toolName.toLowerCase()
	if (lower === "bash") {
		const command = typeof input.command === "string" ? input.command : ""
		if (isCompoundCommand(command)) return buildCompoundBashChoices(command)
		// Single-command bash still can't be remembered when its scope can
		// never match again (pipe to a non-filter program like `cat x | sh`):
		// omit remember choices rather than storing a silently-dead rule.
		const scope = isReadOnlyBashCommand(command) ? null : bashSegmentScope(command)
		if (!scope)
			return [
				{ kind: "allow-once", label: "Yes — just this call" },
				{ kind: "deny", label: "No — tell the assistant what to do differently" },
			]
		return buildChoicesForScope(scope)
	}

	return buildChoicesForScope(suggestScope(toolName, input))
}

function buildChoicesForScope(scope: {
	toolName: string
	content?: string
	wildcardContent?: string
	label: string
}): PermissionChoice[] {
	const choices: PermissionChoice[] = [
		{ kind: "allow-once", label: "Yes — just this call" },
		{
			kind: "allow-remember",
			label: `Yes — don't ask again for ${scope.label} this session`,
			rules: [
				{
					toolName: scope.toolName,
					content: scope.content,
					behavior: "allow",
					source: "session",
				},
			],
		},
	]

	if (scope.wildcardContent) {
		choices.push({
			kind: "allow-remember-wildcard",
			label: `Yes — don't ask again for ${scope.wildcardContent} this session`,
			rules: [
				{
					toolName: scope.toolName,
					content: `${scope.wildcardContent}`,
					behavior: "allow",
					source: "session",
				},
			],
		})
	}

	choices.push({ kind: "deny", label: "No — tell the assistant what to do differently" })
	return choices
}

// Compound bash commands are remembered PER SEGMENT: the compound gate
// (checkCompoundCommand) re-evaluates each segment against rules individually,
// so a single scope derived from the whole command (first segment only —
// e.g. `cd /tmp:*` for `cd /tmp && npm install`) could never match the
// compound again and re-prompts forever. Compounds containing a segment whose
// scope can never match again (`| sh`, `| awk`, substitution — piped
// whitelisted output filters like `| tail -20` DO scope, normalizing to the
// head) get no "don't ask again" choice: we never promise remembering we
// cannot honor.
function buildCompoundBashChoices(command: string): PermissionChoice[] {
	const { scopes, scopeable } = suggestBashCommandScopes(command)
	const choices: PermissionChoice[] = [{ kind: "allow-once", label: "Yes — just this call" }]

	if (scopeable && scopes.length > 0) {
		choices.push({
			kind: "allow-remember",
			label: `Yes — don't ask again for ${joinScopeLabels(scopes.map((s) => s.label))} this session`,
			rules: scopes.map((s) => ({
				toolName: s.toolName,
				content: s.content,
				behavior: "allow" as const,
				source: "session" as const,
			})),
		})

		const wildcards: string[] = []
		for (const s of scopes) {
			if (!s.wildcardContent) break
			wildcards.push(s.wildcardContent)
		}
		if (wildcards.length === scopes.length) {
			choices.push({
				kind: "allow-remember-wildcard",
				label: `Yes — don't ask again for ${joinScopeLabels(wildcards)} this session`,
				rules: wildcards.map((content) => ({
					toolName: "bash",
					content,
					behavior: "allow" as const,
					source: "session" as const,
				})),
			})
		}
	}

	choices.push({ kind: "deny", label: "No — tell the assistant what to do differently" })
	return choices
}

// Disclose every remembered scope in the choice label; cap at 3 to keep the
// prompt readable on long compounds (ACP clients render labels verbatim).
function joinScopeLabels(labels: string[]): string {
	const MAX_DISCLOSED = 3
	if (labels.length <= MAX_DISCLOSED) return labels.join(" + ")
	return `${labels.slice(0, MAX_DISCLOSED).join(" + ")} + ${labels.length - MAX_DISCLOSED} more`
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
		return { kind: "allow-remember", rules: selectedChoice.rules }
	}

	if (selectedChoice?.kind === "allow-remember-wildcard") {
		return { kind: "allow-remember-wildcard", rules: selectedChoice.rules }
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
	command: string
	ctx: ExtensionContext
	subtitle?: string
	signal?: AbortSignal
}): Promise<CompoundApprovalOutcome> {
	const { ctx } = opts
	if (!ctx.hasUI) return { kind: "deny" }

	const termWidth = process.stdout.columns || 80
	const { scopes, scopeable } = suggestBashCommandScopes(opts.command)
	const highlighted = await describeCallHighlighted(opts.toolName, { command: opts.command })
	const lines = [
		"The assistant wants to run this compound command:",
		wrapTextWithAnsi(highlighted, Math.max(1, termWidth)).join("\n"),
	]
	if (!scopeable) lines.push("This script needs approval each time; its permissions cannot be remembered safely.")
	if (opts.subtitle) lines.push(opts.subtitle)
	lines.push("")
	lines.push(ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Allow the assistant to run this?")))

	const compoundChoices = [
		"Run all (once)",
		...(scopeable && scopes.length > 0 ? ["Allow all for this session"] : []),
		...(scopeable ? ["Pick permissions per subcommand"] : []),
		"No — tell the assistant what to do differently",
	]
	const choices = numberedChoices(compoundChoices)

	const choice = await withWorkingHidden(ctx, () => ctx.ui.select(lines.join("\n"), choices, { signal: opts.signal }))

	if (choice === undefined && opts.signal?.aborted) return { kind: "aborted" }

	const selected = choice ? stripChoiceNumber(choice) : undefined

	if (selected === "Run all (once)") return { kind: "allow-all-once" }
	if (selected === "Allow all for this session" && scopeable && scopes.length > 0) {
		return {
			kind: "allow-all-remember",
			rules: scopes.map((scope) => ({
				toolName: scope.toolName,
				content: scope.content,
				behavior: "allow",
				source: "session",
			})),
		}
	}
	if (selected === "Pick permissions per subcommand" && scopeable) return { kind: "pick-per-subcommand" }
	if (selected === "No — tell the assistant what to do differently") {
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
