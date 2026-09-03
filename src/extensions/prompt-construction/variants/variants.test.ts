/**
 * Tests for the prompt-variant override layer:
 * - resolvePromptVariant (resolver)
 * - SPICY descriptor pure functions
 * - buildSystemPrompt default path (snapshot + stock markers)
 * - buildSystemPrompt with variantName "spicy"
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	buildSystemPrompt,
	CORE_GUIDELINES,
	CORE_GUIDELINES_COMMIT_TRAILER_LINE,
	type EnvironmentInfo,
	SINGLE_MODE_DELEGATION_TEXT,
} from "../system-prompt.js"
import { useDefaultPromptVariant } from "../test-utils.js"
import { DEFAULT_VARIANT, PROMPT_VARIANT_ENV, resolvePromptVariant } from "./index.js"
import { SPICY, SPICY_NAME } from "./spicy.js"
import {
	AGENT_DISCIPLINE_BLOCK,
	AGENT_ROLE_TUNING,
	COORDINATOR_DELEGATION_BLOCK,
	guidelinesFor,
	OPINIONATED_BLOCK,
	OPINIONATED_BLOCK_ORCHESTRATOR,
	OPINIONATED_BLOCK_SUBAGENT,
	RULES_BLOCK_HEADER,
	rulesBlockFor,
	SPICY_COMMIT_ATTRIBUTION,
	SPICY_SINGLE_MODE_DELEGATION,
} from "./spicy-prompts.js"

useDefaultPromptVariant()

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

const fakeTools = [
	{ name: "read", description: "ORIGINAL read description" },
	{ name: "bash", description: "ORIGINAL bash description" },
	{ name: "edit", description: "ORIGINAL edit description" },
]

// A session that can actually delegate. The single-mode delegation stance is
// only swapped when the Agent tool is available.
const fakeToolsWithAgent = [...fakeTools, { name: "Agent", description: "ORIGINAL Agent description" }]

const ALL_MODES = ["single", "orchestrator", "subagent"] as const

// ---------------------------------------------------------------------------
// resolvePromptVariant: resolver logic
// ---------------------------------------------------------------------------

describe("resolvePromptVariant", () => {
	let savedEnv: string | undefined

	beforeEach(() => {
		savedEnv = process.env[PROMPT_VARIANT_ENV]
	})

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env[PROMPT_VARIANT_ENV]
		} else {
			process.env[PROMPT_VARIANT_ENV] = savedEnv
		}
	})

	it("returns DEFAULT_VARIANT when called with no argument and env var is unset", () => {
		delete process.env[PROMPT_VARIANT_ENV]
		const result = resolvePromptVariant()
		expect(result).toBe(DEFAULT_VARIANT)
		expect(result.name).toBe("default")
	})

	it("returns DEFAULT_VARIANT when called with empty string", () => {
		const result = resolvePromptVariant("")
		expect(result).toBe(DEFAULT_VARIANT)
		expect(result.name).toBe("default")
	})

	it("returns DEFAULT_VARIANT when called with the string 'default'", () => {
		const result = resolvePromptVariant("default")
		expect(result).toBe(DEFAULT_VARIANT)
		expect(result.name).toBe("default")
	})

	it("returns SPICY when called with 'spicy'", () => {
		const result = resolvePromptVariant("spicy")
		expect(result).toBe(SPICY)
		expect(result.name).toBe("spicy")
	})

	it("returns DEFAULT_VARIANT for an unknown variant name", () => {
		const result = resolvePromptVariant("nonexistent-variant-xyz")
		expect(result).toBe(DEFAULT_VARIANT)
	})

	it("returns DEFAULT_VARIANT for a name that is not in the registry", () => {
		expect(resolvePromptVariant("v2")).toBe(DEFAULT_VARIANT)
		expect(resolvePromptVariant("opinionated-v2")).toBe(DEFAULT_VARIANT)
	})

	it("reads from KIMCHI_PROMPT_VARIANT env var when no argument is given", () => {
		process.env[PROMPT_VARIANT_ENV] = "spicy"
		const result = resolvePromptVariant()
		expect(result).toBe(SPICY)
		expect(result.name).toBe("spicy")
	})

	it("explicit argument takes precedence over env var", () => {
		process.env[PROMPT_VARIANT_ENV] = "spicy"
		const result = resolvePromptVariant("default")
		expect(result).toBe(DEFAULT_VARIANT)
	})

	it("trims whitespace from the env var value", () => {
		process.env[PROMPT_VARIANT_ENV] = "  spicy  "
		const result = resolvePromptVariant()
		expect(result).toBe(SPICY)
	})

	it("returns DEFAULT_VARIANT when env var is set to an unknown value", () => {
		process.env[PROMPT_VARIANT_ENV] = "unknown-variant"
		const result = resolvePromptVariant()
		expect(result).toBe(DEFAULT_VARIANT)
	})

	// Names inherited from Object.prototype must not be treated as registered
	// variants, otherwise a stray env var yields a bogus "variant" object.
	for (const inherited of ["constructor", "__proto__", "toString"]) {
		it(`returns DEFAULT_VARIANT for the inherited property name '${inherited}'`, () => {
			expect(resolvePromptVariant(inherited)).toBe(DEFAULT_VARIANT)
		})

		it(`returns DEFAULT_VARIANT when env var is set to '${inherited}'`, () => {
			process.env[PROMPT_VARIANT_ENV] = inherited
			expect(resolvePromptVariant()).toBe(DEFAULT_VARIANT)
		})
	}
})

// ---------------------------------------------------------------------------
// SPICY: descriptor pure functions
// ---------------------------------------------------------------------------

describe("SPICY descriptor", () => {
	it("sets no suppress* field at all, so nothing is switched off for spicy sessions", () => {
		expect(Object.keys(SPICY).filter((key) => key.startsWith("suppress"))).toEqual([])
	})

	it("factualAccuracy is null (omits the Factual Accuracy section)", () => {
		expect(SPICY.factualAccuracy).toBeNull()
	})

	it("intro('orchestrator') contains 'orchestrator'", () => {
		if (!SPICY.intro) throw new Error("intro not defined on SPICY")
		expect(SPICY.intro("orchestrator")).toContain("orchestrator")
	})

	it("intro('single') does not contain 'orchestrator'", () => {
		if (!SPICY.intro) throw new Error("intro not defined on SPICY")
		expect(SPICY.intro("single")).not.toContain("orchestrator")
	})

	it("rulesReminder is an object (enabled)", () => {
		expect(SPICY.rulesReminder).toBeDefined()
		expect(typeof SPICY.rulesReminder).toBe("object")
	})

	it("rulesReminder.text is the mode-aware rules block", () => {
		expect(SPICY.rulesReminder?.text("single")).toBe(rulesBlockFor("single"))
	})

	it("rulesReminder.intervalMs is five minutes", () => {
		expect(SPICY.rulesReminder?.intervalMs).toBe(5 * 60 * 1000)
	})

	it("name is 'spicy'", () => {
		expect(SPICY.name).toBe(SPICY_NAME)
		expect(SPICY_NAME).toBe("spicy")
	})

	it("tagline is 'spicy architect'", () => {
		expect(SPICY.tagline).toBe("spicy architect")
	})

	it("transformAgents is defined", () => {
		expect(SPICY.transformAgents).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// buildSystemPrompt DEFAULT path: snapshot + stock markers
// ---------------------------------------------------------------------------

describe("buildSystemPrompt: default variant (no variantName)", () => {
	it("single mode: matches snapshot (any future drift is caught)", () => {
		const result = buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "single",
		})
		expect(result).toMatchSnapshot()
	})

	it("orchestrator mode: matches snapshot (any future drift is caught)", () => {
		const result = buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "orchestrator",
		})
		expect(result).toMatchSnapshot()
	})

	it("contains the stock Documents section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("## Documents")
	})

	it("contains the stock Guidelines section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("## Guidelines")
	})

	it("contains the stock Factual Accuracy section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("## Factual Accuracy")
	})

	it("contains the stock intro 'You are Kimchi, an AI coding agent.'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("You are Kimchi, an AI coding agent.")
	})

	// The tools section lists names only; each tool's description reaches the
	// model through the function-calling payload, not the system prompt.
	it("lists tool names only and carries no tool descriptions", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("## Available Tools\n\nread, bash, edit")
		expect(result).not.toContain("ORIGINAL read description")
		expect(result).not.toContain("ORIGINAL bash description")
		expect(result).not.toContain("ORIGINAL edit description")
	})

	for (const mode of ALL_MODES) {
		it(`${mode} mode: passing variantName 'default' produces the same output as omitting variantName`, () => {
			const withDefault = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode, variantName: "default" })
			const withoutVariant = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode })
			expect(withDefault).toBe(withoutVariant)
		})
	}
})

// ---------------------------------------------------------------------------
// buildSystemPrompt with variantName "spicy"
// ---------------------------------------------------------------------------

describe("buildSystemPrompt: spicy variant", () => {
	it("uses the spicy orchestrator intro text in orchestrator mode", () => {
		const result = buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "orchestrator",
			variantName: "spicy",
		})
		expect(result).toContain("You are Kimchi, an interactive command-line coding agent")
	})

	it("contains '## Documents' (runtime-driven, Documents section kept)", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("## Documents")
	})

	it("does NOT contain '## Factual Accuracy' section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toContain("## Factual Accuracy")
	})

	it("contains the appended '### Working discipline' block", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("### Working discipline")
	})

	it("orchestrator mode contains the Orchestration section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("## Orchestration")
	})

	// The tools section lists names only, for every variant; tool descriptions
	// travel through the function-calling payload instead.
	it("lists tool names only, same as the default variant", () => {
		const result = buildSystemPrompt({
			tools: [{ name: "read", description: "ORIGINAL" }],
			env: testEnv,
			mode: "orchestrator",
			variantName: "spicy",
		})
		expect(result).toContain("## Available Tools\n\nread")
		expect(result).not.toContain("ORIGINAL")
	})

	it("does NOT contain the stock AI coding agent intro", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toContain("You are Kimchi, an AI coding agent.")
	})

	it("single-mode: uses single intro text and no Orchestration section", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "spicy" })
		expect(result).toContain("You are Kimchi, an interactive command-line coding agent")
		expect(result).not.toContain("## Orchestration")
	})

	it("resolves 'spicy' from env var identically to explicit variantName", () => {
		const savedEnv = process.env[PROMPT_VARIANT_ENV]
		try {
			process.env[PROMPT_VARIANT_ENV] = "spicy"
			const viaEnv = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
			const viaArg = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
			expect(viaEnv).toBe(viaArg)
		} finally {
			if (savedEnv === undefined) {
				delete process.env[PROMPT_VARIANT_ENV]
			} else {
				process.env[PROMPT_VARIANT_ENV] = savedEnv
			}
		}
	})

	it("spicy full prompt (orchestrator mode) matches snapshot", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toMatchSnapshot()
	})

	// Snapshotted with the Agent tool present: that is what an interactive
	// single-model session looks like, and the delegation stance depends on it.
	it("spicy full prompt (single mode) matches snapshot", () => {
		const result = buildSystemPrompt({ tools: fakeToolsWithAgent, env: testEnv, mode: "single", variantName: "spicy" })
		expect(result).toMatchSnapshot()
	})

	// Completion guidance assertions
	it("SPICY.guidelines carries requirements-completion guidance", () => {
		const combined = guidelinesFor("single")
		expect(combined).toMatch(/requirements/i)
		expect(combined).toContain("check off each one before calling the task done")
	})

	it("SPICY.guidelines contains '### Working discipline'", () => {
		expect(guidelinesFor("single")).toContain("### Working discipline")
	})
})

// ---------------------------------------------------------------------------
// Additive guidelines: spicy keeps base safety rules, swaps the trailer,
//     and appends the working-discipline block
// ---------------------------------------------------------------------------

describe("spicy additive guidelines", () => {
	const spicySingle = () => buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "spicy" })

	it("keeps the base shell-timeout safety rule", () => {
		expect(spicySingle()).toContain("Always bound shell commands")
	})

	it("keeps the base never-run-interactive-commands rule", () => {
		expect(spicySingle()).toContain("Never run interactive commands")
	})

	it("keeps the base stop-after-3-attempts rule", () => {
		expect(spicySingle()).toContain("fails to advance the task after 3 attempts")
	})

	it("does NOT contain the base commit trailer", () => {
		expect(spicySingle()).not.toContain("Co-Authored-By: Kimchi")
	})

	it("swaps in the overridable commit-attribution default", () => {
		expect(spicySingle()).toContain(SPICY_COMMIT_ATTRIBUTION)
		expect(SPICY_COMMIT_ATTRIBUTION).toMatch(/unless your project or user instructions/i)
	})

	it("appends the compact truthfulness bullet", () => {
		expect(spicySingle()).toContain(
			"Do not invent facts, APIs, or file contents; verify before asserting and say plainly when something is unverified.",
		)
	})

	it("appends the fresh-review-before-done bullet", () => {
		expect(spicySingle()).toContain("run a review pass with a fresh subagent rather than only self-checking")
	})

	it("appends the numbered-requirements bullet", () => {
		expect(spicySingle()).toContain(
			"write the requirements as a short numbered list before implementing and check off each one",
		)
	})

	it("has no '## Factual Accuracy' heading", () => {
		expect(spicySingle()).not.toContain("## Factual Accuracy")
	})

	it("guards that the base guidelines are composed from the exported trailer constant", () => {
		// The swap in guidelinesFor targets this exact line, so the guidelines
		// must keep carrying it verbatim.
		expect(CORE_GUIDELINES).toContain(CORE_GUIDELINES_COMMIT_TRAILER_LINE)
	})
})

// ---------------------------------------------------------------------------
// Single-Model Mode delegation stance: stock text by default, spicy's
//     delegation text under spicy
// ---------------------------------------------------------------------------

describe("single-mode delegation stance", () => {
	const single = (variantName?: string) =>
		buildSystemPrompt({ tools: fakeToolsWithAgent, env: testEnv, mode: "single", variantName })

	it("guards that the exported delegation constant is still present in the stock single-mode section", () => {
		// If the Single-Model Mode wording drifts away from this constant, a
		// variant's replacement would silently no-op.
		expect(single()).toContain(SINGLE_MODE_DELEGATION_TEXT)
	})

	it("default single prompt keeps the do-not-spawn-subagents stance", () => {
		expect(single()).toContain("Do not spawn subagents")
		expect(single()).toContain("Handle tasks directly yourself.")
	})

	it("spicy single prompt drops the do-not-spawn-subagents stance", () => {
		expect(single("spicy")).not.toContain("Do not spawn subagents")
		expect(single("spicy")).not.toContain("Handle tasks directly yourself.")
	})

	it("spicy single prompt carries the delegation stance instead", () => {
		expect(single("spicy")).toContain(SPICY_SINGLE_MODE_DELEGATION)
	})

	it("spicy single prompt keeps the subagent model rule that follows the swapped text", () => {
		expect(single("spicy")).toContain(
			"When you do spawn a subagent, pass your own model ID in the `model` parameter by default",
		)
	})

	// Without the Agent tool the session cannot delegate at all, so the stock
	// "handle it yourself" stance is the accurate one even under spicy.
	it("spicy single prompt keeps the stock stance when the Agent tool is absent", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "spicy" })
		expect(result).toContain(SINGLE_MODE_DELEGATION_TEXT)
		expect(result).not.toContain(SPICY_SINGLE_MODE_DELEGATION)
	})

	it("default single prompt keeps the stock stance whether or not the Agent tool is present", () => {
		expect(single()).toContain(SINGLE_MODE_DELEGATION_TEXT)
		expect(buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })).toContain(SINGLE_MODE_DELEGATION_TEXT)
	})

	it("spicy orchestrator prompt has no Single-Model Mode section and no delegation stance text", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toContain("## Single-Model Mode")
		expect(result).not.toContain(SPICY_SINGLE_MODE_DELEGATION)
	})
})

// ---------------------------------------------------------------------------
// AGENT_DISCIPLINE_BLOCK content
// ---------------------------------------------------------------------------

describe("AGENT_DISCIPLINE_BLOCK content", () => {
	it("contains 'Work from the requirements'", () => {
		expect(AGENT_DISCIPLINE_BLOCK).toContain("Work from the requirements")
	})

	it("contains 'Report honestly'", () => {
		expect(AGENT_DISCIPLINE_BLOCK).toContain("Report honestly")
	})

	it("contains test honesty bullet (never delete or weaken a test)", () => {
		expect(AGENT_DISCIPLINE_BLOCK).toContain("never delete or weaken a test")
	})

	it("contains version-control safety bullet (do not force-push)", () => {
		expect(AGENT_DISCIPLINE_BLOCK).toContain("do not force-push")
	})

	it("contains version-control safety bullet (back up untracked files)", () => {
		expect(AGENT_DISCIPLINE_BLOCK).toContain("back up untracked files")
	})
})

// ---------------------------------------------------------------------------
// AGENT_ROLE_TUNING key guard: every key must match a real DEFAULT_AGENTS name
// ---------------------------------------------------------------------------

import { DEFAULT_AGENTS } from "../../agents/personas/default-agents.js"

describe("AGENT_ROLE_TUNING key guard", () => {
	it("every key in AGENT_ROLE_TUNING corresponds to an actual built-in persona name", () => {
		const personaNames = new Set(DEFAULT_AGENTS.keys())
		for (const key of Object.keys(AGENT_ROLE_TUNING)) {
			expect(personaNames.has(key), `AGENT_ROLE_TUNING key '${key}' does not match any DEFAULT_AGENTS persona`).toBe(
				true,
			)
		}
	})
})

// ---------------------------------------------------------------------------
// guidelinesFor: mode-aware guidelines
// ---------------------------------------------------------------------------

describe("guidelinesFor", () => {
	it("single mode contains '**Coordinator and delegation**'", () => {
		expect(guidelinesFor("single")).toContain("**Coordinator and delegation**")
	})

	// A subagent has the delegation tools stripped, so it gets no coordinator
	// section and no instruction to hand work to another agent.
	it("subagent mode contains neither coordinator block", () => {
		expect(guidelinesFor("subagent")).not.toContain("**Coordinator and delegation**")
		expect(guidelinesFor("subagent")).not.toContain("**Coordination level**")
	})

	it("subagent mode does NOT ask for a review pass by a fresh subagent", () => {
		expect(guidelinesFor("subagent")).not.toContain("run a review pass with a fresh subagent")
		expect(guidelinesFor("single")).toContain("run a review pass with a fresh subagent")
		expect(guidelinesFor("orchestrator")).toContain("run a review pass with a fresh subagent")
	})

	it("subagent mode keeps the shared working-discipline sections", () => {
		const subagent = guidelinesFor("subagent")
		expect(subagent).toContain("### Working discipline")
		expect(subagent).toContain("**Testing discipline**")
		expect(subagent).toContain("**Version-control safety**")
	})

	it("orchestrator mode does NOT contain '**Coordinator and delegation**'", () => {
		expect(guidelinesFor("orchestrator")).not.toContain("**Coordinator and delegation**")
	})

	it("orchestrator mode DOES contain '**Coordination level**'", () => {
		expect(guidelinesFor("orchestrator")).toContain("**Coordination level**")
	})

	it("single mode does NOT contain '**Coordination level**'", () => {
		expect(guidelinesFor("single")).not.toContain("**Coordination level**")
	})

	it("both single and orchestrator keep a base safety rule", () => {
		expect(guidelinesFor("single")).toContain("After every tool result, ALWAYS produce text")
		expect(guidelinesFor("orchestrator")).toContain("After every tool result, ALWAYS produce text")
	})

	it("both single and orchestrator contain '### Working discipline'", () => {
		expect(guidelinesFor("single")).toContain("### Working discipline")
		expect(guidelinesFor("orchestrator")).toContain("### Working discipline")
	})

	it("OPINIONATED_BLOCK still contains the coordinator bullets (byte-identity preserved)", () => {
		expect(OPINIONATED_BLOCK).toContain(COORDINATOR_DELEGATION_BLOCK)
	})
})

// ---------------------------------------------------------------------------
// Each principle is stated once inside the appended block
// ---------------------------------------------------------------------------

describe("appended working-discipline block states each principle once", () => {
	const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

	const blocks: [string, string][] = [
		["single", OPINIONATED_BLOCK],
		["orchestrator", OPINIONATED_BLOCK_ORCHESTRATOR],
		["subagent", OPINIONATED_BLOCK_SUBAGENT],
	]

	for (const [label, block] of blocks) {
		it(`${label}: states the over-engineering rule once`, () => {
			expect(occurrences(block, "over-engineer")).toBe(1)
		})

		it(`${label}: states the challenge-the-requirements rule once`, () => {
			expect(occurrences(block, "Challenge requirements")).toBe(1)
		})

		it(`${label}: states the do-not-publish-unasked rule once, covering commits and shared resources`, () => {
			expect(occurrences(block, "unless explicitly asked")).toBe(1)
			expect(block).toContain("Never commit, push, publish, or comment on shared resources")
		})
	}
})

// ---------------------------------------------------------------------------
// rulesBlockFor: mode-aware working rules
// ---------------------------------------------------------------------------

describe("rulesBlockFor", () => {
	it("single mode opens with the rules header and keeps the delegation bullet", () => {
		const block = rulesBlockFor("single")
		expect(block).toMatch(new RegExp(`^${RULES_BLOCK_HEADER}`))
		expect(block).toContain("- Delegate implementation, testing, and review to focused subagents")
	})

	it("orchestrator mode drops the delegation bullet and names the review personas", () => {
		const block = rulesBlockFor("orchestrator")
		expect(block).toMatch(new RegExp(`^${RULES_BLOCK_HEADER}`))
		expect(block).not.toContain("- Delegate implementation, testing, and review to focused subagents")
		expect(block).toContain("use the Reviewer and Fixer personas")
	})

	it("both modes carry the shared rules", () => {
		for (const mode of ["single", "orchestrator"] as const) {
			expect(rulesBlockFor(mode)).toContain("Never delete a failing test")
			expect(rulesBlockFor(mode)).toContain("Never commit or push unless asked.")
		}
	})

	it("subagent mode gets no rules block", () => {
		expect(rulesBlockFor("subagent")).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Default variant byte-identical guard
// ---------------------------------------------------------------------------

describe("default variant byte-identical guard", () => {
	it("default single prompt does NOT contain '**Coordination level**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain("**Coordination level**")
	})

	it("default orchestrator prompt does NOT contain '**Coordination level**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain("**Coordination level**")
	})

	it("default single prompt does NOT contain '### Working discipline' (spicy-only section)", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain("### Working discipline")
	})

	it("spicy single prompt contains '**Coordinator and delegation**' (full block for single)", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "spicy" })
		expect(result).toContain("**Coordinator and delegation**")
	})

	it("spicy orchestrator prompt does NOT contain '**Coordinator and delegation**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toContain("**Coordinator and delegation**")
	})

	it("spicy orchestrator prompt DOES contain '**Coordination level**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("**Coordination level**")
	})
})

// ---------------------------------------------------------------------------
// User-override precedence for the commit-attribution default
// ---------------------------------------------------------------------------

describe("spicy commit-attribution override precedence", () => {
	// A project context file asks for a specific commit trailer. This asserts the
	// prompt-level precondition for the override: spicy's attribution rule is
	// phrased as deferrable, and the user's instruction is present and appears
	// after the ## Guidelines section. It does not (and a unit test cannot) assert
	// the model's runtime behaviour of actually preferring the user instruction.
	const acmeInstruction = "Always sign commits with Co-Authored-By: Acme <ci@acme.example>"
	const build = () =>
		buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "single",
			variantName: "spicy",
			contextFiles: [{ path: "/repo/AGENTS.md", content: acmeInstruction }],
		})

	it("keeps spicy's overridable attribution default in the guidelines", () => {
		expect(build()).toContain(SPICY_COMMIT_ATTRIBUTION)
	})

	it("renders the project instruction under ## Project Guidelines", () => {
		const result = build()
		expect(result).toContain("## Project Guidelines")
		expect(result).toContain(acmeInstruction)
	})

	it("places the project instruction after the ## Guidelines section", () => {
		const result = build()
		expect(result.indexOf(acmeInstruction)).toBeGreaterThan(result.indexOf("## Guidelines"))
	})

	it("does not carry the base Kimchi trailer that the user instruction overrides", () => {
		expect(build()).not.toContain("Co-Authored-By: Kimchi")
	})
})
