/**
 * Bash-tool guard
 *
 * Steers the LLM away from using `bash` for tasks that have a dedicated
 * non-shell tool (`read`, `edit`, `write`). The replacement tools are
 * cheaper (less output to land in context) and trigger LSP-aware tooling
 * (hover/definition) when reading or editing code.
 *
 * Two layers of nudging:
 *
 *   1. **Preference (upstream).** A "Tool Preferences" block in the
 *      system prompt (rendered right before "## Available Tools") plus an
 *      override of the bash tool's description. The upstream snippet
 *      "Execute bash commands (ls, grep, find, etc.)" tells the model
 *      bash can do those things — exactly the substitution we steer
 *      against. The override fixes the snippet, and the block makes
 *      the substitution rules explicit. Goal: the model picks the
 *      dedicated tool the first time, not after being told.
 *
 *   2. **Guard (downstream).** Inspects each bash call. If the command
 *      is a file-reading / in-place-edit / file-writing pattern that
 *      has a dedicated tool, emits a steer message pointing at the
 *      dedicated tool. Hard-blocking is opt-in via
 *      `blockOnThreshold: true`.
 *
 * Three categories are detected:
 *   - read  — `cat <file>`, `head <file>`, `tail <file>`, `less <file>`,
 *             `bat <file>`, `sed -n '<range>p' <file>` (read-only sed).
 *   - edit  — `sed -i ... <file>`, `perl -i -pe ... <file>`,
 *             `awk -i inplace ... <file>` (in-place mutation).
 *   - write — `>` / `>>` redirect to a regular file, `tee <file>`, heredoc
 *             redirect (`<<EOF > file`), `printf ... > file`,
 *             `echo ... > file`.
 *
 * Behaviour:
 *   - First match for a category within a session: steer (don't block).
 *   - Second match for the same category: hard-block with a reason pointing
 *     at the right tool — but only when `blockOnThreshold: true` is passed
 *     to the extension. The default is warn-only so adopting the guard
 *     never stalls a session if the replacement tool is unavailable.
 *   - Per-category counters: a `cat` doesn't burn the budget for `sed -i`.
 *   - Per-category thresholds: read/edit/write can have different budgets.
 *   - Reset on `session_start` and on each user `input` event so a fresh
 *     turn starts with a clean slate.
 *   - Disabled in plan-mode permission context (inspection, not
 *     enforcement — same rationale as `exploration-guard`).
 *   - Explicit user request override: detects both tool names ("cat",
 *     "sed") and semantic intents ("read the file", "fix with sed",
 *     "write a marker"). Uses word-boundary matching to avoid false
 *     positives (e.g. "cat" inside "categorize").
 *   - Emits domain events via pi.events for telemetry to observe.
 *   - `grep` / `rg` / `ag` and `find` are intentionally NOT guarded: they
 *     have legitimate uses outside code-search and the false-positive cost
 *     outweighs the savings.
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../resources/store.js"
import {
	BASH_TOOL_GUARD_EVENTS,
	type BashToolGuardAllowedByUserRequestPayload,
	type BashToolGuardBlockPayload,
	type BashToolGuardWarnPayload,
} from "./bash-tool-guard-events.js"
import { getPermissionMode } from "./permissions/mode-controller.js"
import { parseCommandSegments } from "./permissions/taxonomy.js"
import { createSystemPromptBlocks } from "./prompt-construction/system-prompt-blocks.js"

const RESOURCE_ID = "extensions.bash-tool-guard"

export const STEER_MESSAGE_TYPE = "bash-tool-guard-steer"

export type BashCategory = "read" | "edit" | "write"

export interface BashClassification {
	category: BashCategory
	suggestion: string
	/** A short, human-readable rendering of the matched segment (for steer text). */
	matchedSegment: string
	/** The tool name detected (first token after stripping rtk wrapper). */
	tool: string
}

export interface PerCategoryThresholds {
	read?: number
	edit?: number
	write?: number
}

export interface BashGuardOptions {
	/** Number of warnings per category before hard-blocking. Default: 1.
	 *  Overridden by per-category values when set. */
	warnThreshold?: number
	/** Per-category overrides for the warn threshold. */
	warnThresholds?: PerCategoryThresholds
	/** Predicate to temporarily disable the guard (e.g., during plan mode). */
	isEnabled?: () => boolean
	/** When true, the guard hard-blocks bash calls once the per-category
	 *  warn threshold is exceeded. Default: false (warn/steer only).
	 *  Hard blocking is opt-in so users can adopt the guard without
	 *  risking session stalls if the replacement tool is unavailable
	 *  or misconfigured in a given environment. */
	blockOnThreshold?: boolean
}

export interface BashGuardResult {
	decision: "allow"
	/** When the allow was due to an explicit user request, this is set. */
	reason?: "user-request"
}

export interface BashGuardWarnResult {
	decision: "warn"
	category: BashCategory
	suggestion: string
	matchedSegment: string
	tool: string
	count: number
}

export interface BashGuardBlockResult {
	decision: "block"
	category: BashCategory
	suggestion: string
	matchedSegment: string
	tool: string
	count: number
}

export type BashGuardDecision = BashGuardResult | BashGuardWarnResult | BashGuardBlockResult

const WARN_STEER_BASE =
	"Bash-tool guard: this command reads/updates files via a shell command (%matchedSegment%, category: %category%). " +
	"The dedicated tool is faster and unlocks LSP context (hover/definition/diagnostics): %suggestion% " +
	"Hard blocking is opt-in; pass `blockOnThreshold: true` to enable."

const BLOCK_REASON_BASE =
	"Bash-tool guard: blocked %category% via shell after a warning in this session. " +
	"%suggestion% " +
	"To override, disable the bash-tool-guard extension in resource settings."

const READ_SUGGESTION = "Use the read tool with the file path (and offset/limit for head/tail)."
const EDIT_SUGGESTION = "Use the edit tool with old_string/new_string."
const WRITE_SUGGESTION = "Use the edit tool for targeted changes or the write tool for full-file replacements."

/**
 * Markdown block injected into the system prompt immediately before the
 * "## Available Tools" section. Uses inline-code backticks so the model
 * can easily match the substitutions. Lists what bash IS for so the
 * model doesn't think bash is now useless — it just shouldn't be used
 * for the operations with dedicated tools.
 */
export const TOOL_PREFERENCES_BLOCK = `
## Tool Preferences

Prefer dedicated tools over bash when possible:

- Reading a file → use \`read\` (not \`cat\`, \`head\`, \`tail\`, \`sed -n\`)
- Editing a file → use \`edit\` (not \`sed -i\`, \`perl -i\`)
- Writing a file → use \`write\` (not \`>\`, \`>>\`, \`tee\`, heredoc)
- Searching file contents → use \`grep\` (respects .gitignore, faster)
- Finding files by pattern → use \`find\` (respects .gitignore)
- Listing a directory → use \`ls\`

Use bash only for: build commands, test runners, git, package managers, shell scripting, or system administration.
`.trim()

/**
 * Replacement description for the bash tool. Keeps the original output
 * truncation behaviour from upstream but explicitly excludes the
 * file-operation substitutions and lists what bash IS for. Mutated
 * onto the upstream tool object on `session_start` so the kimchi prompt
 * builder picks up the new description when it renders the tool list.
 */
export const BASH_TOOL_DESCRIPTION = `
Execute a bash command for operations without a dedicated tool: build commands, test runners, git, package managers, system administration, shell scripting.

DO NOT use bash for: reading files (use \`read\`), editing files (use \`edit\`), writing files (use \`write\`), searching file contents (use \`grep\`), finding files by pattern (use \`find\`), or listing directories (use \`ls\`) — dedicated tools are faster and unlock LSP context.

Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.
`.trim()

/**
 * Pure helper: returns a description override for the given tool name, or
 * `undefined` when no override applies. Kept as a pure function so tests
 * can exercise it without a mock `pi` and so the override rules are
 * visible at a glance.
 */
export function toolDescriptionOverride(name: string): string | undefined {
	if (name !== "bash") return undefined
	return BASH_TOOL_DESCRIPTION
}

/**
 * Pure helper: applies the description override to a tool definition,
 * returning a new tool definition. Always returns a new object (never
 * the input) so callers can rely on immutability. Tools with no override
 * get a shallow copy with the same description.
 */
export function applyDescriptionOverride<T extends { name: string; description: string }>(tool: T): T {
	const override = toolDescriptionOverride(tool.name)
	return { ...tool, description: override ?? tool.description }
}

/**
 * Pure classification of a bash command. Returns null when the command is
 * not one of the guarded anti-patterns. Used by both the guard class and
 * the unit tests.
 *
 * Shell parsing is delegated to `parseCommandSegments` from the permissions
 * taxonomy so the parser stays in one place. Detection is best-effort:
 * exotic shell syntax (process substitution, eval'd strings, complex
 * nested subshells) may slip through; we treat the steer-first design as
 * the safety net.
 */
export function classifyBashCommand(command: string): BashClassification | null {
	const segments = parseCommandSegments(command)

	for (const segment of segments) {
		// Drop the leading tool name and any RTK wrapper to inspect args.
		const tokens = stripRtk(segment.tokens)
		const tool = tokens[0]
		if (!tool) continue

		const matchedSegment = tokens.join(" ")

		// Category 1: write — `> file` / `>> file` redirect to a non-stream
		// target, OR `tee <file>`. We treat any non-stream `>` / `>>` op in
		// any segment as a write signal because the redirect target is the
		// file the model wants to produce.
		for (const op of segment.ops) {
			if ((op.op === ">" || op.op === ">>") && op.target && !isStreamRedirectTarget(op.target)) {
				return { category: "write", suggestion: WRITE_SUGGESTION, matchedSegment, tool }
			}
		}
		if (tool === "tee" && tokens.length >= 2) {
			return { category: "write", suggestion: WRITE_SUGGESTION, matchedSegment, tool }
		}

		// Category 2: edit — in-place mutation flags.
		if (isInPlaceEditTool(tool, tokens)) {
			return { category: "edit", suggestion: EDIT_SUGGESTION, matchedSegment, tool }
		}

		// Category 3: read — tools whose only purpose is to print a file's
		// contents, plus `sed -n` read mode. Each requires at least one
		// positional file argument; bare `cat` / `head` reading stdin is
		// harmless and not flagged.
		if (isFileReader(tool, tokens)) {
			return { category: "read", suggestion: READ_SUGGESTION, matchedSegment, tool }
		}
	}

	return null
}

const STREAM_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])

function isStreamRedirectTarget(target: string): boolean {
	return STREAM_REDIRECT_TARGETS.has(target)
}

/**
 * `sed -i`, `sed -i<suffix>`, `perl -i`, `perl -i<suffix>`, and
 * `awk -i inplace`. These mutate the file in place; the LLM should use
 * `edit` instead so the diff is reviewable and reversible.
 */
function isInPlaceEditTool(tool: string, tokens: string[]): boolean {
	if (tool === "sed") {
		return tokens.slice(1).some((t) => t === "-i" || t.startsWith("-i"))
	}
	if (tool === "perl") {
		return tokens.slice(1).some((t) => t === "-i" || t.startsWith("-i"))
	}
	if (tool === "awk") {
		// awk uses `-i file` (separate arg), not a fused flag.
		for (let i = 1; i < tokens.length - 1; i++) {
			if (tokens[i] === "-i" && tokens[i + 1] === "inplace") return true
		}
	}
	return false
}

const READER_TOOLS = new Set(["cat", "head", "tail", "less", "more", "bat", "batcat"])

function isFileReader(tool: string, tokens: string[]): boolean {
	if (!READER_TOOLS.has(tool)) {
		// `sed -n '<range>p' <files...>` is read-only sed usage.
		if (tool === "sed") {
			const args = tokens.slice(1)
			const hasQuiet = args.includes("-n") || args.includes("--quiet") || args.includes("--silent")
			// Heuristic: read mode usually has `-n` together with a `p` print
			// command. Without `-n` and `p` it's an editing sed that we
			// don't catch here (and which the edit category catches via -i).
			if (!hasQuiet) return false
			const printCmd = args.find((a) => /p\b/.test(a) && !/^[-]/.test(a))
			if (!printCmd) return false
		} else {
			return false
		}
	}
	// Every guarded reader takes a file path. Bare `cat` / `head` reading
	// stdin has no positional file arg and is harmless — don't flag it.
	const positional = tokens.slice(1).filter((t) => !t.startsWith("-"))
	return positional.length > 0
}

function stripRtk(tokens: string[]): string[] {
	return tokens[0] === "rtk" ? tokens.slice(1) : tokens
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Semantic intent phrases that imply an explicit user request for a given
 * category. Each entry maps a category to a list of regex patterns matched
 * against the (lowercased) user prompt.
 *
 * Why regex instead of plain word lists: natural-language prompts use
 * varied phrasings ("read the file", "show me what's in foo.ts", "print
 * the contents of foo.ts"). Word lists catch only the literal form;
 * regexes cover the common variants while staying readable.
 *
 * Each pattern must be a complete regex (anchored with \b where needed).
 * Test new patterns in `bash-tool-guard.test.ts` before adding.
 */
const SEMANTIC_INTENT_PATTERNS: Record<BashCategory, RegExp[]> = {
	read: [
		// "read the file", "read foo.ts", "read the contents of foo.ts"
		/\bread\b.*\b(file|contents?|source|code)\b/,
		// "show me foo.ts", "show what's in foo.ts"
		/\bshow\b.*\b(me|what'?s? in|contents? of)\b/,
		// "print the contents of foo.ts"
		/\bprint\b.*\b(contents?|file|source)\b/,
		// "view foo.ts", "view the file"
		/\bview\b.*\b(file|contents?|source)\b/,
		// "open foo.ts" / "open the file" — agents often say this
		/\bopen\b.*\b(file|\.[a-z]{1,4})\b/,
	],
	edit: [
		// "fix the typo", "fix this with sed", "fix the file"
		/\bfix\b.*\b(typo|bug|error|file|this|line)\b/,
		// "replace foo with bar", "replace text in foo.ts"
		/\breplace\b.*\b(with|in|inside)\b/,
		// "modify foo.ts", "modify the file"
		/\bmodify\b.*\b(file|\.[a-z]{1,4})\b/,
		// "update foo.ts", "update the file"
		/\bupdate\b.*\b(file|\.[a-z]{1,4})\b/,
		// "use sed/awk/perl to ..."
		/\buse\b.*\b(sed|awk|perl)\b/,
		// "edit foo.ts"
		/\bedit\b.*\b(file|\.[a-z]{1,4})\b/,
	],
	write: [
		// "write a file", "write to foo.ts", "write the contents to foo.ts"
		/\bwrite\b.*\b(to|file|contents? to)\b/,
		// "create a file", "create foo.ts"
		/\bcreate\b.*\b(file|\.[a-z]{1,4})\b/,
		// "save to foo.ts", "save the output to foo.ts"
		/\bsave\b.*\b(to|into)\b/,
		// "put it in foo.ts", "put the result in foo.ts"
		/\bput\b.*\b(in|into|to)\b/,
		// "echo ... to file"
		/\becho\b.*\bto\b/,
		// "redirect to foo.ts", "redirect output to foo.ts"
		/\bredirect\b.*\bto\b/,
	],
}

export class BashToolGuard {
	private readonly warnThresholds: Record<BashCategory, number>
	private readonly isEnabled: () => boolean
	private readonly blockOnThreshold: boolean
	private readonly categoryCounts: Map<BashCategory, number> = new Map()
	/** Most recent user prompt text, lowercased. Used to detect explicit
	 *  requests like "use sed" or "cat this file" so the guard doesn't
	 *  override an explicit user instruction. */
	private lastUserPrompt = ""

	constructor(options: BashGuardOptions = {}) {
		const defaultThreshold = options.warnThreshold ?? 1
		this.warnThresholds = {
			read: options.warnThresholds?.read ?? defaultThreshold,
			edit: options.warnThresholds?.edit ?? defaultThreshold,
			write: options.warnThresholds?.write ?? defaultThreshold,
		}
		this.isEnabled = options.isEnabled ?? (() => true)
		this.blockOnThreshold = options.blockOnThreshold ?? false
	}

	reset(): void {
		this.categoryCounts.clear()
		this.lastUserPrompt = ""
	}

	/** Record the most recent user prompt so the guard can detect explicit
	 *  requests. Call this from the `input` event handler. */
	setLastUserPrompt(text: string): void {
		this.lastUserPrompt = text.toLowerCase()
	}

	/** Returns the lowercased user prompt (for testing and debugging). */
	getLastUserPrompt(): string {
		return this.lastUserPrompt
	}

	/** True when the user's most recent prompt explicitly requests the
	 *  matched tool or category. Detection is two-tiered:
	 *    1. Program-name match (word-boundary): "use sed to fix this",
	 *       "cat the file", "echo to marker".
	 *    2. Semantic intent match: "read the file", "fix with sed",
	 *       "write to foo.ts", etc. — catches prompts that don't mention
	 *       the tool by name but clearly intend the operation.
	 *  Both use word-boundary matching to avoid false positives (e.g.
	 *  "cat" inside "categorize", "sed" inside "used"). */
	isExplicitlyRequested(matchedSegment: string, category: BashCategory): boolean {
		if (!this.lastUserPrompt) return false
		// First token of the matched segment is the tool name.
		const tool = matchedSegment.split(/\s+/)[0]?.toLowerCase()
		if (tool) {
			const toolPattern = new RegExp(`\\b${escapeRegex(tool)}\\b`)
			if (toolPattern.test(this.lastUserPrompt)) return true
		}
		// Semantic intent fallback — catches intent without naming the tool.
		const intentPatterns = SEMANTIC_INTENT_PATTERNS[category]
		return intentPatterns.some((pattern) => pattern.test(this.lastUserPrompt))
	}

	getCount(category: BashCategory): number {
		return this.categoryCounts.get(category) ?? 0
	}

	/** Threshold for a given category (read/edit/write). */
	getWarnThreshold(category: BashCategory): number {
		return this.warnThresholds[category]
	}

	/**
	 * Inspect a bash command. Returns:
	 *   - `{ decision: "allow" }` when the command is fine.
	 *   - `{ decision: "warn", ... }` for the first match of a category,
	 *     AND for every subsequent match when `blockOnThreshold` is false
	 *     (default). The LLM keeps getting nudged on each occurrence.
	 *   - `{ decision: "block", ... }` once the per-category warnThreshold
	 *     is exceeded, but only when `blockOnThreshold` is true (opt-in).
	 */
	recordCommand(command: string): BashGuardDecision {
		if (!this.isEnabled()) return { decision: "allow" }
		const classification = classifyBashCommand(command)
		if (!classification) return { decision: "allow" }

		// Explicit user request: "use sed to fix this", "cat the file", etc.
		// The user knows what they're asking for; don't override.
		if (this.isExplicitlyRequested(classification.matchedSegment, classification.category)) {
			return { decision: "allow", reason: "user-request" }
		}

		const threshold = this.warnThresholds[classification.category]
		const count = (this.categoryCounts.get(classification.category) ?? 0) + 1
		this.categoryCounts.set(classification.category, count)

		if (count > threshold) {
			// Hard blocking is opt-in. When disabled, the guard keeps
			// steering on every occurrence instead of refusing the call.
			// The downstream `tool_call` handler falls back to a warn in
			// that case so the LLM keeps getting nudged without losing
			// the ability to proceed.
			if (!this.blockOnThreshold) {
				return {
					decision: "warn",
					category: classification.category,
					suggestion: classification.suggestion,
					matchedSegment: classification.matchedSegment,
					tool: classification.tool,
					count,
				}
			}
			return {
				decision: "block",
				category: classification.category,
				suggestion: classification.suggestion,
				matchedSegment: classification.matchedSegment,
				tool: classification.tool,
				count,
			}
		}

		return {
			decision: "warn",
			category: classification.category,
			suggestion: classification.suggestion,
			matchedSegment: classification.matchedSegment,
			tool: classification.tool,
			count,
		}
	}

	/** Build the steer message text for a `warn` decision. */
	formatWarnText(result: BashGuardWarnResult): string {
		return WARN_STEER_BASE.replace("%matchedSegment%", result.matchedSegment)
			.replace("%category%", result.category)
			.replace("%suggestion%", result.suggestion)
	}

	/** Build the block reason text for a `block` decision. */
	formatBlockReason(result: BashGuardBlockResult): string {
		return BLOCK_REASON_BASE.replace("%category%", result.category).replace("%suggestion%", result.suggestion)
	}
}

export default function bashToolGuardExtension(pi: ExtensionAPI, options?: BashGuardOptions): void {
	let ctx: ExtensionContext | undefined

	const guard = new BashToolGuard({
		...options,
		isEnabled: () => {
			// Caller predicate (if any) is consulted first so users can
			// disable the guard from their own config. Plan mode then
			// short-circuits because inspection should never be enforced,
			// regardless of what the caller asked for.
			if (options?.isEnabled && !options.isEnabled()) return false
			const sessionId = ctx?.sessionManager.getSessionId()
			if (!sessionId) return true
			// Plan mode is for inspection; the existing exploration-guard
			// precedent disables itself there. We follow suit so deep
			// reads during scoping aren't blocked.
			return getPermissionMode(sessionId)?.mode !== "plan"
		},
	})

	// Domain event helper: emit a `warn` / `block` / `user-request-allow`
	// event. No-ops silently when `pi.events` is unavailable on the host.
	function emitGuardEvent(channel: string, payload: unknown): void {
		try {
			pi.events.emit(channel, payload)
		} catch {
			// Older pi-coding-agent versions may not expose `events`. The
			// guard still functions correctly without telemetry.
		}
	}

	// Preference (upstream of the guard): a system prompt block with
	// explicit substitution rules. The block lands immediately before
	// "## Available Tools" in the rendered prompt, so the model reads
	// the preferences right when it sees the tool list.
	const blocks = createSystemPromptBlocks(pi, "bash-tool-guard")
	blocks.register({
		id: "tool-preferences",
		render: () => TOOL_PREFERENCES_BLOCK,
	})

	pi.on("session_start", (_event, _ctx) => {
		ctx = _ctx
		guard.reset()

		// Override the bash tool's description in place. The kimchi
		// prompt-enrichment handler reads pi.getAllTools() and passes
		// the same object references to buildSystemPrompt, so the
		// mutation propagates to the rendered prompt. If the tool
		// objects are cloned elsewhere (e.g. tool discovery UI), the
		// worst case is they show a more accurate description there too.
		const bashTool = pi.getAllTools().find((t) => t.name === "bash")
		if (bashTool) {
			bashTool.description = BASH_TOOL_DESCRIPTION
		}
	})

	pi.on("input", (event: InputEvent) => {
		if (event.source === "extension") return
		// Capture the prompt text BEFORE reset so isExplicitlyRequested can
		// still see it after the counters clear.
		const prompt = typeof event.text === "string" ? event.text : ""
		guard.reset()
		guard.setLastUserPrompt(prompt)
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) return { block: false }
		if (event.toolName !== "bash") return { block: false }

		// Dynamic resource toggle: consult the resource store on every
		// bash call so users can disable the guard mid-session from the
		// /resources UI without a restart. Startup-time disablement is
		// still handled by the extension filter; this is a no-op there.
		if (!isResourceEnabled(RESOURCE_ID)) return { block: false }

		const input = event.input as { command?: unknown }
		const command = typeof input.command === "string" ? input.command : ""
		if (!command) return { block: false }

		const result = guard.recordCommand(command)
		if (result.decision === "allow") {
			// Surface user-request overrides so we can measure how often
			// users explicitly ask for bash usage.
			if (result.reason === "user-request") {
				const classification = classifyBashCommand(command)
				if (classification) {
					const payload: BashToolGuardAllowedByUserRequestPayload = {
						category: classification.category,
						tool: classification.tool,
					}
					emitGuardEvent(BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST, payload)
				}
			}
			return { block: false }
		}

		if (result.decision === "block") {
			const payload: BashToolGuardBlockPayload = {
				category: result.category,
				tool: result.tool ?? "",
				count: result.count,
			}
			emitGuardEvent(BASH_TOOL_GUARD_EVENTS.BLOCK, payload)
			return {
				block: true,
				reason: guard.formatBlockReason(result),
			}
		}

		// decision === "warn"
		const payload: BashToolGuardWarnPayload = {
			category: result.category,
			tool: result.tool ?? "",
			count: result.count,
		}
		emitGuardEvent(BASH_TOOL_GUARD_EVENTS.WARN, payload)
		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: guard.formatWarnText(result) }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
		return { block: false }
	})
}
