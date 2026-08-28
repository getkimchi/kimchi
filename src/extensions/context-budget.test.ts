/**
 * Token-budget CI (token-optimization initiative, plan Chunk 4 + Phase 1 Chunk 1).
 *
 * Assembles canonical context surfaces and fails when they grow past committed
 * budgets. Three surfaces are measured deterministically:
 *
 * 1. The kimchi system prompt for a single-model session, built through the real
 *    `buildSystemPrompt` (prompt-construction) with fixed inputs — fixed env, fixed
 *    tool list, fixed project-context fixture, no session-scoped blocks. This trips
 *    when orchestration text, sections, or upstream-bump-driven assembly grows.
 * 2. Kimchi's shipped skills catalog (frontmatter name+description of every skill in
 *    resources/skills — the only part of a skill that lands in the prompt).
 * 3. The canonical tool surface: every builtin + kimchi-extension tool definition a
 *    default session advertises, measured without a running harness via
 *    context-budget-tools.ts (deliberate exclusions are named there and drift into
 *    a failure when a "headlessly-unrenderable" module starts rendering).
 *
 * Token counts are an estimator (chars/4), same convention as the context-assembly
 * extension, so journal entries and budgets share units.
 *
 * Initial budgets recorded 2026-08-26: system prompt 4341 est, skills catalog 68 est
 * (slice headroom ~10%). Tool-surface budgets recorded 2026-08-27 from this exact
 * measurement. Raise budgets deliberately in the PR that grows the surface —
 * never as a drive-by.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { measureCanonicalToolSurface } from "./context-budget-tools.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./prompt-construction/system-prompt.js"

const CHARS_PER_TOKEN = 4

/** Budget slices (estimated tokens). Headroom over the recorded baseline below. */
const BUDGET = {
	/** buildSystemPrompt with the canonical single-mode options below. */
	systemPrompt: 4800,
	/** Sum of name + description chars across resources/skills frontmatter. */
	skillsCatalog: 80,
	/** Total canonical system-prompt + skills surface. */
	total: 4900,
	/** Total canonical tool surface (recorded 2026-08-28 post-Chunk-3: 8357 est across
	 *  33 tools after the DAP session-tool deferral; ~4% headroom). */
	toolSurface: 8700,
	/** Per-tool cap: any single tool above this many est tokens must be deliberate. */
	singleTool: 1400,
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
	it("canonical prompt + skills surfaces stay within committed token budgets", () => {
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
			`system prompt grew beyond budget\n${breakdown}\nTo fix: shrink the prompt, or raise BUDGET.systemPrompt deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.systemPrompt)
		expect(
			skillsTokens,
			`skills catalog grew beyond budget\n${breakdown}\nTo fix: shorten skill names/descriptions, or raise BUDGET.skillsCatalog deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.skillsCatalog)
		expect(
			total,
			`canonical prompt + skills surface grew beyond budget\n${breakdown}\nTo fix: shrink a slice, or raise BUDGET.total deliberately in this PR.`,
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

	it("canonical tool surface stays within committed token budgets", async () => {
		const { tools, exclusions } = await measureCanonicalToolSurface()

		const total = tools.reduce((sum, tool) => sum + tool.tokensEstimated, 0)
		const breakdown = [
			`tool surface: ${total} est tokens (budget ${BUDGET.toolSurface}) across ${tools.length} tools`,
			...tools.map(
				(tool) =>
					`    ${tool.name}: ~${tool.tokensEstimated} est (desc ${tool.descriptionChars}, schema ${tool.schemaChars}, ${tool.source})`,
			),
			...exclusions.map((exclusion) => `    excluded: ${exclusion.source} — ${exclusion.reason}`),
		].join("\n")

		const oversized = tools.filter((tool) => tool.tokensEstimated > BUDGET.singleTool)
		expect(
			oversized.map((tool) => tool.name),
			`tool(s) exceeded the per-tool cap of ${BUDGET.singleTool} est tokens\n${breakdown}\nTo fix: diet the definition, or raise BUDGET.singleTool deliberately in this PR.`,
		).toEqual([])

		expect(
			total,
			`canonical tool surface grew beyond budget\n${breakdown}\nTo fix: shrink definitions, gate/defer availability, or raise BUDGET.toolSurface deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.toolSurface)
	})
})
