/**
 * Bash tool preference
 *
 * Biases the model toward dedicated tools (read, edit, write, grep, find,
 * ls) instead of using bash for file operations. Complements the
 * bash-tool-guard extension, which steers AFTER the model has already
 * picked the wrong tool — this one steers BEFORE the choice is made.
 *
 * Two mechanisms:
 *
 *   1. A "Tool Preferences" system prompt block. Renders markdown
 *      guidance into the prompt immediately before the "## Available
 *      Tools" section (the block machinery in `system-prompt-blocks.ts`
 *      inserts blocks at that position). The model reads the preferences
 *      right when it sees the tool list.
 *
 *   2. An override of the bash tool's `description` field. The upstream
 *      snippet "Execute bash commands (ls, grep, find, etc.)" tells the
 *      model bash can be used for those — exactly the operations we
 *      steer it away from. Mutating the tool object's description on
 *      `session_start` propagates to the prompt because the kimchi
 *      prompt-enrichment handler reads `pi.getAllTools()` and passes the
 *      same object references to `buildSystemPrompt`.
 *
 * Why in-place mutation is safe here: the description is only consumed by
 * `formatToolsSection` for prompt rendering. If the upstream ever caches
 * the description elsewhere, the worst case is the modified (and more
 * accurate) description is shown there too.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "./prompt-construction/system-prompt-blocks.js"

/**
 * Markdown block injected into the system prompt immediately before the
 * "## Available Tools" section. Uses inline-code backticks so the model
 * can easily match the substitutions.
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
 * file-operation substitutions and lists what bash IS for.
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
 * Pure helper: applies the override to a tool definition, returning a new
 * tool definition. Always returns a new object (never the input) so
 * callers can rely on immutability. Tools with no override get a shallow
 * copy with the same description.
 */
export function applyDescriptionOverride<T extends { name: string; description: string }>(tool: T): T {
	const override = toolDescriptionOverride(tool.name)
	return { ...tool, description: override ?? tool.description }
}

export default function bashToolPreferenceExtension(pi: ExtensionAPI): void {
	const blocks = createSystemPromptBlocks(pi, "bash-tool-preference")
	blocks.register({
		id: "tool-preferences",
		render: () => TOOL_PREFERENCES_BLOCK,
	})

	pi.on("session_start", () => {
		const bashTool = pi.getAllTools().find((t) => t.name === "bash")
		if (bashTool) {
			bashTool.description = BASH_TOOL_DESCRIPTION
		}
	})
}
