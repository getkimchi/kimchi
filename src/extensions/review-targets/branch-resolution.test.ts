import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveBranchTargetRevision } from "./refs.js"
import { resolveReviewTarget } from "./resolve.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function write(root: string, name: string, contents: string): void {
	writeFileSync(join(root, name), contents)
}

function commit(root: string, name: string, contents: string, message: string): string {
	write(root, name, contents)
	git(root, "add", name)
	git(root, "commit", "-m", message)
	return git(root, "rev-parse", "HEAD")
}

describe("friendly branch resolution", () => {
	let sandbox: string
	let source: string
	let clone: string
	let base: string
	let remoteTip: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-branches-"))
		source = join(sandbox, "source")
		clone = join(sandbox, "clone")
		mkdirSync(source)
		git(source, "init", "--initial-branch=main")
		git(source, "config", "user.name", "Review Fixture")
		git(source, "config", "user.email", "review@example.invalid")
		base = commit(source, "value.txt", "base\n", "base")
		git(source, "checkout", "-b", "feature")
		remoteTip = commit(source, "value.txt", "remote\n", "remote tip")
		git(sandbox, "clone", "--no-hardlinks", source, clone)
		git(clone, "config", "user.name", "Review Fixture")
		git(clone, "config", "user.email", "review@example.invalid")
		git(clone, "checkout", "--detach", base)
		git(clone, "update-ref", "-d", "refs/heads/feature")
		git(clone, "fetch", "origin", `+refs/heads/feature:refs/remotes/origin/feature`)
	})

	afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

	function options(overrides: Partial<Parameters<typeof resolveBranchTargetRevision>[2]> = {}) {
		return { remote: "origin", configuredRemotes: ["origin"], autoFetch: false, ...overrides }
	}

	it("uses a branch that exists only as a remote-tracking ref", async () => {
		await expect(resolveBranchTargetRevision(clone, "feature", options())).resolves.toEqual({
			ref: "refs/remotes/origin/feature",
			commitSha: remoteTip,
		})
	})

	it("fetches an unknown branch from the selected remote exactly once", async () => {
		git(clone, "update-ref", "-d", "refs/remotes/origin/feature")
		await expect(resolveBranchTargetRevision(clone, "feature", options({ autoFetch: true }))).resolves.toEqual({
			ref: "refs/remotes/origin/feature",
			commitSha: remoteTip,
		})
		expect(git(clone, "rev-parse", "refs/remotes/origin/feature")).toBe(remoteTip)
	})

	it("uses equal local and remote tips without prompting", async () => {
		git(clone, "update-ref", "refs/heads/feature", remoteTip)
		const choose = vi.fn()
		await expect(
			resolveBranchTargetRevision(clone, "feature", options({ interactions: { chooseBranchRevision: choose } })),
		).resolves.toEqual({ ref: "refs/heads/feature", commitSha: remoteTip })
		expect(choose).not.toHaveBeenCalled()
	})

	it("reports a strictly behind local branch and honors --prefer remote", async () => {
		git(clone, "update-ref", "refs/heads/feature", base)
		const choose = vi.fn()
		await expect(
			resolveBranchTargetRevision(clone, "feature", options({ interactions: { chooseBranchRevision: choose } })),
		).rejects.toMatchObject({
			code: "branch_revision_choice_required",
			message: expect.stringContaining("0 ahead, 1 behind"),
		})
		expect(choose).toHaveBeenCalledWith(
			expect.objectContaining({ local: expect.objectContaining({ ahead: 0, behind: 1 }) }),
		)
		await expect(resolveBranchTargetRevision(clone, "feature", options({ prefer: "remote" }))).resolves.toEqual({
			ref: "refs/remotes/origin/feature",
			commitSha: remoteTip,
		})
	})

	it("offers a strictly ahead local branch to the UI selector", async () => {
		git(clone, "checkout", "-b", "feature", remoteTip)
		const localTip = commit(clone, "value.txt", "local\n", "local tip")
		const choose = vi.fn(async () => "local" as const)
		await expect(
			resolveBranchTargetRevision(clone, "feature", options({ interactions: { chooseBranchRevision: choose } })),
		).resolves.toEqual({ ref: "refs/heads/feature", commitSha: localTip })
		expect(choose).toHaveBeenCalledWith(
			expect.objectContaining({ local: expect.objectContaining({ ahead: 1, behind: 0 }) }),
		)
	})

	it("detects divergence and permits an explicit local selection", async () => {
		git(clone, "checkout", "--detach", base)
		const localTip = commit(clone, "value.txt", "diverged\n", "local divergent tip")
		git(clone, "update-ref", "refs/heads/feature", localTip)
		const choose = vi.fn()
		await expect(
			resolveBranchTargetRevision(clone, "feature", options({ interactions: { chooseBranchRevision: choose } })),
		).rejects.toMatchObject({ message: expect.stringContaining("1 ahead, 1 behind") })
		await expect(resolveBranchTargetRevision(clone, "feature", options({ prefer: "local" }))).resolves.toEqual({
			ref: "refs/heads/feature",
			commitSha: localTip,
		})
	})
})

describe("base fallback selection", () => {
	let sandbox: string
	let repo: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-base-fallback-"))
		repo = join(sandbox, "repo")
		mkdirSync(repo)
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Review Fixture")
		git(repo, "config", "user.email", "review@example.invalid")
		commit(repo, "value.txt", "base\n", "base")
		git(repo, "checkout", "-b", "feature")
		commit(repo, "value.txt", "feature\n", "feature tip")
		git(repo, "checkout", "main")
		git(repo, "checkout", "-b", "master")
		commit(repo, "master.txt", "master\n", "different master tip")
		git(repo, "checkout", "feature")
	})

	afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

	it("lists multiple candidates for the TUI and resolves the chosen base", async () => {
		let candidates: string[] = []
		const target = await resolveReviewTarget(
			{ kind: "branch", branch: "feature", includeWorkingTree: false, fetch: false },
			{
				root: repo,
				contextDir: join(sandbox, "context"),
				interactions: {
					chooseBase: async (choice) => {
						candidates = choice.candidates.map((candidate) => candidate.ref)
						return "refs/heads/master"
					},
				},
			},
		)
		expect(candidates).toEqual(["refs/heads/main", "refs/heads/master"])
		expect(target.scope.refs.resolvedBase).toBe("refs/heads/master")
		await target.cleanup()
	})

	it("fails non-interactively with all candidates instead of hanging", async () => {
		await expect(
			resolveReviewTarget(
				{ kind: "branch", branch: "feature", includeWorkingTree: false, fetch: false },
				{ root: repo, contextDir: join(sandbox, "context") },
			),
		).rejects.toMatchObject({
			code: "base_required",
			message: expect.stringContaining("refs/heads/main, refs/heads/master"),
		})
	})
})
