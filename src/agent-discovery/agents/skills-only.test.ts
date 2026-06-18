import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AGENT_DEFINITIONS, discoverAgent } from "../index.js"
import { SKILLS_ONLY_AGENTS, makeSkillsOnlyAgent } from "./skills-only.js"

describe("skills-only agents", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-skills-only-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("discovers a skills directory and counts subdirectories as skills", () => {
		const skillsDir = join(tempDir, "skills")
		mkdirSync(join(skillsDir, "alpha"), { recursive: true })
		mkdirSync(join(skillsDir, "beta"), { recursive: true })

		const def = makeSkillsOnlyAgent("warp", "Warp", ".warp", { skillsDirs: [skillsDir] })
		const discovery = discoverAgent(def)

		expect(discovery.skillsDir).toBe(skillsDir)
		expect(discovery.skillCount).toBe(2)
		expect(discovery.mcpServers).toEqual({})
		expect(discovery.commandsCount).toBe(0)
	})

	it("falls through to the next candidate when the first does not exist", () => {
		const present = join(tempDir, "present", "skills")
		mkdirSync(join(present, "only"), { recursive: true })

		const def = makeSkillsOnlyAgent("warp", "Warp", ".warp", {
			skillsDirs: [join(tempDir, "missing", "skills"), present],
		})
		const discovery = discoverAgent(def)

		expect(discovery.skillsDir).toBe(present)
		expect(discovery.skillCount).toBe(1)
	})

	it("reports no skills directory when none of the candidates exist", () => {
		const def = makeSkillsOnlyAgent("gemini", "Gemini", ".gemini", {
			skillsDirs: [join(tempDir, "nope", "skills")],
		})
		const discovery = discoverAgent(def)

		expect(discovery.skillsDir).toBeUndefined()
		expect(discovery.skillCount).toBe(0)
	})

	it("defaults to the project-local skills dir first, then the global fallback", () => {
		const def = makeSkillsOnlyAgent("codex", "Codex", ".codex")
		expect(def.skillsDirs[0]).toBe(join(process.cwd(), ".codex", "skills"))
		expect(def.skillsDirs[1]).toBe(join(homedir(), ".codex", "skills"))
	})

	it("registers the converged skills directories in AGENT_DEFINITIONS", () => {
		const ids = new Set(AGENT_DEFINITIONS.map((a) => a.id))
		for (const def of SKILLS_ONLY_AGENTS) {
			expect(ids.has(def.id)).toBe(true)
		}
		expect(SKILLS_ONLY_AGENTS.map((a) => a.id)).toEqual([
			"codex",
			"warp",
			"factory",
			"gemini",
			"copilot",
			"github",
			"agents",
		])
	})
})
