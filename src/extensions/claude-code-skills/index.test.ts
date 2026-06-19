import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ExtensionAPI, type ToolDefinition, loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import claudeCodeSkillsExtension from "./index.js"

let dir: string
let oldHome: string | undefined

describe("Claude Code skills extension", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skill-tool-"))
		oldHome = process.env.HOME
		process.env.HOME = join(dir, "home")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("registers a Claude-compatible Skill tool", () => {
		const { tools } = registerExtension()

		expect(tools).toHaveLength(1)
		expect(tools[0]).toMatchObject({
			name: "Skill",
			label: "Skill",
			promptSnippet: "Load a Claude Code skill by name",
		})
		expect(tools[0].prepareArguments?.({ name: "typescript-safety" })).toEqual({
			name: "typescript-safety",
			skill: "typescript-safety",
		})
	})

	it("loads a project Claude Code skill by name", async () => {
		const skillPath = join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md")
		writeSkill(skillPath, "Use generated types and avoid unsafe casts.")
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "typescript-safety" }, undefined, undefined, {
			cwd: join(dir, "project"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(textResult(result)).toContain('Loaded Skill("typescript-safety")')
		expect(textResult(result)).toContain("Use generated types")
		expect(result.details).toMatchObject({ success: true, name: "typescript-safety" })
		expect(result.details).not.toEqual({ success: true, name: "typescript-safety", filePath: skillPath })
	})

	it("does not load native skills through the Claude-compatible Skill tool", async () => {
		writeSkill(
			join(dir, "project", ".kimchi", "skills", "best-practices", "SKILL.md"),
			"Kimchi project skill instructions.",
		)
		writeSkill(
			join(dir, "project", ".agents", "skills", "best-practices", "SKILL.md"),
			"Project-native skill instructions.",
		)
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "best-practices" }, undefined, undefined, {
			cwd: join(dir, "project", "src", "feature"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(result.details).toEqual({
			success: false,
			name: "best-practices",
			error: 'Claude Code skill "best-practices" was not found.',
		})
		expect(textResult(result)).not.toContain("Kimchi project skill instructions.")
		expect(textResult(result)).not.toContain("Project-native skill instructions.")
	})

	it("loads Claude Code skills instead of native skills with the same name", async () => {
		writeSkill(
			join(dir, "project", ".kimchi", "skills", "best-practices", "SKILL.md"),
			"Kimchi project skill instructions.",
		)
		writeSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill instructions.")
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "best-practices" }, undefined, undefined, {
			cwd: join(dir, "project"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(textResult(result)).toContain("Claude skill instructions.")
		expect(textResult(result)).not.toContain("Kimchi project skill instructions.")
		expect(result.details).toMatchObject({ success: true, name: "best-practices" })
	})

	it("returns an error when the skill is missing", async () => {
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "missing" }, undefined, undefined, {
			cwd: join(dir, "project"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(result.details).toEqual({
			success: false,
			name: "missing",
			error: 'Claude Code skill "missing" was not found.',
		})
		expect(textResult(result)).toBe('Claude Code skill "missing" was not found.')
	})

	it("contributes sanitized Claude Code skills through resources_discover", async () => {
		writeRawSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.\n")
		const { handlers } = registerExtension()

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})
		const skillPaths = (result as { skillPaths?: string[] } | undefined)?.skillPaths ?? []

		expect(result).toMatchObject({
			skillPaths: [expect.stringContaining("kimchi-claude-code-skills-")],
		})
		const loaded = loadSkillsFromDir({ dir: skillPaths[0] ?? "", source: "path" })
		expect(loaded.skills).toMatchObject([
			{ name: "typescript-safety", description: "Claude Code skill: typescript-safety." },
		])
		expect(loaded.diagnostics.map((diagnostic) => diagnostic.message)).not.toContain("description is required")
	})

	it("contributes Claude Code skill resources even when native project skills use the same name", async () => {
		writeSkill(join(dir, "project", ".agents", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		writeSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use Claude skills.")
		const { handlers } = registerExtension()

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})
		const skillPaths = (result as { skillPaths?: string[] } | undefined)?.skillPaths ?? []

		expect(skillPaths).toHaveLength(1)
		const loaded = loadSkillsFromDir({ dir: skillPaths[0] ?? "", source: "path" })
		expect(loaded.skills).toMatchObject([{ name: "typescript-safety" }])
		expect(readSkill(skillPaths[0] ?? "")).toContain("Use Claude skills.")
	})

	it("skips startup Claude Code resources that duplicate configured native skills", async () => {
		writeSkill(join(dir, "project", ".agents", "skills", "best-practices", "SKILL.md"), "Native skill.")
		writeSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill.")
		const { handlers } = registerExtension([".agents/skills"])

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})

		expect(result).toBeUndefined()
	})

	it("contributes startup temp copies for configured Claude Code skills", async () => {
		writeRawSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill.\n")
		const { handlers } = registerExtension([".claude/skills"])

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})
		const skillPaths = (result as { skillPaths?: string[] } | undefined)?.skillPaths ?? []

		expect(skillPaths).toHaveLength(1)
		const loaded = loadSkillsFromDir({ dir: skillPaths[0] ?? "", source: "path" })
		expect(loaded.skills).toMatchObject([{ name: "best-practices", description: "Claude Code skill: best-practices." }])
	})
})

type RegisteredHandlers = {
	resources_discover?: (event: { type: "resources_discover"; cwd: string; reason: string }) => unknown
}

function registerExtension(configuredSkillPaths: string[] = []): {
	tools: ToolDefinition[]
	handlers: RegisteredHandlers
} {
	const tools: ToolDefinition[] = []
	const handlers: RegisteredHandlers = {}
	claudeCodeSkillsExtension(
		{
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: keyof RegisteredHandlers, handler: RegisteredHandlers[keyof RegisteredHandlers]) => {
				handlers[event] = handler
			},
		} as unknown as ExtensionAPI,
		configuredSkillPaths,
	)
	return { tools, handlers }
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0]
	return first?.type === "text" ? (first.text ?? "") : ""
}

function writeSkill(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `---\ndescription: Test skill.\n---\n${body}\n`, "utf-8")
}

function writeRawSkill(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content, "utf-8")
}

function readSkill(skillDir: string): string {
	return readFileSync(join(skillDir, "SKILL.md"), "utf-8")
}
