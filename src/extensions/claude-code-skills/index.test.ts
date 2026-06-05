import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import claudeCodeSkillsExtension from "./index.js"

let dir: string
let oldHome: string | undefined
let oldXdgCacheHome: string | undefined

describe("Claude Code skills extension", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skill-tool-"))
		oldHome = process.env.HOME
		oldXdgCacheHome = process.env.XDG_CACHE_HOME
		process.env.HOME = join(dir, "home")
		process.env.XDG_CACHE_HOME = join(dir, "cache")
	})

	afterEach(() => {
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldXdgCacheHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
			delete process.env.XDG_CACHE_HOME
		} else {
			process.env.XDG_CACHE_HOME = oldXdgCacheHome
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

	it("loads native project skills before user or Claude copies", async () => {
		const projectSkillPath = join(dir, "project", ".agents", "skills", "best-practices", "SKILL.md")
		writeSkill(projectSkillPath, "Project-native skill instructions.")
		writeSkill(join(dir, "home", ".agents", "skills", "best-practices", "SKILL.md"), "User-native skill instructions.")
		writeSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill instructions.")
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "best-practices" }, undefined, undefined, {
			cwd: join(dir, "project"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(textResult(result)).toContain("Project-native skill instructions.")
		expect(textResult(result)).not.toContain("User-native skill instructions.")
		expect(textResult(result)).not.toContain("Claude skill instructions.")
		expect(result.details).toEqual({ success: true, name: "best-practices", filePath: projectSkillPath })
	})

	it("loads ancestor native project skills from subdirectories before user or Claude copies", async () => {
		const projectSkillPath = join(dir, "project", ".agents", "skills", "best-practices", "SKILL.md")
		writeSkill(projectSkillPath, "Project-native skill instructions.")
		writeSkill(join(dir, "home", ".agents", "skills", "best-practices", "SKILL.md"), "User-native skill instructions.")
		writeSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill instructions.")
		const { tools } = registerExtension()

		const result = await tools[0].execute("call-1", { skill: "best-practices" }, undefined, undefined, {
			cwd: join(dir, "project", "src", "feature"),
			sessionManager: { getSessionId: () => "session-1" },
		} as never)

		expect(textResult(result)).toContain("Project-native skill instructions.")
		expect(textResult(result)).not.toContain("User-native skill instructions.")
		expect(textResult(result)).not.toContain("Claude skill instructions.")
		expect(result.details).toEqual({ success: true, name: "best-practices", filePath: projectSkillPath })
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
		writeSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		const { handlers } = registerExtension()

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})

		expect(result).toMatchObject({
			skillPaths: [expect.stringContaining(join(dir, "cache", "kimchi", "claude-code-skills"))],
		})
	})

	it("does not contribute Claude Code skill resources that duplicate native project skills", async () => {
		writeSkill(join(dir, "project", ".agents", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		writeSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		const { handlers } = registerExtension()

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})

		expect(result).toBeUndefined()
	})
})

type RegisteredHandlers = {
	resources_discover?: (event: { type: "resources_discover"; cwd: string; reason: string }) => unknown
}

function registerExtension(): { tools: ToolDefinition[]; handlers: RegisteredHandlers } {
	const tools: ToolDefinition[] = []
	const handlers: RegisteredHandlers = {}
	claudeCodeSkillsExtension({
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		on: (event: keyof RegisteredHandlers, handler: RegisteredHandlers[keyof RegisteredHandlers]) => {
			handlers[event] = handler
		},
	} as unknown as ExtensionAPI)
	return { tools, handlers }
}

function textResult(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0]
	return first?.type === "text" ? (first.text ?? "") : ""
}

function writeSkill(path: string, body: string): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `---\ndescription: Test skill.\n---\n${body}\n`, "utf-8")
}
