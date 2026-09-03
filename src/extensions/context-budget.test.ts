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
import { describe, expect, it, vi } from "vitest"
import { measureCanonicalToolSurface } from "./context-budget-tools.js"

// Pin the mcp-adapter to zero configured servers (token-optimization Phase 1
// Chunk 5): with no servers the adapter registers nothing, so the canonical
// surface must not depend on the ambient machine's mcp.json. The metadata
// cache is stubbed too — with zero servers the factory would otherwise purge
// and rewrite the developer machine's real mcp-cache.json.
vi.mock("./mcp-adapter/config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mcp-adapter/config.js")>()
	return {
		...original,
		loadMcpConfig: () => ({ config: { mcpServers: {} }, warnings: [] }),
	}
})
vi.mock("./mcp-adapter/metadata-cache.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mcp-adapter/metadata-cache.js")>()
	return {
		...original,
		loadMetadataCache: () => undefined,
		overwriteMetadataCache: () => {},
		flushMetadataCache: () => {},
	}
})

import { withPrintGate } from "./print-mode.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./prompt-construction/system-prompt.js"

vi.mock("./multi-model.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./multi-model.js")>()
	return { ...actual, resolveMultiModelEnabled: () => ({ value: false, source: "cli" }) }
})

const CHARS_PER_TOKEN = 4

/** Budget slices (estimated tokens). Headroom over the recorded baseline below. */
const BUDGET = {
	/** buildSystemPrompt with the canonical single-mode options below. */
	systemPrompt: 4800,
	/** Sum of name + description chars across resources/skills frontmatter. */
	skillsCatalog: 80,
	/** Total canonical system-prompt + skills surface. */
	total: 4900,
	/** Total canonical tool surface (recorded 2026-08-28 post-Chunk-6: 6764 est across
	 *  26 tools after the DAP session-tool + bash_control deferrals, the mcp
	 *  zero-server registration gate, and the lsp no-server detection gate;
	 *  ~5% headroom). Dev sessions in a repo WITH a detected language server will
	 *  exceed this by the five gated lsp_* tools (~666 est) — that is by design,
	 *  see LSP_TOOL_NAMES in lsp.ts. */
	toolSurface: 7100,
	/** Print-mode slice (recorded 2026-08-28 post-Chunk-7: 6021 est across 24
	 *  tools — the canonical surface minus questionnaire (526) and set_phase
	 *  (217), which the registration gates drop in headless --print runs;
	 *  ~5% headroom). */
	printToolSurface: 6300,
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

	it("print-mode slice drops interactive/ferment-mode tools (token-optimization Chunk 7)", async () => {
		const { tools } = await withPrintGate({ print: true }, () => measureCanonicalToolSurface())

		const names = new Set(tools.map((tool) => tool.name))
		// The interactive surface is the canonical 26-tool set above; in print
		// mode the registration gates must remove exactly these two.
		expect(names.has("questionnaire"), "questionnaire must be gated out of --print sessions").toBe(false)
		expect(names.has("set_phase"), "set_phase must be gated out of --print sessions").toBe(false)
		expect(tools.length).toBe(24)

		const total = tools.reduce((sum, tool) => sum + tool.tokensEstimated, 0)
		expect(
			total,
			`print-mode tool surface exceeded budget\nprint surface: ${total} est (budget ${BUDGET.printToolSurface}) across ${tools.length} tools\nTo fix: shrink definitions or raise BUDGET.printToolSurface deliberately in this PR.`,
		).toBeLessThanOrEqual(BUDGET.printToolSurface)
	})
})
