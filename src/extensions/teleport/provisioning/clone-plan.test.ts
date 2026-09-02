import { describe, expect, it } from "vitest"
import { ClonePlanError, canonicalRepoUrl, resolveClonePlan, toHttpsRepoUrl } from "./clone-plan.js"

describe("toHttpsRepoUrl", () => {
	it("converts git@ shorthand to https", () => {
		expect(toHttpsRepoUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo.git")
	})

	it("converts ssh:// form to https", () => {
		expect(toHttpsRepoUrl("ssh://git@github.com/org/repo.git")).toBe("https://github.com/org/repo.git")
	})

	it("passes https URLs through unchanged", () => {
		expect(toHttpsRepoUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git")
	})

	it("rejects http URLs (undefined)", () => {
		expect(toHttpsRepoUrl("http://github.com/org/repo.git")).toBeUndefined()
	})

	it("rejects local paths (undefined)", () => {
		expect(toHttpsRepoUrl("/home/user/repo")).toBeUndefined()
		expect(toHttpsRepoUrl("../some/repo")).toBeUndefined()
	})

	it("rejects empty / garbage (undefined)", () => {
		expect(toHttpsRepoUrl("")).toBeUndefined()
		expect(toHttpsRepoUrl("not-a-url-at-all")).toBeUndefined()
	})
})

describe("canonicalRepoUrl", () => {
	it("normalizes git@ shorthand", () => {
		expect(canonicalRepoUrl("git@github.com:o/r.git")).toBe("github.com/o/r")
	})

	it("normalizes https with user info", () => {
		expect(canonicalRepoUrl("https://user@github.com/o/r.git")).toBe("github.com/o/r")
	})

	it("normalizes ssh:// form", () => {
		expect(canonicalRepoUrl("ssh://git@github.com/o/r")).toBe("github.com/o/r")
	})

	it("treats all three forms as equal", () => {
		const a = canonicalRepoUrl("git@github.com:o/r.git")
		const b = canonicalRepoUrl("https://user@github.com/o/r.git")
		const c = canonicalRepoUrl("ssh://git@github.com/o/r")
		expect(a).toBe("github.com/o/r")
		expect(a).toBe(b)
		expect(b).toBe(c)
	})

	it("is host case-insensitive", () => {
		expect(canonicalRepoUrl("git@GitHub.COM:o/r.git")).toBe("github.com/o/r")
		expect(canonicalRepoUrl("git@GitHub.COM:o/r.git")).toBe(canonicalRepoUrl("git@github.com:o/r.git"))
	})

	it("distinguishes different paths", () => {
		expect(canonicalRepoUrl("git@github.com:o/r.git")).not.toBe(canonicalRepoUrl("git@github.com:o/other.git"))
	})

	it("returns undefined for garbage", () => {
		expect(canonicalRepoUrl("not-a-url-at-all")).toBeUndefined()
		expect(canonicalRepoUrl("")).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// resolveClonePlan — exec seam injection (same pattern as git-credentials.test)
// ---------------------------------------------------------------------------

type ExecResult = { stdout: string; stderr: string }
type Handler = { match: string; result?: ExecResult; throw?: Error }

/**
 * Builds a git-exec mock that dispatches on a substring of the joined
 * argv array. The real implementation uses execFile (argv arrays, no
 * shell), so we join args with spaces for substring matching — this keeps
 * handler `match` strings stable across the exec→execFile migration.
 */
type GitExecFn = (
	args: readonly string[],
	opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>

function mockExec(handlers: Handler[]): GitExecFn {
	return (async (args: readonly string[]) => {
		const cmd = args.join(" ")
		for (const h of handlers) {
			if (cmd.includes(h.match)) {
				if (h.throw) throw h.throw
				return h.result as ExecResult
			}
		}
		throw new Error(`unmocked git exec: ${cmd}`)
	}) as unknown as GitExecFn
}

/** Capture a rejection as a ClonePlanError (or fail the test). */
async function expectCloneError(code: string, p: Promise<unknown>): Promise<ClonePlanError> {
	try {
		await p
	} catch (e) {
		expect(e).toBeInstanceOf(ClonePlanError)
		expect((e as ClonePlanError).code).toBe(code)
		return e as ClonePlanError
	}
	throw new Error("expected resolveClonePlan to throw")
}

describe("resolveClonePlan", () => {
	it("throws not-a-git-repo when rev-parse fails", async () => {
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", throw: new Error("fatal: not a git repository") },
		])
		await expectCloneError("not-a-git-repo", resolveClonePlan("/fake", undefined, { exec }))
	})

	it("throws no-origin when neither explicit URL nor origin exists", async () => {
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", throw: new Error("fatal: No such remote 'origin'") },
		])
		await expectCloneError("no-origin", resolveClonePlan("/fake", undefined, { exec }))
	})

	it("throws url-mismatch with both URLs in the message", async () => {
		const originUrl = "git@github.com:org/repo.git"
		const explicitUrl = "https://github.com/org/different.git"
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: `${originUrl}\n`, stderr: "" } },
		])
		const err = await expectCloneError("url-mismatch", resolveClonePlan("/fake", explicitUrl, { exec }))
		expect(err.message).toContain(originUrl)
		expect(err.message).toContain(explicitUrl)
	})

	it("happy path: returns {url, httpsUrl, branch} from local HEAD", async () => {
		const originUrl = "git@github.com:org/repo.git"
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: `${originUrl}\n`, stderr: "" } },
			{ match: "symbolic-ref --short HEAD", result: { stdout: "main\n", stderr: "" } },
		])
		const plan = await resolveClonePlan("/fake", undefined, { exec })
		expect(plan).toEqual({
			url: originUrl,
			httpsUrl: "https://github.com/org/repo.git",
			branch: "main",
		})
	})

	it("unpushed branch: still returns branch (worker handles not-on-origin)", async () => {
		const url = "https://github.com/org/repo.git"
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: `${url}\n`, stderr: "" } },
			{ match: "symbolic-ref --short HEAD", result: { stdout: "main\n", stderr: "" } },
		])
		const plan = await resolveClonePlan("/fake", url, { exec })
		expect(plan).toEqual({ url, httpsUrl: url, branch: "main" })
	})

	it("detached HEAD: no branch", async () => {
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: "https://github.com/org/repo.git\n", stderr: "" } },
			{ match: "symbolic-ref --short HEAD", throw: new Error("HEAD is not a symbolic ref") },
		])
		const plan = await resolveClonePlan("/fake", undefined, { exec })
		expect(plan).toEqual({ url: "https://github.com/org/repo.git", httpsUrl: "https://github.com/org/repo.git" })
		expect(plan.branch).toBeUndefined()
	})

	it("explicit URL with no origin remote is allowed", async () => {
		const url = "https://github.com/org/repo.git"
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", throw: new Error("fatal: No such remote 'origin'") },
			{ match: "symbolic-ref --short HEAD", result: { stdout: "main\n", stderr: "" } },
		])
		const plan = await resolveClonePlan("/fake", url, { exec })
		expect(plan).toEqual({ url, httpsUrl: url, branch: "main" })
	})

	it("throws not-https when the URL is a local path", async () => {
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: "/home/user/repo\n", stderr: "" } },
		])
		await expectCloneError("not-https", resolveClonePlan("/fake", undefined, { exec }))
	})

	it("redacts userinfo from URLs in error messages", async () => {
		const originUrl = "https://user:ghp_secret@github.com/org/repo.git"
		const explicitUrl = "https://user:ghp_secret@github.com/org/different.git"
		const exec = mockExec([
			{ match: "rev-parse --is-inside-work-tree", result: { stdout: "true\n", stderr: "" } },
			{ match: "remote get-url origin", result: { stdout: `${originUrl}\n`, stderr: "" } },
		])
		const err = await expectCloneError("url-mismatch", resolveClonePlan("/fake", explicitUrl, { exec }))
		expect(err.message).not.toContain("ghp_secret")
		expect(err.message).toContain("github.com/org/repo.git")
		expect(err.message).toContain("github.com/org/different.git")
	})
})
