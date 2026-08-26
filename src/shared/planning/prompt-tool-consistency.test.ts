/**
 * Invariant: a prompt must not name a tool the model cannot call in that context.
 *
 * Tool availability has two layers, and prose is written against neither:
 *   1. visibility — `getToolsForProfile(profile)` feeds `pi.setActiveTools()`
 *   2. permission — the gate in `permissions/index.ts`, which runs afterwards
 * A tool hidden at layer 1 cannot be resurrected at layer 2, so prose that
 * instructs a hidden tool is an instruction the model cannot follow.
 *
 * This is an invariant rather than a snapshot: it fails when a tool leaves a
 * profile while prose still references it, and when prose gains a reference to
 * a tool the profile never had.
 */

import { describe, expect, it } from "vitest"
import { buildPlannerSupplement } from "../../extensions/ferment/prompt-block.js"
import { DEFAULT_PLAN_GUIDELINES } from "../../extensions/orchestration/model-registry/guidelines/default-role-guidelines.js"
import planModeSupplement from "../../extensions/permissions/prompts/plan-mode-supplement.js"
import type { Ferment } from "../../ferment/types.js"
import {
	ADHOC_MODE_TOOLS,
	FERMENT_MODE_TOOLS,
	getToolsForProfile,
	SHARED_CORE_TOOLS,
	type ToolProfile,
	WRITE_TOOLS,
} from "./tool-catalog.js"

/** Every tool name the catalog knows about, across all profiles. */
const ALL_TOOL_NAMES: string[] = [...SHARED_CORE_TOOLS, ...ADHOC_MODE_TOOLS, ...FERMENT_MODE_TOOLS, ...WRITE_TOOLS].map(
	(t) => t.name,
)

/**
 * Tool names that are also ordinary English verbs. Prompts use them
 * constantly as prose ("read the user's intent", "write the plan"), so they
 * only count as a tool reference when backticked. Every other tool name —
 * `questionnaire`, `web_search`, `Agent`, `activate_ferment_phase` — is
 * unambiguous and counts bare, which is how these prompts actually write them.
 */
const AMBIGUOUS_WITH_ENGLISH = new Set(["read", "write", "edit", "find", "ls", "bash", "grep"])

function isAmbiguousInProse(name: string): boolean {
	return AMBIGUOUS_WITH_ENGLISH.has(name)
}

function mentionsTool(prompt: string, name: string): boolean {
	if (prompt.includes(`\`${name}\``)) return true
	if (isAmbiguousInProse(name)) return false
	return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(prompt)
}

function toolNamesMentioned(prompt: string): string[] {
	return ALL_TOOL_NAMES.filter((name) => mentionsTool(prompt, name))
}

function availableToolNames(profile: ToolProfile): Set<string> {
	return new Set(getToolsForProfile(profile).map((t) => t.name))
}

function makeFerment(): Ferment {
	return {
		id: "f-test",
		name: "Test ferment",
		status: "planned",
		goal: "Test goal",
		worktree: { path: "/tmp/f-test", branch: "main", baseBranch: "main" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	} as unknown as Ferment
}

function assertNoHiddenToolsNamed(prompt: string, profile: ToolProfile, label: string): void {
	const mentioned = toolNamesMentioned(prompt)

	// Guards against a vacuous pass if the prompt stops naming tools at all.
	expect(mentioned.length, `${label} names no known tools — detection is probably broken`).toBeGreaterThan(0)

	const available = availableToolNames(profile)
	const unavailable = mentioned.filter((name) => !available.has(name))
	expect(unavailable, `${label} names tools hidden in the "${profile}" profile: ${unavailable.join(", ")}`).toEqual([])
}

describe("prompt/tool consistency", () => {
	it("plan mode prose only names tools visible in planning-adhoc", () => {
		assertNoHiddenToolsNamed(planModeSupplement, "planning-adhoc", "plan-mode supplement")
	})

	// The ferment planner supplement deliberately documents the implementation
	// toolset while still in the planning phase ("the full toolset unlocks after
	// activate_ferment_phase"), so it is checked against the superset profile.
	// That still catches the case that matters: a tool named in prose that no
	// ferment profile grants at all — which is what a removed tool becomes.
	it("ferment planning prose only names tools that exist somewhere in the ferment lifecycle", () => {
		const prompt = buildPlannerSupplement(makeFerment(), "manual", false, "strict")
		assertNoHiddenToolsNamed(prompt, "implementation-ferment", "ferment planner supplement (strict)")
	})

	it("ferment planning prose in relaxed delegation mode names only ferment-lifecycle tools", () => {
		const prompt = buildPlannerSupplement(makeFerment(), "manual", false, "relaxed")
		assertNoHiddenToolsNamed(prompt, "implementation-ferment", "ferment planner supplement (relaxed)")
	})

	/**
	 * The forward check above cannot catch a *removed* tool: once a name leaves
	 * the catalog, a scan derived from the catalog stops looking for it, so
	 * prose still instructing it passes silently. That is exactly how a retired
	 * tool survives in a prompt.
	 *
	 * This is the other direction — an explicit list of names that must never
	 * appear in any prompt again. Add to it whenever a tool is retired.
	 */
	const RETIRED_TOOL_NAMES = ["set_phase"]

	const PROMPT_SOURCES: Array<[string, string]> = [
		["plan-mode supplement", planModeSupplement],
		["ferment planner supplement (strict)", buildPlannerSupplement(makeFerment(), "manual", false, "strict")],
		["ferment planner supplement (relaxed)", buildPlannerSupplement(makeFerment(), "manual", false, "relaxed")],
		["plan role guidelines", DEFAULT_PLAN_GUIDELINES],
	]

	for (const retired of RETIRED_TOOL_NAMES) {
		for (const [label, prompt] of PROMPT_SOURCES) {
			it(`${label} does not instruct the retired tool "${retired}"`, () => {
				expect(prompt).not.toContain(retired)
			})
		}
	}
})
