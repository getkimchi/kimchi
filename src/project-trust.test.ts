import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveHeadlessProjectTrust } from "./project-trust.js"

let root: string
let cwd: string
let agentDir: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-project-trust-"))
	cwd = join(root, "project")
	agentDir = join(root, "agent")
	mkdirSync(cwd, { recursive: true })
	mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

function addProjectSettings(settings: Record<string, unknown> = {}): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true })
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings))
}

describe("resolveHeadlessProjectTrust", () => {
	it("trusts a cwd with no trust-requiring project resources", () => {
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "ask")).toBe(true)
	})

	it("falls back to untrusted when project settings exist and no decision was persisted", () => {
		addProjectSettings({ httpIdleTimeoutMs: 0 })
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "ask")).toBe(false)
		expect(resolveHeadlessProjectTrust(cwd, agentDir, undefined)).toBe(false)
	})

	it("honors a persisted trust decision", () => {
		addProjectSettings()
		new ProjectTrustStore(agentDir).set(cwd, true)
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "ask")).toBe(true)
	})

	it("honors a persisted distrust decision even when the default is always", () => {
		addProjectSettings()
		new ProjectTrustStore(agentDir).set(cwd, false)
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "always")).toBe(false)
	})

	it("applies the defaultProjectTrust setting when no decision was persisted", () => {
		addProjectSettings()
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "always")).toBe(true)
		expect(resolveHeadlessProjectTrust(cwd, agentDir, "never")).toBe(false)
	})
})
