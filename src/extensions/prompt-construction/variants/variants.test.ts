/**
 * Tests for the prompt-variant override layer:
 * - resolvePromptVariant (resolver)
 * - SPICY descriptor pure functions
 * - buildSystemPrompt default path (snapshot + stock markers)
 * - buildSystemPrompt with variantName "spicy"
 */

import type { Skill } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type EnvironmentInfo, buildSystemPrompt } from "../system-prompt.js"
import { DEFAULT_VARIANT, PROMPT_VARIANT_ENV, resolvePromptVariant } from "./index.js"
import {
	AGENT_DISCIPLINE_BLOCK,
	AGENT_ROLE_TUNING,
	COORDINATOR_DELEGATION_BLOCK,
	DISCIPLINE_NUDGE_CORE,
	DISCIPLINE_NUDGE_DELEGATION,
	DISCIPLINE_NUDGE_PREFIX,
	DISCIPLINE_NUDGE_TEXT,
	GUIDELINES,
	OPINIONATED_BLOCK,
	OPINIONATED_BLOCK_ORCHESTRATOR,
	RULES_BLOCK,
	RULES_BLOCK_ORCHESTRATOR,
	SPICY,
	SPICY_NAME,
	blockRewriter,
	disciplineNudgeFor,
	guidelinesFor,
} from "./spicy.js"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const testEnv: EnvironmentInfo = {
	os: "Linux",
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

// ---------------------------------------------------------------------------
// A) resolvePromptVariant: resolver logic
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

	it("returns DEFAULT_VARIANT for the old 'v2' name (no longer registered)", () => {
		const result = resolvePromptVariant("v2")
		expect(result).toBe(DEFAULT_VARIANT)
	})

	it("returns DEFAULT_VARIANT for the old 'opinionated-v2' name (no longer registered)", () => {
		const result = resolvePromptVariant("opinionated-v2")
		expect(result).toBe(DEFAULT_VARIANT)
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
})

// ---------------------------------------------------------------------------
// B) SPICY: descriptor pure functions
// ---------------------------------------------------------------------------

describe("SPICY descriptor", () => {
	describe("toolDescription", () => {
		it("rewrites the 'read' tool description to mention cat/head/tail preference", () => {
			if (!SPICY.toolDescription) throw new Error("toolDescription not defined on SPICY")
			const result = SPICY.toolDescription({ name: "read", description: "ORIGINAL" })
			expect(result).toBeDefined()
			expect(result).toContain("cat/head/tail")
		})

		it("rewrites the 'edit' tool to mention exact-text and unique match constraints", () => {
			if (!SPICY.toolDescription) throw new Error("toolDescription not defined on SPICY")
			const result = SPICY.toolDescription({ name: "edit", description: "ORIGINAL" })
			expect(result).toBeDefined()
			expect(result).toMatch(/exact.text/i)
		})

		it("returns undefined for an unknown tool name, leaving description unchanged", () => {
			if (!SPICY.toolDescription) throw new Error("toolDescription not defined on SPICY")
			const result = SPICY.toolDescription({ name: "unknowntool", description: "ORIGINAL" })
			expect(result).toBeUndefined()
		})

		it("returns a string (not undefined) for all registered tools", () => {
			if (!SPICY.toolDescription) throw new Error("toolDescription not defined on SPICY")
			const registeredTools = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search"]
			for (const name of registeredTools) {
				const result = SPICY.toolDescription({ name, description: "ORIGINAL" })
				expect(result, `Expected a description for tool '${name}'`).toBeDefined()
				expect(typeof result).toBe("string")
			}
		})
	})

	describe("rewriteBlock", () => {
		it("rewrites behaviours/rules block to mention bounded tool output", () => {
			if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
			const result = SPICY.rewriteBlock({ owner: "behaviours", id: "rules", content: "x" })
			expect(result).toBeDefined()
			expect(typeof result).toBe("string")
			expect(result as string).toContain("Bound tool output")
		})

		it("rewrites todos/todo-guidance block to include when-to and when-not-to guidance", () => {
			if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
			const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
			expect(result).toBeDefined()
			expect(typeof result).toBe("string")
			expect(result as string).toContain("Use a todo list when:")
			expect(result as string).toContain("Skip it when:")
		})

		it("returns undefined for blocks not handled by the variant", () => {
			if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
			const result = SPICY.rewriteBlock({ owner: "other", id: "x", content: "y" })
			expect(result).toBeUndefined()
		})

		it("returns undefined for a behaviours block with an unrecognised id", () => {
			if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
			const result = SPICY.rewriteBlock({ owner: "behaviours", id: "some-other-id", content: "y" })
			expect(result).toBeUndefined()
		})

		it("returns undefined for a todos block with an unrecognised id", () => {
			if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
			const result = SPICY.rewriteBlock({ owner: "todos", id: "some-other-id", content: "y" })
			expect(result).toBeUndefined()
		})
	})

	it("forceMode is undefined (no forced mode, rides the runtime)", () => {
		expect(SPICY.forceMode).toBeUndefined()
	})

	it("documents is undefined (keeps stock Documents section)", () => {
		expect(SPICY.documents).toBeUndefined()
	})

	it("suppress is undefined (must NOT suppress orchestration/phase-guidelines)", () => {
		expect(SPICY.suppress).toBeUndefined()
	})

	it("factualAccuracy is null (omits the Factual Accuracy section)", () => {
		expect(SPICY.factualAccuracy).toBeNull()
	})

	it("skillsTransform is defined", () => {
		expect(SPICY.skillsTransform).toBeDefined()
	})

	it("toolDescription is defined", () => {
		expect(SPICY.toolDescription).toBeDefined()
	})

	it("rewriteBlock is defined", () => {
		expect(SPICY.rewriteBlock).toBeDefined()
	})

	it("intro('orchestrator') contains 'orchestrator'", () => {
		if (!SPICY.intro) throw new Error("intro not defined on SPICY")
		expect(SPICY.intro("orchestrator")).toContain("orchestrator")
	})

	it("intro('single') does not contain 'orchestrator'", () => {
		if (!SPICY.intro) throw new Error("intro not defined on SPICY")
		expect(SPICY.intro("single")).not.toContain("orchestrator")
	})

	it("disciplineReminder is an object (enabled)", () => {
		expect(SPICY.disciplineReminder).toBeDefined()
		expect(typeof SPICY.disciplineReminder).toBe("object")
	})

	it("disciplineReminder.text is a function (mode-aware)", () => {
		expect(typeof SPICY.disciplineReminder?.text).toBe("function")
	})

	it("disciplineReminder.text('single') returns the full nudge text", () => {
		const text = SPICY.disciplineReminder?.text
		const result = typeof text === "function" ? text("single") : text
		expect(result).toBe(DISCIPLINE_NUDGE_TEXT)
	})

	it("disciplineReminder.everyPrompts is 4", () => {
		expect(SPICY.disciplineReminder?.everyPrompts).toBe(4)
	})

	it("name is 'spicy'", () => {
		expect(SPICY.name).toBe(SPICY_NAME)
		expect(SPICY_NAME).toBe("spicy")
	})

	it("tagline is 'spicy architect'", () => {
		expect(SPICY.tagline).toBe("spicy architect")
	})

	it("suppressBashToolGuard is true", () => {
		expect(SPICY.suppressBashToolGuard).toBe(true)
	})

	it("suppressExplorationGuard is true", () => {
		expect(SPICY.suppressExplorationGuard).toBe(true)
	})

	it("transformAgents is defined", () => {
		expect(SPICY.transformAgents).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// C) buildSystemPrompt DEFAULT path: snapshot + stock markers
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

	it("preserves the original tool descriptions unchanged", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).toContain("ORIGINAL read description")
		expect(result).toContain("ORIGINAL bash description")
		expect(result).toContain("ORIGINAL edit description")
	})
})

// ---------------------------------------------------------------------------
// D) buildSystemPrompt with variantName "spicy"
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

	it("contains '### Output style' from the spicy guidelines body", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("### Output style")
	})

	it("orchestrator mode contains 'Orchestrate the work'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("Orchestrate the work")
	})

	it("rewrites the 'read' tool description: output contains cat/head/tail and NOT the original", () => {
		const result = buildSystemPrompt({
			tools: [{ name: "read", description: "ORIGINAL" }],
			env: testEnv,
			mode: "orchestrator",
			variantName: "spicy",
		})
		expect(result).toContain("cat/head/tail")
		expect(result).not.toContain("ORIGINAL")
	})

	it("skillsTransform excludes superpowersSkill and includes harnessSkill", () => {
		const result = buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "orchestrator",
			skills: [superpowersSkill, harnessSkill],
			variantName: "spicy",
		})
		expect(result).not.toContain(superpowersSkill.filePath)
		expect(result).toContain(harnessSkill.filePath)
	})

	it("output does not reference Claude or Anthropic brand names", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toMatch(/claude|anthropic/i)
	})

	it("output does not contain internal tooling references", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toMatch(/kubecast|jira|kubectl/i)
		expect(result).not.toContain(".claude")
	})

	it("does NOT contain the stock AI coding agent intro", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).not.toContain("You are Kimchi, an AI coding agent.")
	})

	it("single-mode: uses single intro text and NOT 'Orchestrate the work'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "spicy" })
		expect(result).toContain("You are Kimchi, an interactive command-line coding agent")
		expect(result).not.toContain("Orchestrate the work")
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

	it("passing variantName 'default' produces the same output as omitting variantName", () => {
		const withDefault = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", variantName: "default" })
		const withoutVariant = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(withDefault).toBe(withoutVariant)
	})

	it("spicy full prompt (orchestrator mode) matches snapshot", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toMatchSnapshot()
	})

	// Completion guidance assertions
	it("SPICY.guidelines contains the completion guidance anchor", () => {
		const combined = `${GUIDELINES}${OPINIONATED_BLOCK}`
		expect(combined).toContain("See the task through to completion")
		expect(combined).toMatch(/original requirements/i)
	})

	it("SPICY.guidelines contains '### Working discipline'", () => {
		const combined = `${GUIDELINES}${OPINIONATED_BLOCK}`
		expect(combined).toContain("### Working discipline")
	})
})

// ---------------------------------------------------------------------------
// E) skillsTransform: default variant leaves skills untouched; spicy drops the
//    superpowers vendor pack
// ---------------------------------------------------------------------------

/** Minimal Skill stub: only filePath and baseDir are exercised by the filter. */
function makeSkill(filePath: string, baseDir: string): Skill {
	return {
		name: "stub",
		description: "stub",
		filePath,
		baseDir,
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	}
}

const superpowersSkill = makeSkill(
	"/home/u/.config/kimchi/vendor/superpowers/skills/brainstorming/SKILL.md",
	"/home/u/.config/kimchi/vendor/superpowers/skills/brainstorming",
)

const harnessSkill = makeSkill(
	"/home/u/.config/kimchi/harness/skills/daily/SKILL.md",
	"/home/u/.config/kimchi/harness/skills/daily",
)

const otherSkill = makeSkill(
	"/home/u/.config/kimchi/harness/skills/jira-create/SKILL.md",
	"/home/u/.config/kimchi/harness/skills/jira-create",
)

describe("skillsTransform", () => {
	it("DEFAULT_VARIANT has no skillsTransform", () => {
		expect(DEFAULT_VARIANT.skillsTransform).toBeUndefined()
	})

	it("SPICY defines skillsTransform", () => {
		expect(SPICY.skillsTransform).toBeDefined()
	})

	it("spicy skillsTransform removes a skill whose filePath contains /superpowers/", () => {
		if (!SPICY.skillsTransform) throw new Error("skillsTransform not defined on SPICY")
		const result = SPICY.skillsTransform([superpowersSkill, harnessSkill])
		expect(result).not.toContain(superpowersSkill)
	})

	it("spicy skillsTransform keeps a normal harness skill", () => {
		if (!SPICY.skillsTransform) throw new Error("skillsTransform not defined on SPICY")
		const result = SPICY.skillsTransform([superpowersSkill, harnessSkill])
		expect(result).toContain(harnessSkill)
	})

	it("spicy skillsTransform keeps a skill with no superpowers in filePath or baseDir", () => {
		if (!SPICY.skillsTransform) throw new Error("skillsTransform not defined on SPICY")
		const result = SPICY.skillsTransform([superpowersSkill, otherSkill])
		expect(result).toContain(otherSkill)
		expect(result).not.toContain(superpowersSkill)
	})

	it("spicy skillsTransform filters by baseDir as well as filePath", () => {
		if (!SPICY.skillsTransform) throw new Error("skillsTransform not defined on SPICY")
		const skillWithSuperpowersBase = makeSkill("/some/path/SKILL.md", "/home/u/vendor/superpowers/skills/brainstorm")
		const result = SPICY.skillsTransform([skillWithSuperpowersBase])
		expect(result).toHaveLength(0)
	})

	it("default variant passes all skills through; spicy drops superpowers but keeps harness skills", () => {
		const skills = [superpowersSkill, harnessSkill]

		const defaultResult = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single", skills })
		expect(defaultResult).toContain(superpowersSkill.filePath)
		expect(defaultResult).toContain(harnessSkill.filePath)

		const spicyResult = buildSystemPrompt({
			tools: fakeTools,
			env: testEnv,
			mode: "single",
			skills,
			variantName: "spicy",
		})
		expect(spicyResult).not.toContain(superpowersSkill.filePath)
		expect(spicyResult).toContain(harnessSkill.filePath)
	})
})

// ---------------------------------------------------------------------------
// F) Guard suppression flags
// ---------------------------------------------------------------------------

describe("guard suppression flags", () => {
	it("SPICY.suppressBashToolGuard is true", () => {
		expect(SPICY.suppressBashToolGuard).toBe(true)
	})

	it("SPICY.suppressExplorationGuard is true", () => {
		expect(SPICY.suppressExplorationGuard).toBe(true)
	})

	it("DEFAULT_VARIANT.suppressBashToolGuard is undefined", () => {
		expect(DEFAULT_VARIANT.suppressBashToolGuard).toBeUndefined()
	})

	it("DEFAULT_VARIANT.suppressExplorationGuard is undefined", () => {
		expect(DEFAULT_VARIANT.suppressExplorationGuard).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// G) todoSteer flag
// ---------------------------------------------------------------------------

describe("todoSteer flag", () => {
	it("DEFAULT_VARIANT.todoSteer is undefined (nudge stays on)", () => {
		expect(DEFAULT_VARIANT.todoSteer).toBeUndefined()
	})

	it("SPICY.todoSteer is undefined (cleanup nudge active for all variants)", () => {
		expect(SPICY.todoSteer).toBeUndefined()
	})

	it("spicy todos block contains 'Use a todo list when:'", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
		expect(result as string).toContain("Use a todo list when:")
	})

	it("spicy todos block contains 'Skip it when:'", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
		expect(result as string).toContain("Skip it when:")
	})

	it("spicy todos block contains 'even when those steps are linear'", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
		expect(result as string).toContain("even when those steps are linear")
	})

	it("spicy todos block contains 'complex or large'", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
		expect(result as string).toContain("complex or large")
	})

	it("spicy todos block contains 'clear the list with `clear_todos`'", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "todos", id: "todo-guidance", content: "x" })
		expect(result as string).toContain("clear the list with `clear_todos`")
	})
})

// ---------------------------------------------------------------------------
// H) AGENT_DISCIPLINE_BLOCK content
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
// I) AGENT_ROLE_TUNING key guard: every key must match a real DEFAULT_AGENTS name
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
// J) guidelinesFor: mode-aware guidelines
// ---------------------------------------------------------------------------

describe("guidelinesFor", () => {
	it("single mode contains '**Coordinator and delegation**'", () => {
		expect(guidelinesFor("single")).toContain("**Coordinator and delegation**")
	})

	it("subagent mode contains '**Coordinator and delegation**'", () => {
		expect(guidelinesFor("subagent")).toContain("**Coordinator and delegation**")
	})

	it("orchestrator mode does NOT contain '**Coordinator and delegation**'", () => {
		expect(guidelinesFor("orchestrator")).not.toContain("**Coordinator and delegation**")
	})

	it("orchestrator mode DOES contain '**Coordinator altitude**'", () => {
		expect(guidelinesFor("orchestrator")).toContain("**Coordinator altitude**")
	})

	it("single mode does NOT contain '**Coordinator altitude**'", () => {
		expect(guidelinesFor("single")).not.toContain("**Coordinator altitude**")
	})

	it("both single and orchestrator contain '### Output style'", () => {
		expect(guidelinesFor("single")).toContain("### Output style")
		expect(guidelinesFor("orchestrator")).toContain("### Output style")
	})

	it("both single and orchestrator contain '### Working discipline'", () => {
		expect(guidelinesFor("single")).toContain("### Working discipline")
		expect(guidelinesFor("orchestrator")).toContain("### Working discipline")
	})

	it("single mode: GUIDELINES + OPINIONATED_BLOCK === guidelinesFor('single') (byte-identity)", () => {
		expect(GUIDELINES + OPINIONATED_BLOCK).toBe(guidelinesFor("single"))
	})

	it("OPINIONATED_BLOCK still contains the coordinator bullets (byte-identity preserved)", () => {
		expect(OPINIONATED_BLOCK).toContain(COORDINATOR_DELEGATION_BLOCK)
	})

	it("orchestrator mode uses OPINIONATED_BLOCK_ORCHESTRATOR", () => {
		expect(guidelinesFor("orchestrator")).toBe(GUIDELINES + OPINIONATED_BLOCK_ORCHESTRATOR)
	})
})

// ---------------------------------------------------------------------------
// K) disciplineNudgeFor: mode-aware nudge
// ---------------------------------------------------------------------------

describe("disciplineNudgeFor", () => {
	it("single mode returns the full DISCIPLINE_NUDGE_TEXT", () => {
		expect(disciplineNudgeFor("single")).toBe(DISCIPLINE_NUDGE_TEXT)
	})

	it("subagent mode returns the full DISCIPLINE_NUDGE_TEXT", () => {
		expect(disciplineNudgeFor("subagent")).toBe(DISCIPLINE_NUDGE_TEXT)
	})

	it("orchestrator mode does NOT contain 'default to delegating'", () => {
		expect(disciplineNudgeFor("orchestrator")).not.toContain("default to delegating")
	})

	it("orchestrator mode starts with 'Working-discipline check:'", () => {
		expect(disciplineNudgeFor("orchestrator")).toMatch(/^Working-discipline check:/)
	})

	it("orchestrator mode contains a core marker from DISCIPLINE_NUDGE_CORE (test honesty)", () => {
		expect(disciplineNudgeFor("orchestrator")).toContain("never delete or bend a passing test")
	})

	it("PREFIX + DELEGATION + CORE === DISCIPLINE_NUDGE_TEXT (byte-identity of parts)", () => {
		expect(DISCIPLINE_NUDGE_PREFIX + DISCIPLINE_NUDGE_DELEGATION + DISCIPLINE_NUDGE_CORE).toBe(DISCIPLINE_NUDGE_TEXT)
	})
})

// ---------------------------------------------------------------------------
// L) RULES_BLOCK contains README bullet
// ---------------------------------------------------------------------------

describe("RULES_BLOCK", () => {
	it("contains the README/summary bullet", () => {
		expect(RULES_BLOCK).toContain("add a short user-facing README or summary")
	})
})

// ---------------------------------------------------------------------------
// N) Mode-aware rules block (blockRewriter / rewriteBlock)
// ---------------------------------------------------------------------------

// Stable substring markers used throughout this section.
const MARKER_BOUND_OUTPUT = "Bound tool output at the source"
const MARKER_REREAD = "Re-read before editing"
const MARKER_README = "user-facing README or summary"

describe("mode-aware rules block (blockRewriter)", () => {
	const rulesBlock = { owner: "behaviours", id: "rules", content: "x" }

	it("single mode: rules block contains all three discipline markers", () => {
		const result = blockRewriter(rulesBlock, "single")
		expect(typeof result).toBe("string")
		expect(result as string).toContain(MARKER_BOUND_OUTPUT)
		expect(result as string).toContain(MARKER_REREAD)
		expect(result as string).toContain(MARKER_README)
	})

	it("orchestrator mode: rules block contains bound-output marker but NOT re-read or README markers", () => {
		const result = blockRewriter(rulesBlock, "orchestrator")
		expect(typeof result).toBe("string")
		expect(result as string).toContain(MARKER_BOUND_OUTPUT)
		expect(result as string).not.toContain(MARKER_REREAD)
		expect(result as string).not.toContain(MARKER_README)
	})

	it("subagent mode: rules block matches orchestrator, contains bound-output only", () => {
		const result = blockRewriter(rulesBlock, "subagent")
		expect(typeof result).toBe("string")
		expect(result as string).toContain(MARKER_BOUND_OUTPUT)
		expect(result as string).not.toContain(MARKER_REREAD)
		expect(result as string).not.toContain(MARKER_README)
	})

	it("RULES_BLOCK (full, single) contains bound-output section before re-read section", () => {
		const boundPos = RULES_BLOCK.indexOf(MARKER_BOUND_OUTPUT)
		const rereadPos = RULES_BLOCK.indexOf(MARKER_REREAD)
		expect(boundPos).toBeGreaterThan(-1)
		expect(rereadPos).toBeGreaterThan(-1)
		expect(boundPos).toBeLessThan(rereadPos)
	})

	it("RULES_BLOCK (full) is the output of blockRewriter in single mode", () => {
		const result = blockRewriter(rulesBlock, "single")
		expect(result).toBe(RULES_BLOCK)
	})

	it("RULES_BLOCK_ORCHESTRATOR (slim) is the output of blockRewriter in orchestrator mode", () => {
		const result = blockRewriter(rulesBlock, "orchestrator")
		expect(result).toBe(RULES_BLOCK_ORCHESTRATOR)
	})

	it("RULES_BLOCK_ORCHESTRATOR does not contain re-read or README markers (slim, no those sections)", () => {
		expect(RULES_BLOCK_ORCHESTRATOR).not.toContain(MARKER_REREAD)
		expect(RULES_BLOCK_ORCHESTRATOR).not.toContain(MARKER_README)
	})
})

describe("spicy buildSystemPrompt mode-aware rules content", () => {
	// The behaviours/rules block is injected by renderSystemPromptBlocks only when
	// a session-registered block is present. buildSystemPrompt does not inject it
	// directly, so we assert via blockRewriter (the direct path) for mode awareness,
	// and use buildSystemPrompt only to confirm the spicy-vs-default boundary.
	// See "mode-aware rules block" describe above for the direct blockRewriter tests.
	it("spicy single: rewriteBlock called with 'single' mode contains all three markers", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "behaviours", id: "rules", content: "x" }, "single")
		expect(result as string).toContain(MARKER_BOUND_OUTPUT)
		expect(result as string).toContain(MARKER_REREAD)
		expect(result as string).toContain(MARKER_README)
	})

	it("spicy orchestrator: rewriteBlock called with 'orchestrator' mode omits re-read and README", () => {
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "behaviours", id: "rules", content: "x" }, "orchestrator")
		expect(result as string).toContain(MARKER_BOUND_OUTPUT)
		expect(result as string).not.toContain(MARKER_REREAD)
		expect(result as string).not.toContain(MARKER_README)
	})
})

describe("default variant spicy phrasings absent guard", () => {
	it("default single prompt does NOT contain 'Bound tool output at the source'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain(MARKER_BOUND_OUTPUT)
	})

	it("default orchestrator prompt does NOT contain 'Bound tool output at the source'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain(MARKER_BOUND_OUTPUT)
	})

	it("default single prompt does NOT contain 'Re-read before editing'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain(MARKER_REREAD)
	})

	it("default orchestrator prompt does NOT contain 'Re-read before editing'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain(MARKER_REREAD)
	})

	it("default single prompt does NOT contain 'user-facing README or summary'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain(MARKER_README)
	})

	it("default orchestrator prompt does NOT contain 'user-facing README or summary'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain(MARKER_README)
	})
})

// ---------------------------------------------------------------------------
// M) Default variant byte-identical guard
// ---------------------------------------------------------------------------

describe("default variant byte-identical guard", () => {
	it("default single prompt does NOT contain '**Coordinator altitude**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain("**Coordinator altitude**")
	})

	it("default orchestrator prompt does NOT contain '**Coordinator altitude**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain("**Coordinator altitude**")
	})

	it("default single prompt does NOT contain the README/summary bullet", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "single" })
		expect(result).not.toContain("add a short user-facing README or summary")
	})

	it("default orchestrator prompt does NOT contain the README/summary bullet", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator" })
		expect(result).not.toContain("add a short user-facing README or summary")
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

	it("spicy orchestrator prompt DOES contain '**Coordinator altitude**'", () => {
		const result = buildSystemPrompt({ tools: fakeTools, env: testEnv, mode: "orchestrator", variantName: "spicy" })
		expect(result).toContain("**Coordinator altitude**")
	})

	it("spicy RULES_BLOCK contains the README/summary bullet (injected via rewriteBlock)", () => {
		// RULES_BLOCK is injected via rewriteBlock on the behaviours/rules block.
		// It does not appear in buildSystemPrompt without a registered session block.
		// Test directly on RULES_BLOCK to confirm the bullet is present.
		if (!SPICY.rewriteBlock) throw new Error("rewriteBlock not defined on SPICY")
		const result = SPICY.rewriteBlock({ owner: "behaviours", id: "rules", content: "x" })
		expect(typeof result).toBe("string")
		expect(result as string).toContain("add a short user-facing README or summary")
	})
})
