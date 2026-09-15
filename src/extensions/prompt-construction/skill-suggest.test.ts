import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	buildSkillReminder,
	contentWords,
	SKILL_SUGGEST_MAX,
	SKILL_SUGGEST_STRONG,
	SkillSuggester,
	suggestSkills,
} from "./skill-suggest.js"

function createSkill(overrides: Partial<Skill> & { name: string; description: string }): Skill {
	return {
		filePath: `/skills/${overrides.name}/SKILL.md`,
		baseDir: `/skills/${overrides.name}`,
		sourceInfo: {
			path: `/skills/${overrides.name}/SKILL.md`,
			source: "local",
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		...overrides,
	}
}

const VCS_WORKFLOW = createSkill({
	name: "vcs-workflow",
	description: "Safe and disciplined Git workflow — staging, committing, branching, and hook discipline.",
})

const PROOFREADER = createSkill({
	name: "ai-writing-proofreader",
	description:
		"Edit drafts into sharper, more human writing while preserving the writer's voice. Use when drafting, revising, or auditing any writing the user will share or publish: documentation, READMEs, articles, release notes.",
})

const DAP_DEBUGGING = createSkill({
	name: "dap-debugging",
	description:
		"Diagnose runtime state with persistent DAP debugger sessions — breakpoints, expression eval, and stepping across Go, Python, TypeScript/JavaScript, and native binaries.",
})

const ALL_SKILLS = [VCS_WORKFLOW, PROOFREADER, DAP_DEBUGGING]

describe("contentWords", () => {
	it("lowercases, drops stopwords and short tokens, and splits on hyphens", () => {
		expect(contentWords("The VCS-Workflow and git")).toEqual(["vcs", "workflow", "git"])
	})

	it("returns an empty array for stopword-only input", () => {
		expect(contentWords("the and with that")).toEqual([])
	})
})

describe("suggestSkills", () => {
	it("returns an empty list when nothing matches — the normal outcome", () => {
		expect(suggestSkills("fix the failing parser test in the lexer", ALL_SKILLS)).toEqual([])
	})

	it("returns an empty list for stopword-only or empty input", () => {
		expect(suggestSkills("", ALL_SKILLS)).toEqual([])
		expect(suggestSkills("the and with that", ALL_SKILLS)).toEqual([])
	})

	it("suggests the git skill for a commit-and-push request", () => {
		const result = suggestSkills("git commit and push these changes", ALL_SKILLS)
		expect(result.map((s) => s.name)).toEqual(["vcs-workflow"])
	})

	it("matches inflection variants via prefix (commit/committing)", () => {
		const result = suggestSkills("committing the staged work now", ALL_SKILLS)
		expect(result.map((s) => s.name)).toEqual(["vcs-workflow"])
	})

	it("matches write/writing and story/stories through suffix normalization", () => {
		// "writing" is not a prefix of "write" (the e drops in the -ing form),
		// so without suffix stripping the strongest skill signal — the leading
		// imperative verb — would never match.
		const result = suggestSkills("write a short story about kimchi", ALL_SKILLS)
		expect(result.map((s) => s.name)).toEqual(["ai-writing-proofreader"])
	})

	it("fires on a leading verb that matches the skill name (imperative prompts)", () => {
		// The user's canonical case: topic nouns (short, story, kimchi) match
		// nothing, but "write" matches the name token "writing" — the
		// leading-word rule treats that as half the signal.
		const result = suggestSkills("write a short story about kimchi", [PROOFREADER])
		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("ai-writing-proofreader")
		expect(result[0].score).toBeGreaterThanOrEqual(1)
	})

	it("accepts the leading-verb trade-off: a code task with the same verb also fires", () => {
		// "write a test" carries the identical verb signal as "write a story" —
		// token-level matching cannot separate them. The reminder is
		// non-directive, latched once per session, and the skill's own
		// description ("Do not load for code implementation") lets the model
		// self-reject — an accepted false positive, not a bug.
		const result = suggestSkills("write a test for the parser module", [PROOFREADER])
		expect(result.map((s) => s.name)).toEqual(["ai-writing-proofreader"])
	})

	it("double-counts name hits so a half-covered input with a name match passes the threshold", () => {
		// "vcs" matches the name, "workflow" matches the name too: full coverage
		// via name → score 2.0. A description-only half match (0.5) stays below.
		const result = suggestSkills("use the vcs workflow for this", ALL_SKILLS)
		expect(result.map((s) => s.name)).toEqual(["vcs-workflow"])
		expect(result[0].score).toBeGreaterThanOrEqual(SKILL_SUGGEST_STRONG)
	})

	it("does not suggest on description-only partial coverage below the threshold", () => {
		// "read" only matches the description token "READMEs": coverage 1/3,
		// no name hit, and a leading word that matches only a DESCRIPTION token
		// gets no floor → 0.33, below threshold.
		expect(suggestSkills("read the config file first", ALL_SKILLS)).toEqual([])
	})

	it("excludes skills with disableModelInvocation", () => {
		const hidden = createSkill({
			name: "hidden-skill",
			description: "Run the git commit workflow",
			disableModelInvocation: true,
		})
		expect(suggestSkills("git commit and push", [hidden, VCS_WORKFLOW])).toHaveLength(1)
		expect(suggestSkills("git commit and push", [hidden])).toEqual([])
	})

	it("caps suggestions at SKILL_SUGGEST_MAX, highest score first", () => {
		const a = createSkill({ name: "alpha", description: "deploy the kubernetes helm chart release" })
		const b = createSkill({ name: "beta", description: "deploy the helm release to kubernetes namespace" })
		const c = createSkill({ name: "gamma", description: "kubernetes helm chart release deploy notes" })
		const result = suggestSkills("deploy the helm chart release to kubernetes", [a, b, c])
		expect(result).toHaveLength(SKILL_SUGGEST_MAX)
		expect(result[0].score).toBeGreaterThanOrEqual(result[1].score)
	})

	it("is deterministic on score ties (name ascending)", () => {
		const a = createSkill({ name: "zzz-deploy", description: "deploy the app to production" })
		const b = createSkill({ name: "aaa-deploy", description: "ship the app to production" })
		const result = suggestSkills("deploy to production", [a, b])
		expect(result.map((s) => s.name)).toEqual(["aaa-deploy", "zzz-deploy"])
	})
})

describe("SkillSuggester", () => {
	it("suggests each skill at most once per session (latch)", () => {
		const suggester = new SkillSuggester()
		suggester.updateSkills(ALL_SKILLS)

		const first = suggester.suggest("git commit and push these changes")
		expect(first.suggestions.map((s) => s.name)).toEqual(["vcs-workflow"])
		expect(first.latched).toBe(0)

		const second = suggester.suggest("commit and push the git changes now")
		expect(second.suggestions).toEqual([])
		expect(second.latched).toBe(1)
	})

	it("re-arms the latch when a later input matches strongly", () => {
		const suggester = new SkillSuggester()
		suggester.updateSkills(ALL_SKILLS)

		// Weak-ish pass: 1/2 tokens via description ("git" alone after
		// dedupe is covered by the description) — any score ≥ threshold
		// latches, so use a description-only match first.
		const first = suggester.suggest("git hooks for the pipeline")
		expect(first.suggestions.map((s) => s.name)).toEqual(["vcs-workflow"])

		// Strong repeat: name-token hit doubles the score past STRONG.
		const repeat = suggester.suggest("use the vcs workflow to manage git")
		expect(repeat.suggestions.map((s) => s.name)).toContain("vcs-workflow")
		expect(repeat.suggestions[0].score).toBeGreaterThanOrEqual(SKILL_SUGGEST_STRONG)
	})

	it("refreshes the inventory via updateSkills", () => {
		const suggester = new SkillSuggester()
		suggester.updateSkills([VCS_WORKFLOW])
		expect(suggester.suggest("debug this breakpoint with the debugger").suggestions).toEqual([])

		suggester.updateSkills(ALL_SKILLS)
		const result = suggester.suggest("set a breakpoint and inspect the debugger session state")
		expect(result.suggestions.map((s) => s.name)).toEqual(["dap-debugging"])
	})

	it("keeps the latch across inventory refreshes", () => {
		const suggester = new SkillSuggester()
		suggester.updateSkills([VCS_WORKFLOW])
		expect(suggester.suggest("git commit and push changes").suggestions).toHaveLength(1)

		suggester.updateSkills(ALL_SKILLS)
		expect(suggester.suggest("git commit and push changes").suggestions).toEqual([])
	})
})

describe("buildSkillReminder", () => {
	it("names the skill and the skill_view load mechanism without offering the read path", () => {
		const suggestions = suggestSkills("git commit and push these changes", ALL_SKILLS)
		expect(suggestions.map((s) => s.name)).toEqual(["vcs-workflow"])
		const reminder = buildSkillReminder(suggestions)
		expect(reminder).toContain("vcs-workflow")
		expect(reminder).toContain("skill_view")
		// The read path stays in the <available_skills> block's <location> —
		// offering it here too makes the model take the read shortcut.
		expect(reminder).not.toContain("read `")
	})

	it("leaves the decision to the model — no directive wording", () => {
		const suggestions = suggestSkills("git commit and push these changes", ALL_SKILLS)
		expect(suggestions).toHaveLength(1)
		const reminder = buildSkillReminder(suggestions)
		expect(reminder).toContain("your call")
		expect(reminder).not.toMatch(/must|always|required/i)
	})

	it("truncates long descriptions to keep the reminder cheap", () => {
		const verbose = createSkill({
			name: "verbose-git-skill",
			description:
				"Safe and disciplined Git workflow with staging and committing and branching and hook discipline plus signing and rebasing and cherry-picking and bisecting and worktrees",
		})
		const suggestions = suggestSkills("safe disciplined git staging committing", [verbose])
		expect(suggestions.map((s) => s.name)).toEqual(["verbose-git-skill"])
		const reminder = buildSkillReminder(suggestions)
		// Assert on the description segment between the em dash and the load
		// suffix, not the whole line — the suffix carries the fixed-length
		// skill_view/read guidance.
		const line = reminder.split("\n").find((l) => l.includes("verbose-git-skill")) ?? ""
		expect(line.length).toBeGreaterThan(0)
		const descriptionSegment = line.slice(line.indexOf("— ") + 2, line.indexOf(" (load with"))
		expect(descriptionSegment.length).toBeLessThanOrEqual(141) // 140 + ellipsis
		expect(descriptionSegment).toContain("…")
	})
})
