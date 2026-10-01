import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseOwnerName, resolveProjectScope, sanitizeScopeId } from "./scope.js"

describe("parseOwnerName", () => {
	it("parses https remote URLs", () => {
		expect(parseOwnerName("https://github.com/castai/kimchi")).toBe("castai/kimchi")
		// GitLab subgroups keep the full group path as the identity.
		expect(parseOwnerName("https://gitlab.com/castai/kimchi/kimchi.git")).toBe("castai/kimchi/kimchi")
	})

	it("parses scp-like remote URLs", () => {
		expect(parseOwnerName("git@github.com:castai/kimchi.git")).toBe("castai/kimchi")
		expect(parseOwnerName("git@gitlab.com:castai/group/repo.git")).toBe("castai/group/repo")
	})

	it("parses ssh URLs", () => {
		expect(parseOwnerName("ssh://git@github.com/castai/kimchi")).toBe("castai/kimchi")
	})

	it("returns null for unparseable URLs", () => {
		expect(parseOwnerName("not a url")).toBeNull()
		expect(parseOwnerName("https://github.com/onlyowner")).toBeNull()
		expect(parseOwnerName("")).toBeNull()
	})
})

describe("sanitizeScopeId", () => {
	it("accepts owner/name with allowed segments", () => {
		expect(sanitizeScopeId("castai/kimchi")).toBe("castai/kimchi")
		expect(sanitizeScopeId("a.b-c_d")).toBe("a.b-c_d")
	})

	it("accepts single-segment fallbacks", () => {
		expect(sanitizeScopeId("myrepo")).toBe("myrepo")
	})

	it("rejects path traversal and empty segments", () => {
		expect(sanitizeScopeId("../evil")).toBeNull()
		expect(sanitizeScopeId("a/../evil")).toBeNull()
		expect(sanitizeScopeId("a//b")).toBeNull()
		expect(sanitizeScopeId("/leading")).toBeNull()
		expect(sanitizeScopeId("trailing/")).toBeNull()
	})

	it("rejects too many segments and invalid characters", () => {
		expect(sanitizeScopeId("a/b/c/d/e")).toBeNull()
		expect(sanitizeScopeId("a/b c")).toBeNull()
		expect(sanitizeScopeId("")).toBeNull()
	})
})

describe("resolveProjectScope", () => {
	const dirs: string[] = []

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	function makeRepo(remote?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-scope-test-"))
		dirs.push(dir)
		const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" })
		run(["init", "--quiet"])
		if (remote) run(["remote", "add", "origin", remote])
		return dir
	}

	it("resolves owner/name from the origin remote", () => {
		const dir = makeRepo("https://github.com/castai/kimchi.git")
		const scope = resolveProjectScope(dir)
		expect(scope).not.toBeNull()
		expect(scope?.id).toBe("castai/kimchi")
		expect(scope?.contextLine).toContain("castai/kimchi")
		expect(scope?.contextLine).toContain(dir)
	})

	it("falls back to the repo directory name without a remote", () => {
		const dir = makeRepo()
		const scope = resolveProjectScope(dir)
		expect(scope).not.toBeNull()
		expect(scope?.id).toBe(dir.split("/").pop())
	})

	it("returns null outside a repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-scope-norepo-"))
		dirs.push(dir)
		expect(resolveProjectScope(dir)).toBeNull()
	})
})
