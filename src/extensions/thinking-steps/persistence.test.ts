import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	readThinkingStepsModePreference,
	resolveStickyModeScope,
	writeThinkingStepsModePreference,
} from "./persistence.js"

let agentDir: string
let projectDir: string

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-thinking-persist-"))
	projectDir = mkdtempSync(join(tmpdir(), "kimchi-thinking-project-"))
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(agentDir, { recursive: true, force: true })
	rmSync(projectDir, { recursive: true, force: true })
})

describe("resolveStickyModeScope", () => {
	it("targets global when no project preference exists", async () => {
		await expect(resolveStickyModeScope(projectDir)).resolves.toBe("global")
	})

	it("targets project when a project preference governs the directory", async () => {
		await writeThinkingStepsModePreference("project", projectDir, "none")
		await expect(resolveStickyModeScope(projectDir)).resolves.toBe("project")
	})

	it("falls back to global when the project preference is unreadable", async () => {
		mkdirSync(join(projectDir, ".kimchi"), { recursive: true })
		writeFileSync(join(projectDir, ".kimchi", "thinking-steps.json"), "{not json")
		await expect(resolveStickyModeScope(projectDir)).resolves.toBe("global")
	})
})

describe("thinking view preference round-trip", () => {
	it("writes and reads back the none preference in both scopes", async () => {
		await writeThinkingStepsModePreference("global", projectDir, "none")
		await writeThinkingStepsModePreference("project", projectDir, "collapsed")

		await expect(readThinkingStepsModePreference("global", projectDir)).resolves.toBe("none")
		await expect(readThinkingStepsModePreference("project", projectDir)).resolves.toBe("collapsed")
	})

	it("returns undefined when no preference is stored", async () => {
		await expect(readThinkingStepsModePreference("global", projectDir)).resolves.toBeUndefined()
		await expect(readThinkingStepsModePreference("project", projectDir)).resolves.toBeUndefined()
	})
})
