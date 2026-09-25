// Unit tests for the ACP project-trust surfacing payloads (LLM-3628):
// coarse blocked-category computation, push payload shape, and the
// set_project_trust decision parsing contract.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RequestError } from "@agentclientprotocol/sdk"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import {
	buildPathTrustInfo,
	buildProjectTrustUpdate,
	computeBlockedTrustCategories,
	isPathWithin,
	parentTrustPath,
	parsePathTrustDecision,
	parseProjectTrustDecision,
} from "./trust-updates.js"

describe("computeBlockedTrustCategories", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-updates-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		resetProjectScopeTrustForTests()
	})

	it("returns [] for a project with no trust-requiring resources", () => {
		expect(computeBlockedTrustCategories(dir)).toEqual([])
	})

	it("detects each category from its conventional paths", () => {
		mkdirSync(join(dir, ".kimchi", "skills"), { recursive: true })
		expect(computeBlockedTrustCategories(dir)).toEqual(["skills"])

		writeFileSync(join(dir, ".kimchi", "config.json"), "{}", "utf-8")
		expect(computeBlockedTrustCategories(dir)).toEqual(["skills", "project_config"])

		mkdirSync(join(dir, ".pi"), { recursive: true })
		writeFileSync(join(dir, ".pi", "settings.json"), "{}", "utf-8")
		expect(computeBlockedTrustCategories(dir)).toEqual(["skills", "project_config", "pi_settings"])
	})

	it("detects .claude/skills and .pi/agent/skills as skills", () => {
		mkdirSync(join(dir, ".claude", "skills"), { recursive: true })
		mkdirSync(join(dir, ".pi", "agent", "skills"), { recursive: true })
		expect(computeBlockedTrustCategories(dir)).toEqual(["skills"])
	})

	it("never enumerates paths — only the coarse category names", () => {
		mkdirSync(join(dir, ".kimchi", "skills", "some-secret-skill"), { recursive: true })
		writeFileSync(
			join(dir, ".kimchi", "skills", "some-secret-skill", "SKILL.md"),
			"---\nname: some-secret-skill\n---\nBody.\n",
			"utf-8",
		)
		const blocked = computeBlockedTrustCategories(dir)
		expect(blocked).toEqual(["skills"])
		expect(JSON.stringify(blocked)).not.toContain("some-secret-skill")
	})
})

describe("buildProjectTrustUpdate", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trust-updates-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		resetProjectScopeTrustForTests()
	})

	it("reports untrusted with blocked categories when no decision is recorded", () => {
		mkdirSync(join(dir, ".kimchi", "skills"), { recursive: true })
		expect(buildProjectTrustUpdate("s1", dir)).toEqual({
			sessionId: "s1",
			trusted: false,
			blocked: ["skills"],
		})
	})

	it("reports trusted with no blocked categories once the gate opens", () => {
		mkdirSync(join(dir, ".kimchi", "skills"), { recursive: true })
		setProjectScopeTrusted(dir, true)
		expect(buildProjectTrustUpdate("s2", dir)).toEqual({
			sessionId: "s2",
			trusted: true,
			blocked: [],
		})
	})
})

describe("parseProjectTrustDecision", () => {
	it("accepts the five decisions", () => {
		expect(parseProjectTrustDecision("trust")).toBe("trust")
		expect(parseProjectTrustDecision("trust_session")).toBe("trust_session")
		expect(parseProjectTrustDecision("trust_parent")).toBe("trust_parent")
		expect(parseProjectTrustDecision("deny")).toBe("deny")
		expect(parseProjectTrustDecision("deny_persist")).toBe("deny_persist")
	})

	it("rejects anything else with invalidParams", () => {
		for (const bad of [undefined, null, "", "Trust", "allow", 42, { decision: "trust" }]) {
			expect(() => parseProjectTrustDecision(bad)).toThrow(RequestError)
		}
	})
})

describe("parentTrustPath", () => {
	it("returns the parent directory", () => {
		expect(parentTrustPath("/repo/packages/a")).toBe("/repo/packages")
	})

	it("returns undefined at the filesystem root", () => {
		expect(parentTrustPath("/")).toBeUndefined()
	})
})

describe("isPathWithin", () => {
	it("matches the ancestor itself", () => {
		expect(isPathWithin("/repo", "/repo")).toBe(true)
	})

	it("matches descendants at any depth", () => {
		expect(isPathWithin("/repo/packages/a/src", "/repo")).toBe(true)
	})

	it("rejects siblings and unrelated paths (no prefix collision)", () => {
		expect(isPathWithin("/repo-other", "/repo")).toBe(false)
		expect(isPathWithin("/elsewhere/x", "/repo")).toBe(false)
	})
})

describe("parsePathTrustDecision", () => {
	it("accepts the persisted decisions", () => {
		expect(parsePathTrustDecision("trust")).toBe("trust")
		expect(parsePathTrustDecision("deny")).toBe("deny")
	})

	it("rejects session-scoped decisions and garbage", () => {
		for (const bad of [undefined, null, "", "trust_session", "trust_parent", "deny_persist", "remove", 42]) {
			expect(() => parsePathTrustDecision(bad)).toThrow(RequestError)
		}
	})
})

describe("buildPathTrustInfo", () => {
	let agentDir: string

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "path-trust-store-"))
	})

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("reports undecided with blocked categories and null source", () => {
		const dir = mkdtempSync(join(tmpdir(), "path-trust-dir-"))
		try {
			mkdirSync(join(dir, ".kimchi", "skills"), { recursive: true })
			const store = new ProjectTrustStore(agentDir)
			expect(buildPathTrustInfo(store, dir)).toEqual({
				decided: false,
				trusted: false,
				blocked: ["skills"],
				decisionSource: null,
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports a stored grant with the canonicalized source", () => {
		const dir = mkdtempSync(join(tmpdir(), "path-trust-dir-"))
		try {
			const store = new ProjectTrustStore(agentDir)
			store.set(dir, true)
			expect(buildPathTrustInfo(store, dir)).toEqual({
				decided: true,
				trusted: true,
				blocked: [],
				decisionSource: realpathSync(dir),
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("inherits an ancestor entry and reports the ancestor as source", () => {
		const dir = mkdtempSync(join(tmpdir(), "path-trust-dir-"))
		try {
			const store = new ProjectTrustStore(agentDir)
			store.set(dir, false) // stored refusal on the ancestor
			const nested = join(dir, "a", "b")
			mkdirSync(nested, { recursive: true })
			expect(buildPathTrustInfo(store, nested)).toEqual({
				decided: true,
				trusted: false,
				blocked: [],
				decisionSource: realpathSync(dir),
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
