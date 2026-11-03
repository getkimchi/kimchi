import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ExtensionAPI, loadSkillsFromDir, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import claudeCodeSkillsExtension from "./index.js"

let dir: string
let oldHome: string | undefined
let oldAgentDir: string | undefined
let oldEnableResources: string | undefined

describe("Claude Code skills extension", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-code-skill-tool-"))
		oldHome = process.env.HOME
		process.env.HOME = join(dir, "home")
		// Pin the resource-settings path to the temp home so bundled-skill
		// frontmatter gating sees defaults, not the developer's live settings.
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent-dir")
		oldEnableResources = process.env.KIMCHI_ENABLE_RESOURCES
		delete process.env.KIMCHI_ENABLE_RESOURCES
		// Project fixtures live under <dir>/project — trusted for the tests
		// that exercise project .claude/skills; fail-closed cases have their
		// own tests in definition.test.ts.
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(join(dir, "project"), true)
	})

	afterEach(() => {
		if (oldHome === undefined) {
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		if (oldAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		if (oldEnableResources === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
		else process.env.KIMCHI_ENABLE_RESOURCES = oldEnableResources
		rmSync(dir, { recursive: true, force: true })
	})

	it("registers a Claude-compatible Skill tool, gated on .claude skills existing", () => {
		writeSkill(join(dir, "home", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		// Discovery only serves a cwd that contains .claude (user skills are then
		// user-level); mirror the real reachability rule.
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		const { tools, fireSessionStart } = registerExtension()

		expect(tools).toHaveLength(0)
		fireSessionStart(join(dir, "project"))
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

	it("does not register the Skill tool when no .claude skills dir exists", () => {
		const { tools, fireSessionStart } = registerExtension()
		fireSessionStart(join(dir, "project"))
		expect(tools).toHaveLength(0)
	})

	it("does not register the Skill tool on an untrusted project's .claude/skills alone", () => {
		// Project .claude/skills is trust-gated; with the project untrusted and no
		// user-level skills, the tool must stay unregistered (fail closed).
		resetProjectScopeTrustForTests()
		writeSkill(join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md"), "Use generated types.")
		const { tools, fireSessionStart } = registerExtension()
		fireSessionStart(join(dir, "project"))
		expect(tools).toHaveLength(0)
	})

	it("loads a project Claude Code skill by name", async () => {
		const skillPath = join(dir, "project", ".claude", "skills", "typescript-safety", "SKILL.md")
		writeSkill(skillPath, "Use generated types and avoid unsafe casts.")
		const result = await registeredSkillTool(join(dir, "project")).execute(
			"call-1",
			{ skill: "typescript-safety" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

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
		writeSkill(join(dir, "home", ".claude", "skills", "typescript-safety", "SKILL.md"), "User skill.")
		mkdirSync(join(dir, "project", "src", "feature", ".claude"), { recursive: true })

		const result = await registeredSkillTool(join(dir, "project", "src", "feature")).execute(
			"call-1",
			{ skill: "best-practices" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project", "src", "feature"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

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

		const result = await registeredSkillTool(join(dir, "project")).execute(
			"call-1",
			{ skill: "best-practices" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

		expect(textResult(result)).toContain("Claude skill instructions.")
		expect(textResult(result)).not.toContain("Kimchi project skill instructions.")
		expect(result.details).toMatchObject({ success: true, name: "best-practices" })
	})

	it("returns an error when the skill is missing", async () => {
		writeSkill(join(dir, "home", ".claude", "skills", "typescript-safety", "SKILL.md"), "User skill.")
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })

		const result = await registeredSkillTool(join(dir, "project")).execute(
			"call-1",
			{ skill: "missing" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

		expect(result.details).toEqual({
			success: false,
			name: "missing",
			error: 'Claude Code skill "missing" was not found.',
		})
		expect(textResult(result)).toBe('Claude Code skill "missing" was not found.')
	})

	it("refuses a skill disabled by an enabled bundled skill, naming the declarer", async () => {
		writeSkill(join(dir, "home", ".claude", "skills", "pptx", "SKILL.md"), "Office skill instructions.")
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		// The bundled pptx skill is on by default (skills.pptx), and its
		// disables-skills frontmatter shadows the user-installed pptx skill.

		const result = await registeredSkillTool(join(dir, "project")).execute(
			"call-1",
			{ skill: "pptx" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

		expect(result.details).toMatchObject({ success: false, name: "pptx", disabledBy: "pptx" })
		expect(textResult(result)).toBe(
			'Claude Code skill "pptx" is unavailable: it is disabled by the enabled "pptx" skill.',
		)
		expect(textResult(result)).not.toContain("Office skill instructions.")
	})

	it("loads a skill shadowed by a bundled skill once the toggle is off", async () => {
		writeSkill(join(dir, "home", ".claude", "skills", "pptx", "SKILL.md"), "Office skill instructions.")
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		disablePptxSkill()

		const result = await registeredSkillTool(join(dir, "project")).execute(
			"call-1",
			{ skill: "pptx" },
			undefined,
			undefined,
			{
				cwd: join(dir, "project"),
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		)

		expect(result.details).toMatchObject({ success: true, name: "pptx" })
		expect(textResult(result)).toContain("Office skill instructions.")
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

	it("omits Claude Code skills disabled by an enabled bundled skill from discovery", async () => {
		writeRawSkill(join(dir, "home", ".claude", "skills", "pptx", "SKILL.md"), "Office skill instructions.\n")
		mkdirSync(join(dir, "project", ".claude"), { recursive: true })
		const { handlers } = registerExtension()

		// skills.pptx is on by default: the only Claude Code skill is shadowed →
		// nothing left to contribute.
		const disabled = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})
		expect(disabled).toBeUndefined()

		disablePptxSkill()
		const enabled = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})
		const skillPaths = (enabled as { skillPaths?: string[] } | undefined)?.skillPaths ?? []
		expect(skillPaths).toHaveLength(1)
		const loaded = loadSkillsFromDir({ dir: skillPaths[0] ?? "", source: "path" })
		expect(loaded.skills).toMatchObject([{ name: "pptx" }])
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
		const { handlers } = registerExtension(() => [".agents/skills"])

		const result = await handlers.resources_discover?.({
			type: "resources_discover",
			cwd: join(dir, "project"),
			reason: "startup",
		})

		expect(result).toBeUndefined()
	})

	it("contributes startup temp copies for configured Claude Code skills", async () => {
		writeRawSkill(join(dir, "project", ".claude", "skills", "best-practices", "SKILL.md"), "Claude skill.\n")
		const { handlers } = registerExtension(() => [".claude/skills"])

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
	session_start?: (event: { type: "session_start" }, ctx: { cwd: string }) => unknown
}

function registerExtension(configuredSkillPaths: () => string[] = () => []): {
	tools: ToolDefinition[]
	handlers: RegisteredHandlers
	fireSessionStart: (cwd: string) => void
} {
	const tools: ToolDefinition[] = []
	const handlers: RegisteredHandlers = {}
	claudeCodeSkillsExtension(
		{
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: keyof RegisteredHandlers, handler: NonNullable<RegisteredHandlers[keyof RegisteredHandlers]>) => {
				handlers[event] = handler as never
			},
		} as unknown as ExtensionAPI,
		configuredSkillPaths,
	)
	return {
		tools,
		handlers,
		fireSessionStart: (cwd: string) => {
			handlers.session_start?.({ type: "session_start" }, { cwd })
		},
	}
}

/** Register the extension, fire session_start in `cwd` and return the Skill
 *  tool — fails fast if the gate withheld registration. */
function registeredSkillTool(cwd: string): ToolDefinition {
	const { tools, fireSessionStart } = registerExtension()
	fireSessionStart(cwd)
	expect(tools, `Skill tool must register on session start in ${cwd}`).toHaveLength(1)
	return tools[0]
}

/** Turn off the bundled pptx skill (skills.pptx) via the settings override. */
function disablePptxSkill(): void {
	mkdirSync(join(dir, "agent-dir"), { recursive: true })
	writeFileSync(join(dir, "agent-dir", "settings.json"), JSON.stringify({ resources: { "skills.pptx": false } }))
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
