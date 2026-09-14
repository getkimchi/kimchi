import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentSession, CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it, vi } from "vitest"
import { createChildSettings } from "./child-settings.js"

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kimchi-child-settings-"))
	directories.push(root)
	const cwd = join(root, "project")
	const agentDir = join(root, "agent")
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true })
	mkdirSync(agentDir)
	const globalPath = join(agentDir, "settings.json")
	const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json")
	writeFileSync(
		globalPath,
		JSON.stringify({ defaultThinkingLevel: "high", retry: { maxRetries: 3 }, defaultProjectTrust: "never" }),
	)
	writeFileSync(
		projectPath,
		JSON.stringify({ retry: { maxRetries: 7 }, defaultProjectTrust: "always", skills: ["./project-skill"] }),
	)
	return { cwd, agentDir, globalPath, projectPath }
}

it("keeps SDK thinking changes and settings reloads child-local with project precedence", async () => {
	const f = fixture()
	const globalBefore = readFileSync(f.globalPath, "utf8")
	const projectBefore = readFileSync(f.projectPath, "utf8")
	const child = createChildSettings(f.cwd, f.agentDir, { cwd: f.cwd, isProjectTrusted: () => true })
	expect(child.getRetrySettings().maxRetries).toBe(7)
	// Invoke the real SDK setter: it persists through this session's manager.
	AgentSession.prototype.setThinkingLevel.call(
		{
			agent: { state: { thinkingLevel: "high" } },
			getAvailableThinkingLevels: () => ["high", "low"],
			supportsThinking: () => true,
			sessionManager: { appendThinkingLevelChange: vi.fn() },
			settingsManager: child,
			_emit: vi.fn(),
			_extensionRunner: { emit: vi.fn() },
		} as unknown as AgentSession,
		"low",
	)
	child.setDefaultModelAndProvider("test", "child-model")
	child.setProjectSkillPaths(["./child-skill"])
	await child.flush()
	await child.reload()
	expect(child.getDefaultThinkingLevel()).toBe("low")
	expect(child.getDefaultModel()).toBe("child-model")
	expect(child.getProjectSettings().skills).toEqual(["./child-skill"])
	expect(child.getRetrySettings().maxRetries).toBe(7)
	expect(readFileSync(f.globalPath, "utf8")).toBe(globalBefore)
	expect(readFileSync(f.projectPath, "utf8")).toBe(projectBefore)
	// A new child/main session still sees the original files, not this child's choices.
	const next = createChildSettings(f.cwd, f.agentDir, { cwd: f.cwd, isProjectTrusted: () => true })
	expect(next.getDefaultThinkingLevel()).toBe("high")
	const main = SettingsManager.create(f.cwd, f.agentDir)
	main.setDefaultThinkingLevel("medium")
	await main.flush()
	expect(JSON.parse(readFileSync(f.globalPath, "utf8")).defaultThinkingLevel).toBe("medium")
})

it("does not trust project overrides when the parent is untrusted or the child changes cwd", async () => {
	const f = fixture()
	for (const parent of [
		{ cwd: f.cwd, isProjectTrusted: () => false },
		{ cwd: join(f.cwd, "other"), isProjectTrusted: () => true },
	]) {
		const child = createChildSettings(f.cwd, f.agentDir, parent)
		expect(child.isProjectTrusted()).toBe(false)
		expect(child.getRetrySettings().maxRetries).toBe(3)
		await child.reload()
		expect(child.getProjectSettings()).toEqual({})
		expect(() => child.setProjectSkillPaths(["./not-allowed"])).toThrow()
	}
})

it("preserves native malformed-settings diagnostics without touching the malformed file", async () => {
	const f = fixture()
	writeFileSync(f.globalPath, "{invalid")
	const child = createChildSettings(f.cwd, f.agentDir, { cwd: f.cwd, isProjectTrusted: () => true })
	expect(child.drainErrors()).toEqual([{ scope: "global", error: expect.any(SyntaxError) }])
	expect(child.getRetrySettings().maxRetries).toBe(7)
	child.setDefaultThinkingLevel("low")
	await child.flush()
	await child.reload()
	expect(child.drainErrors()).toEqual([{ scope: "global", error: expect.any(SyntaxError) }])
	expect(readFileSync(f.globalPath, "utf8")).toBe("{invalid")
})
