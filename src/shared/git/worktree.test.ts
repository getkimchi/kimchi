import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	applyWorktreeInclude,
	createWorktree,
	generateWorktreeName,
	listWorktreeDirsUnder,
	listWorktrees,
	removeWorktree,
	resolveBaseRef,
	resolveRepoRoots,
	validateWorktreeName,
	WORKTREE_BRANCH_PREFIX,
	WORKTREE_DIR_NAME,
	WorktreeError,
	worktreeDir,
	worktreeStatus,
} from "./worktree.js"

/** Run git synchronously in `cwd`; returns trimmed stdout. */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

/** Init a bare-ish main repo with one commit, plus a worktree-able structure. */
async function initRepo(): Promise<string> {
	const raw = await mkdtemp(join(tmpdir(), "worktree-test-"))
	// realpath: on macOS /var is a symlink to /private/var; git resolves the
	// worktree .git pointer to the real path, so the module compares realpaths.
	const root = await realpath(raw)
	git(root, ["init", "-q"])
	git(root, ["config", "user.email", "wt@test"])
	git(root, ["config", "user.name", "Worktree Test"])
	await writeFile(join(root, "README.md"), "# test\n")
	git(root, ["add", "README.md"])
	git(root, ["commit", "-q", "-m", "init"])
	return root
}

describe("validateWorktreeName", () => {
	it("accepts session-name-shaped names", () => {
		expect(() => validateWorktreeName("feature-x")).not.toThrow()
		expect(() => validateWorktreeName("a.b_c-d")).not.toThrow()
		expect(() => validateWorktreeName("bold-oak-a3f2")).not.toThrow()
	})

	it("rejects empty, separators, '..', leading dash, invalid chars and overlong names", () => {
		expect(() => validateWorktreeName("")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("a/b")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("a\\b")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("..")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("a..b")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("-lead")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("sp ace")).toThrow(WorktreeError)
		expect(() => validateWorktreeName("x".repeat(65))).toThrow(WorktreeError)
	})
})

describe("generateWorktreeName", () => {
	it("produces adjective-noun-4hex and validates", () => {
		for (let i = 0; i < 20; i++) {
			const name = generateWorktreeName()
			expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/)
			expect(() => validateWorktreeName(name)).not.toThrow()
		}
	})
})

describe("resolveRepoRoots", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("returns mainRoot == cwd for the main checkout", () => {
		expect(resolveRepoRoots(main)).toEqual({ mainRoot: main })
	})

	it("returns mainRoot + worktreeRoot from a linked worktree's .git pointer", async () => {
		const wt = await createWorktree({ mainRoot: main, name: "linked" })
		try {
			const roots = resolveRepoRoots(wt.path)
			expect(roots.mainRoot).toBe(main)
			expect(roots.worktreeRoot).toBe(wt.path)
		} finally {
			git(main, ["worktree", "remove", "--force", wt.path])
			git(main, ["branch", "-D", `${WORKTREE_BRANCH_PREFIX}linked`])
		}
	})

	it("returns mainRoot == cwd outside any repo", async () => {
		const outside = await realpath(await mkdtemp(join(tmpdir(), "not-a-repo-")))
		try {
			expect(resolveRepoRoots(outside)).toEqual({ mainRoot: outside })
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})
})

describe("worktreeDir", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("creates <.kimchi/worktrees> with a self-ignoring .gitignore and is idempotent", async () => {
		const dir = await worktreeDir(main)
		expect(dir).toBe(join(main, WORKTREE_DIR_NAME))
		expect(git(main, ["status", "--porcelain"])).toBe("") // dir is ignored in the main checkout

		const again = await worktreeDir(main)
		expect(again).toBe(dir)
	})
})

describe("listWorktrees", () => {
	let main: string
	let wt: { path: string; branch: string }
	beforeEach(async () => {
		main = await initRepo()
		wt = await createWorktree({ mainRoot: main, name: "one" })
	})
	afterEach(async () => {
		try {
			git(main, ["worktree", "remove", "--force", wt.path])
			git(main, ["branch", "-D", wt.branch])
		} catch {
			// already gone
		}
		await rm(main, { recursive: true, force: true })
	})

	it("lists the main checkout and the worktree with branch/isMain flags", async () => {
		const entries = await listWorktrees(main)
		const mainEntry = entries.find((e) => e.isMain)
		expect(mainEntry?.path).toBe(main)
		expect(mainEntry?.branch).toBeTruthy()

		const wtEntry = entries.find((e) => e.path === wt.path)
		expect(wtEntry?.isMain).toBe(false)
		expect(wtEntry?.branch).toBe(wt.branch)
		expect(wtEntry?.head).toMatch(/^[0-9a-f]{40}$/)
	})
})

describe("resolveBaseRef", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("falls back to local HEAD for 'fresh' when there is no origin (remote-less repo)", async () => {
		const base = await resolveBaseRef(main, "fresh")
		const head = git(main, ["rev-parse", "HEAD"])
		expect(base).toBe(head)
	})

	it("resolves 'head' to local HEAD", async () => {
		const base = await resolveBaseRef(main, "head")
		const head = git(main, ["rev-parse", "HEAD"])
		expect(base).toBe(head)
	})

	it("prefers origin/HEAD for 'fresh' when the remote exists", async () => {
		const remote = await mkdtemp(join(tmpdir(), "worktree-origin-"))
		try {
			git(remote, ["init", "-q", "--bare"])
			git(main, ["remote", "add", "origin", remote])
			git(main, ["push", "-q", "origin", "HEAD:refs/heads/main"])
			git(main, ["remote", "set-head", "origin", "main"])
			const base = await resolveBaseRef(main, "fresh")
			// symbolic-ref --short prints the tracking ref, e.g. "origin/main".
			expect(base).toBe("origin/main")
		} finally {
			await rm(remote, { recursive: true, force: true })
		}
	})
})

describe("createWorktree + worktreeStatus + removeWorktree", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("creates a worktree on branch worktree-<name> at the base commit", async () => {
		const created = await createWorktree({ mainRoot: main, name: "feature-x" })
		expect(created.branch).toBe("worktree-feature-x")
		expect(created.path).toBe(join(main, WORKTREE_DIR_NAME, "feature-x"))
		expect(git(main, ["rev-parse", "HEAD"])).toBe(git(created.path, ["rev-parse", "HEAD"]))
		expect(git(created.path, ["symbolic-ref", "--short", "HEAD"])).toBe("worktree-feature-x")
		// README carried over from the main checkout automatically
		expect(git(created.path, ["status", "--porcelain"])).toBe("")
	})

	it("throws when the worktree name is invalid", async () => {
		await expect(createWorktree({ mainRoot: main, name: "bad/name" })).rejects.toThrow(WorktreeError)
	})

	it("throws when the dir already exists and reuseExisting is not set", async () => {
		const created = await createWorktree({ mainRoot: main, name: "dup" })
		try {
			await expect(createWorktree({ mainRoot: main, name: "dup" })).rejects.toThrow(/already exists/)
		} finally {
			git(main, ["worktree", "remove", "--force", created.path])
			git(main, ["branch", "-D", created.branch])
		}
	})

	it("reuses a clean worktree without resetting when reuseExisting:true; reports status", async () => {
		const created = await createWorktree({ mainRoot: main, name: "reuse" })
		const baseline = git(created.path, ["rev-parse", "HEAD"])

		const status = await worktreeStatus(created.path, main)
		expect(status.dirty).toBe(false)
		expect(status.untracked).toBe(false)
		expect(status.ownCommits).toBe(0)

		// Reuse: clean + on-branch + no own commits → resets to base (same commit).
		const reused = await createWorktree({ mainRoot: main, name: "reuse", reuseExisting: true })
		expect(reused.path).toBe(created.path)
		expect(git(created.path, ["rev-parse", "HEAD"])).toBe(baseline)
	})

	it("keeps a dirty worktree on reuse and refuses non-force removal", async () => {
		const created = await createWorktree({ mainRoot: main, name: "dirty" })
		await writeFile(join(created.path, "WIP.md"), "uncommitted\n")

		const status = await worktreeStatus(created.path, main)
		expect(status.untracked).toBe(true)

		const before = git(created.path, ["rev-parse", "HEAD"])
		await createWorktree({ mainRoot: main, name: "dirty", reuseExisting: true })
		expect(git(created.path, ["rev-parse", "HEAD"])).toBe(before) // not reset — work present

		await expect(removeWorktree({ dir: created.path, branch: "dirty" })).rejects.toThrow(/uncommitted/)

		// Force removal works and drops the branch.
		await removeWorktree({ dir: created.path, branch: "dirty", force: true })
		expect(git(main, ["worktree", "list"]).includes(created.path)).toBe(false)
		expect(() => git(main, ["rev-parse", "--verify", "worktree-dirty"])).toThrow()
	})

	it("removes a clean worktree and its branch", async () => {
		const created = await createWorktree({ mainRoot: main, name: "clean-rm" })
		await removeWorktree({ dir: created.path, branch: "clean-rm" })
		expect(git(main, ["worktree", "list"]).includes(created.path)).toBe(false)
		expect(() => git(main, ["rev-parse", "--verify", "worktree-clean-rm"])).toThrow()
	})

	it("refuses to remove anything outside <.kimchi/worktrees>", async () => {
		await expect(removeWorktree({ dir: main })).rejects.toThrow(/not under/)
		const outside = join(main, "plain-dir")
		await mkdir(outside)
		await expect(removeWorktree({ dir: outside })).rejects.toThrow(/not under/)
	})
})

describe("listWorktreeDirsUnder", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("returns [] without a worktrees dir and for non-repo dirs", async () => {
		expect(listWorktreeDirsUnder(main)).toEqual([])
		const outside = await realpath(await mkdtemp(join(tmpdir(), "not-a-repo-")))
		try {
			expect(listWorktreeDirsUnder(outside)).toEqual([])
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	it("lists linked worktree dirs from the main checkout", async () => {
		const a = await createWorktree({ mainRoot: main, name: "one" })
		const b = await createWorktree({ mainRoot: main, name: "two" })
		try {
			const dirs = listWorktreeDirsUnder(main)
			expect(dirs).toEqual([a.path, b.path])
		} finally {
			git(main, ["worktree", "remove", "--force", a.path])
			git(main, ["worktree", "remove", "--force", b.path])
			git(main, ["branch", "-D", "worktree-one"])
			git(main, ["branch", "-D", "worktree-two"])
		}
	})

	it("returns [] when called from inside a worktree (no nesting)", async () => {
		const wt = await createWorktree({ mainRoot: main, name: "inner" })
		try {
			expect(listWorktreeDirsUnder(wt.path)).toEqual([])
		} finally {
			git(main, ["worktree", "remove", "--force", wt.path])
			git(main, ["branch", "-D", "worktree-inner"])
		}
	})
})

describe("applyWorktreeInclude", () => {
	let main: string
	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		await rm(main, { recursive: true, force: true })
	})

	it("is a no-op without .worktreeinclude", async () => {
		const copied = await applyWorktreeInclude(main, main)
		expect(copied).toEqual([])
	})

	it("copies tracked AND gitignored files matching the include patterns", async () => {
		await mkdir(join(main, ".kimchi"))
		await writeFile(join(main, ".kimchi", "config.json"), "{}")
		await writeFile(join(main, ".kimchi", "secrets.local.json"), "{}")
		await writeFile(join(main, ".gitignore"), ".kimchi/\n")
		git(main, ["add", ".gitignore"])
		git(main, ["commit", "-q", "-m", "ignore .kimchi"])
		// One committed (tracked), one left ignored-but-present — the whole
		// point of .worktreeinclude is that explicit intent overrides ignore.
		git(main, ["add", "-f", ".kimchi/config.json"])
		git(main, ["commit", "-q", "-m", "commit .kimchi/config.json"])

		const include = join(main, ".worktreeinclude")
		await writeFile(include, ".kimchi/config.json\n.kimchi/secrets.local.json\n")
		git(main, ["add", ".worktreeinclude"])
		git(main, ["commit", "-q", "-m", "worktree include"])

		const wt = await createWorktree({ mainRoot: main, name: "inc" })
		try {
			// createWorktree runs applyWorktreeInclude automatically.
			// config.json is tracked in the worktree (committed in main);
			// secrets.local.json was ignored in main, so it's copied as untracked.
			expect(git(wt.path, ["ls-files", "--cached"])).toContain(".kimchi/config.json")
			expect(git(wt.path, ["cat-file", "-p", "HEAD:.kimchi/config.json"])).toBe("{}")
			expect(git(wt.path, ["ls-files", "--others"])).toContain(".kimchi/secrets.local.json")
		} finally {
			git(main, ["worktree", "remove", "--force", wt.path])
			git(main, ["branch", "-D", "worktree-inc"])
		}
	})
})
