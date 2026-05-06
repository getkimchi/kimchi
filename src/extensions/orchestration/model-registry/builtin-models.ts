import type { ModelCapabilities } from "./types.js"

/**
 * Model descriptions are written as natural-language decision briefs, not
 * benchmark data sheets. While the orchestrator LLM could interpret raw
 * benchmark names and scores if we provided them with definitions, doing
 * so would significantly bloat the user prompt - each model would need
 * dozens of benchmark scores plus a glossary explaining what each one
 * measures. Instead, we pre-digest the benchmark evidence into concise
 * statements the orchestrator can act on directly: "strongest pure coding
 * model in the pool", "reliably formats tool calls correctly",
 * "near-perfect retrieval accuracy" etc.
 *
 * This map is a local capability knowledge-base keyed by model ID. It acts
 * as an enrichment layer on top of the dynamic model list fetched from the
 * API at startup. Models present in the API but absent here get a generic
 * descriptor and a startup warning. Models present here but absent from the
 * API are excluded from subagent routing (they cannot be called). The
 * intention is to iterate on these descriptions locally and promote them to
 * the API once the shape is stable.
 */

const KIMI_K26_DESCRIPTION = `\
Flagship Kimi model with vision support — the key model for complex planning decisions \
and deep research. Handles images, screenshots, and visual input with superior reasoning. \
When a hard problem needs architectural planning, strategic analysis, or methodical \
research, this is the model to delegate to. Best for complex multi-step tasks.`

const KIMI_K25_DESCRIPTION = `\
Kimi model with vision support — the workhorse for simpler execution tasks and \
exploration. Handles images, screenshots, and visual input. Best for straightforward \
coding tasks, quick exploration, and when vision input is needed but planning depth \
isn't critical. Reliable and efficient for well-scoped subtasks.`

const MINIMAX_M27_DESCRIPTION = `\
The strongest coding model in the pool. \
Best accuracy on multi-file bugs, complex refactors, and extended tool call chains. \
Best default choice for any well-scoped coding task.`

const NEMOTRON_3_SUPER_DESCRIPTION = `\
Cheapest and fastest. 1M token context window with near-perfect retrieval — \
can ingest entire large codebases in a single pass. \
Weakest at coding; not reliable for complex multi-file changes. \
Best for codebase exploration, research, and simple well-defined tasks.`

const CLAUDE_OPUS_47_DESCRIPTION = `\
Anthropic's flagship Claude model. Dominates at architectural planning and complex task \
decomposition — when a hard problem needs a superior plan, this is the model to delegate to. \
Also excels at deep reasoning, research, and exploration across large codebases. Best for \
complex multi-step tasks requiring careful analysis and methodical planning.`

// TODO: these capabilities could be returned by our models metadata API.
/**
 * Capability knowledge-base keyed by model ID. Used to enrich the dynamic
 * model list from the API with orchestration metadata (tier, strengths,
 * vision, description). Models not present here get a generic descriptor
 * and a startup warning.
 *
 * Set the value to "ignored" to suppress the startup warning for a model
 * without adding routing support for it.
 */
export const MODEL_CAPABILITIES: ReadonlyMap<string, ModelCapabilities | "ignored"> = new Map<
	string,
	ModelCapabilities | "ignored"
>([
	[
		"kimi-k2.6",
		{
			vision: true,
			strengths: ["explore", "research", "plan", "review"],
			tier: "heavy",
			description: KIMI_K26_DESCRIPTION,
			guidelines: {
				plan: `During **plan** phase:
- You are tuned for long-horizon orchestration: open with a numbered 3–7 step plan before any tool call.
- Decompose ambitious tasks into a queue of independent sub-tasks the build phase can pull from — K2.6 plans best when given a queue, not a single monolithic instruction.
- Save the spec to the Documents directory with concrete file paths, interfaces, and per-step acceptance criteria.
- Mark each step as "do here" vs. "delegate" so build can route work without re-planning.
- Do NOT start implementation in this phase, even partially.`,
				explore: `During **explore** phase:
- Use your long-context strength: prefer reading 3–5 files in full over many partial reads.
- Trust the built-in context compressor — do NOT manually summarise mid-exploration.
- Batch independent \`grep\`/\`find\`/\`read\` calls in one turn.
- Stop once the integration points are clear; resist the urge to map every file.
- Output: paths, key types, seams. Skip narration.`,
			},
		},
	],
	[
		"kimi-k2.5",
		{
			vision: true,
			strengths: ["explore", "research", "plan", "review"],
			tier: "heavy",
			description: KIMI_K25_DESCRIPTION,
			guidelines: {
				build: `During **build** phase:
- After every tool result, ALWAYS produce text — either the next tool call with explicit reasoning, or a final summary. Never re-issue the same tool call after a successful result.
- Emit complete, well-formed tool calls only. Never output partial fragments, raw JSON snippets, or "(m"-style stubs as if they were tool calls.
- Plan-first: before the first tool call, outline 3–5 steps in plain text, then execute step 1.
- Split big mixed-goal prompts into chunks; do NOT try to address multiple unrelated goals in one turn.
- Read files before editing them. Prefer \`edit\` over \`write\` for files >30 lines.
- Run tests after meaningful changes; fix errors before declaring done.`,
				explore: `During **explore** phase:
- Plan-first: state in 3–5 bullets what you intend to read and why, then batch the reads in a single turn.
- Chunk and label long inputs — do NOT pour an entire codebase into one mental pass; group by module.
- Stop and summarise as soon as integration points are identified.
- Do NOT modify files. Do NOT write a plan yet.`,
			},
		},
	],
	[
		"minimax-m2.7",
		{
			vision: false,
			strengths: ["build", "review"],
			tier: "standard",
			description: MINIMAX_M27_DESCRIPTION,
			guidelines: {
				build: `During **build** phase:
- Outline-then-diff: state the change in 1–3 bullets, then emit the minimal diff. No "clever" refactors, no surprise restructuring.
- STAY IN SCOPE. Do NOT add features, error handling, concurrency primitives, or abstractions the task did not explicitly ask for. M2's known failure mode is over-reaching — resist it.
- Run the type-checker / linter / tests FIRST to narrow the error list before fixing anything.
- Batch independent \`edit\` calls aggressively — one turn, multiple files. Read all affected files first, then edit in one batch.
- Prefer \`edit\` over \`write\` for files >30 lines. Keep diffs surgical.
- Do NOT default to mutex-based concurrency in Go (or any pattern not specified). Use exactly the concurrency primitive the task names; if none is named, ask.
- Verify library methods exist before calling them — do NOT hallucinate APIs.
- Limit each turn to a single focused goal. M2 has excellent state tracking when goals are limited per turn; it degrades when asked to do everything in parallel.`,
				review: `During **review** phase:
- Read the diff first, then the touched files in context.
- Flag scope creep aggressively — added features, unsolicited refactors, or new abstractions that the task did not ask for. This is M2's most common failure mode.
- Flag hallucinated APIs (calls to methods that do not exist on the library version in use).
- Flag inappropriate concurrency choices (e.g. mutex spam in Go where none was requested).
- Be specific: quote the line, name the issue, propose the minimal fix. Do NOT rewrite inline.`,
			},
		},
	],
	[
		"nemotron-3-super-fp4",
		{
			vision: false,
			strengths: ["build"],
			tier: "light",
			description: NEMOTRON_3_SUPER_DESCRIPTION,
			guidelines: {
				build: `During **build** phase:
- Stay strictly within the spec. Do NOT design, refactor, or expand scope. If the spec is ambiguous, stop and report — do not improvise.
- Touch one file at a time when possible. Avoid multi-file refactors; your reliability drops sharply on those.
- Read each file in full before editing — your 1M context window is a strength, use it.
- Prefer \`edit\` with small, surgical replacements over \`write\`.
- After each change, run the type-checker / tests. If a fix attempt fails twice, stop and report the error rather than retrying blindly.`,
			},
		},
	],
	[
		"claude-opus-4-7",
		{
			vision: true,
			strengths: ["explore", "research", "plan", "review"],
			tier: "heavy",
			description: CLAUDE_OPUS_47_DESCRIPTION,
			guidelines: {
				plan: `During **plan** phase:
- Match plan depth to task complexity. A single-file edit needs a 5-line spec, not a treatise.
- Lead with concrete artefacts: file paths, function signatures, interfaces. Prose is supporting material, not the headline.
- Save the spec to the Documents directory. Build will read from there — write it once, write it well.
- Call out rejected alternatives in one line each. Don't relitigate decisions in build.
- Stop planning once interfaces and file paths are unambiguous. Over-planning wastes downstream tokens.`,
				explore: `During **explore** phase:
- Resist over-exploration. Stop when you have the integration points needed to plan, not when you have read every file.
- Batch reads in single turns. Trace one call chain end-to-end rather than sampling many shallowly.
- Output a tight findings summary (paths, types, seams). No narration of the journey.`,
				review: `During **review** phase:
- Prioritise: correctness > security > architecture > edge cases > style. Skip nits.
- Quote the exact line; propose the minimal fix; do not rewrite inline.
- Flag missing tests for behaviour the diff introduces.
- Be decisive — call out the top 3–5 issues, not every observation.`,
			},
		},
	],
	["glm-5-fp8", "ignored"],
	["minimax-m2.5", "ignored"],
	["claude-opus-4-6", "ignored"],
	["claude-sonnet-4-6", "ignored"],
	["claude-sonnet-4-5", "ignored"],
])
