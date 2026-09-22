import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	isProjectScopeAllowed,
	resetProjectScopeTrustForTests,
	setProjectScopeTrusted,
	TRUST_REQUIRING_PROJECT_RESOURCES,
} from "./project-scope-trust.js"

const ROOT = join("/private", "tmp", "kimchi-gate")

describe("isProjectScopeAllowed", () => {
	it("fails closed when no decision was recorded", () => {
		resetProjectScopeTrustForTests()
		expect(isProjectScopeAllowed(join(ROOT, "cloned-repo"))).toBe(false)
	})

	it("honors a trusted decision for the exact cwd", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(join(ROOT, "repo"), true)
		expect(isProjectScopeAllowed(join(ROOT, "repo"))).toBe(true)
	})

	it("covers a whole working tree from an ancestor decision (ancestor-walking readers)", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(ROOT, true)
		expect(isProjectScopeAllowed(join(ROOT, "repo", "src", "feature"))).toBe(true)
	})

	it("nearest decision wins over an ancestor decision", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(ROOT, true)
		setProjectScopeTrusted(join(ROOT, "repo"), false)
		expect(isProjectScopeAllowed(join(ROOT, "repo", "sub"))).toBe(false)
	})

	it("a distrusted child does not affect a sibling", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(join(ROOT, "repo-a"), false)
		setProjectScopeTrusted(join(ROOT, "repo-b"), true)
		expect(isProjectScopeAllowed(join(ROOT, "repo-a"))).toBe(false)
		expect(isProjectScopeAllowed(join(ROOT, "repo-b"))).toBe(true)
	})

	it("resolves relative and non-canonical cwds against recorded decisions", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(join(ROOT, "repo"), true)
		expect(isProjectScopeAllowed(join(ROOT, "repo", "..", "repo", "nested"))).toBe(true)
	})

	it("defaults to the process cwd when no cwd is given", () => {
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(process.cwd(), true)
		expect(isProjectScopeAllowed()).toBe(true)
	})
})

describe("TRUST_REQUIRING_PROJECT_RESOURCES stays in sync with the pi patch", () => {
	it("the patch's embedded KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES matches the first-party constant", () => {
		const patchPath = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"patches",
			"@earendil-works__pi-coding-agent@0.85.1.patch",
		)
		const patch = readFileSync(patchPath, "utf-8")
		const match = patch.match(/const KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES = \[([\s\S]*?)\]/)
		if (!match) {
			throw new Error("KIMCHI_TRUST_REQUIRING_PROJECT_RESOURCES not found in the pi patch")
		}
		const embedded = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
		// Exact set equality (sorted): a reader gated without a scan entry — or a
		// stale scan entry for a removed reader — fails here instead of shipping
		// as a silent auto-trust gap.
		expect([...embedded].sort()).toEqual([...TRUST_REQUIRING_PROJECT_RESOURCES].sort())
	})
})
