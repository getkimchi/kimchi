import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	resolveHeadlessProjectTrust,
	resolvePreMainProjectTrust,
	resolvePreMainProjectTrustWithOverrides,
} from "./project-trust.js"

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

function writeGlobalDefaultProjectTrust(defaultProjectTrust: string): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust }))
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

describe("resolvePreMainProjectTrust", () => {
	it("fails closed when a decision is needed but none was persisted (ask default)", () => {
		addProjectSettings()
		expect(resolvePreMainProjectTrust(cwd, agentDir)).toBe(false)
	})

	it("honors a persisted trust decision without prompting again", () => {
		addProjectSettings()
		new ProjectTrustStore(agentDir).set(cwd, true)
		expect(resolvePreMainProjectTrust(cwd, agentDir)).toBe(true)
	})

	it("reads defaultProjectTrust=always from the global scope", () => {
		addProjectSettings()
		writeGlobalDefaultProjectTrust("always")
		expect(resolvePreMainProjectTrust(cwd, agentDir)).toBe(true)
	})

	it("a project settings file cannot grant itself trust via defaultProjectTrust", () => {
		// The default must be read from the global (agentDir) scope only — a
		// project settings.json claiming defaultProjectTrust: always must not
		// open the pre-main gate.
		addProjectSettings({ defaultProjectTrust: "always" })
		expect(resolvePreMainProjectTrust(cwd, agentDir)).toBe(false)
	})

	it("trusts a cwd with no trust-requiring project resources", () => {
		expect(resolvePreMainProjectTrust(cwd, agentDir)).toBe(true)
	})
})

describe("resolvePreMainProjectTrustWithOverrides", () => {
	it("--no-approve forces untrusted even with a persisted trust decision", () => {
		addProjectSettings()
		new ProjectTrustStore(agentDir).set(cwd, true)
		// A previously trusted project's config must not leak into a
		// --no-approve run before pi processes the flag.
		expect(resolvePreMainProjectTrustWithOverrides(cwd, agentDir, false)).toBe(false)
	})

	it("--approve forces trusted without a persisted decision", () => {
		addProjectSettings()
		expect(resolvePreMainProjectTrustWithOverrides(cwd, agentDir, true)).toBe(true)
	})

	it("without an override, the persisted decision decides", () => {
		addProjectSettings()
		new ProjectTrustStore(agentDir).set(cwd, true)
		expect(resolvePreMainProjectTrustWithOverrides(cwd, agentDir, undefined)).toBe(true)
	})
})
