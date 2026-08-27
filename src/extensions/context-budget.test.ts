/**
 * Token-budget CI (token-optimization initiative, plan Chunk 4).
 *
 * Assembles a canonical slice of the context kimchi sends on a first request and fails
 * when it grows past committed budgets. Two surfaces are measured deterministically:
 *
 * 1. The kimchi system prompt for a single-model session, built through the real
 *    `buildSystemPrompt` (prompt-construction) with fixed inputs — fixed env, fixed
 *    tool list, fixed project-context fixture, no session-scoped blocks. This trips
 *    when orchestration text, sections, or upstream-bump-driven assembly grows.
 * 2. Kimchi's shipped skills catalog (frontmatter name+description of every skill in
 *    resources/skills — the only part of a skill that lands in the prompt).
 *
 * Token counts are an estimator (chars/4), same convention as the context-assembly
 * extension, so journal entries and budgets share units. Budgets carry headroom over
 * the recorded baseline and per-slice limits, so a failure names the fattening
 * section.
 *
 * Initial budgets recorded 2026-08-26 against this tree (baseline: system prompt
 * 4341 est, skills catalog 68 est, total 4409 est; ~10% headroom per slice and
 * total). Raise them deliberately in the PR that grows the surface — never as a
 * drive-by.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildSystemPrompt, type EnvironmentInfo } from "./prompt-construction/system-prompt.js"

const CHARS_PER_TOKEN = 4

/** Budget slices (estimated tokens). Headroom over the recorded baseline below. */
const BUDGET = {
	/** buildSystemPrompt with the canonical single-mode options below. */
	systemPrompt: 4800,
	/** Sum of name + description chars across resources/skills frontmatter. */
	skillsCatalog: 80,
	/** Total canonical surface. */
	total: 4900,
}

const FIXED_ENV: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.0.0",
	osVersion: "fixture",
	username: "budget",
	homeDir: "/home/budget",
	cwd: "/tmp/kimchi-context-budget",
	documentsDir: "/tmp/kimchi-context-budget/.kimchi/docs",
	localDate: "2026-08-26",
	isGitRepo: true,
}

const CANONICAL_TOOLS = [
	{ name: "read", description: "Read the contents of a file." },
	{ name: "bash", description: "Execute a bash command." },
	{ name: "edit", description: "Edit a single file using exact text replacement." },
	{ name: "write", description: "Write content to a file." },
]

const CANONICAL_CONTEXT_FILES = [
	{
		path: "AGENTS.md",
		content:
			"# Fixture\n\nRepresentative project instruction file for budget measurement. " +
			"Keep guidance short and high signal.",
	},
]

function estimateTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

function repoRoot(): string {
	// src/extensions/context-budget.test.ts -> repo root
	return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

function canonicalSurfaces() {
	const systemPrompt = buildSystemPrompt({
		tools: CANONICAL_TOOLS,
		env: FIXED_ENV,
		contextFiles: CANONICAL_CONTEXT_FILES,
		skills: [],
		mode: "single",
	})
	const skillsRoot = join(repoRoot(), "resources", "skills")
	const skills = readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => loadSkillFrontmatter(skillsRoot, entry.name))
	return { systemPrompt, skills }
}

interface SkillFrontmatter {
	file: string
	name: string
	description: string
}

/** Parse name/description frontmatter the same way the skills catalog consumes it. */
function loadSkillFrontmatter(skillDir: string, file: string): SkillFrontmatter {
	const content = readFileSync(join(skillDir, file, "SKILL.md"), "utf8")
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
	const fields = frontmatterMatch?.[1] ?? ""
	const name = /^name:\s*(.+)$/m.exec(fields)?.[1]?.trim() ?? file
	const description = /^description:\s*(.+)$/m.exec(fields)?.[1]?.trim() ?? ""
	return { file, name, description }
}

describe("context budget", () => {
	it("canonical surfaces stay within committed token budgets", () => {
		const { systemPrompt, skills } = canonicalSurfaces()

		const systemPromptTokens = estimateTokens(systemPrompt.length)
		const skillsTokens = skills.reduce(
			(sum, skill) => sum + estimateTokens(skill.name.length + skill.description.length),
			0,
		)
		const total = systemPromptTokens + skillsTokens

		const breakdown = [
			`system prompt: ${systemPromptTokens} est tokens (budget ${BUDGET.systemPrompt})`,
			`skills catalog: ${skillsTokens} est tokens (budget ${BUDGET.skillsCatalog}) across ${skills.length} skills`,
			...skills.map(
				(skill) => `    ${skill.file}: ~${estimateTokens(skill.name.length + skill.description.length)} est`,
			),
			`total:          ${total} est tokens (budget ${BUDGET.total})`,
		].join("\n")

		expect(
			systemPromptTokens,
			`system prompt grew beyond budget\n${breakdown}\nTo fix: shrink the prompt, or raise BUDGET deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.systemPrompt)
		expect(
			skillsTokens,
			`skills catalog grew beyond budget\n${breakdown}\nTo fix: shorten skill names/descriptions, or raise BUDGET deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.skillsCatalog)
		expect(
			total,
			`canonical context surface grew beyond budget\n${breakdown}\nTo fix: shrink a slice, or raise BUDGET deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.total)
	})

	it("skills catalog slices stay proportional (no single skill dominates)", () => {
		const { skills } = canonicalSurfaces()
		const total = skills.reduce((sum, skill) => sum + estimateTokens(skill.name.length + skill.description.length), 0)
		if (skills.length === 0) return
		const perSkillCap = Math.max(100, Math.ceil(total / skills.length) * 2)
		for (const skill of skills) {
			const tokens = estimateTokens(skill.name.length + skill.description.length)
			expect(
				tokens,
				`skill ${skill.file} uses ~${tokens} est tokens, above the ${perSkillCap} per-skill cap`,
			).toBeLessThanOrEqual(perSkillCap)
		}
	})
})
