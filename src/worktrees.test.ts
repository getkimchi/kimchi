import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listWorktrees, prepareBranch, prepareWorktree } from "./worktrees.js"

let directory: string
let repo: string

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(cwd: string, message: string): string {
	git(cwd, "add", ".")
	git(
		cwd,
		"-c",
		"user.name=Worktree Test",
		"-c",
		"user.email=worktree@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		message,
	)
	return git(cwd, "rev-parse", "HEAD")
}

function repositoryState(): string[] {
	return [git(repo, "status", "--porcelain"), git(repo, "show-ref"), git(repo, "worktree", "list", "--porcelain")]
}

beforeEach(() => {
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) vi.stubEnv(name, undefined)
	directory = realpathSync(mkdtempSync(join(tmpdir(), "kimchi worktrees-")))
	repo = join(directory, "project")
	mkdirSync(repo)
	git(repo, "init", "-qb", "main")
	writeFileSync(join(repo, "tracked.txt"), "committed\n")
	commit(repo, "Initial commit")
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("prepareWorktree", () => {
	it("creates a branch and sibling checkout without carrying dirty source files", () => {
		const head = git(repo, "rev-parse", "HEAD")
		writeFileSync(join(repo, "tracked.txt"), "unfinished source edit\n")
		writeFileSync(join(repo, "untracked.txt"), "source only\n")
		const dirty = git(repo, "status", "--porcelain")

		const result = prepareWorktree(repo, "feature/isolated")

		expect(result).toEqual({
			path: join(`${repo}.worktrees`, "feature/isolated"),
			branch: "feature/isolated",
			created: true,
		})
		expect(git(result.path, "rev-parse", "HEAD")).toBe(head)
		expect(git(result.path, "branch", "--show-current")).toBe("feature/isolated")
		expect(readFileSync(join(result.path, "tracked.txt"), "utf8")).toBe("committed\n")
		expect(existsSync(join(result.path, "untracked.txt"))).toBe(false)
		expect(git(repo, "branch", "--show-current")).toBe("main")
		expect(git(repo, "status", "--porcelain")).toBe(dirty)
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("unfinished source edit\n")
	})

	it("checks out an existing local branch at its own commit", () => {
		const branchHead = git(repo, "rev-parse", "HEAD")
		git(repo, "branch", "existing")
		writeFileSync(join(repo, "newer.txt"), "main is ahead\n")
		commit(repo, "Advance main")

		const result = prepareWorktree(repo, "existing")

		expect(result.created).toBe(true)
		expect(git(result.path, "rev-parse", "HEAD")).toBe(branchHead)
		expect(git(result.path, "branch", "--show-current")).toBe("existing")
		expect(existsSync(join(result.path, "newer.txt"))).toBe(false)
	})

	it("reuses a registered worktree without touching its unfinished edits", () => {
		const path = join(directory, "existing checkout")
		git(repo, "worktree", "add", "-b", "existing", path)
		writeFileSync(join(path, "tracked.txt"), "other agent work\n")
		const before = repositoryState()

		expect(prepareWorktree(repo, "existing")).toEqual({ path, branch: "existing", created: false })
		expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("other agent work\n")
		expect(repositoryState()).toEqual(before)
	})

	it("uses the primary checkout location and caller HEAD from a linked worktree subdirectory", () => {
		const caller = join(directory, "another checkout")
		git(repo, "worktree", "add", "-b", "ongoing", caller)
		mkdirSync(join(caller, "subdirectory"))
		writeFileSync(join(caller, "subdirectory", "only-here.txt"), "caller commit\n")
		const callerHead = commit(caller, "Advance caller")

		const result = prepareWorktree(join(caller, "subdirectory"), "feature/from-caller")

		expect(result.path).toBe(join(`${repo}.worktrees`, "feature/from-caller"))
		expect(git(result.path, "rev-parse", "HEAD")).toBe(callerHead)
		expect(readFileSync(join(result.path, "subdirectory", "only-here.txt"), "utf8")).toBe("caller commit\n")
	})

	it("refuses the current checkout branch as an isolation target, including subdirectories", () => {
		mkdirSync(join(repo, "subdirectory"))
		const before = repositoryState()
		expect(() => prepareWorktree(join(repo, "subdirectory"), "main")).toThrow(/current.*checkout|different branch/i)
		expect(repositoryState()).toEqual(before)
	})

	it.each([
		"--force",
		"-topic",
		"../escape",
		"feature/../../escape",
		"/absolute",
		"with spaces",
		"",
	])("rejects invalid branch %j without changing Git state", (branch) => {
		const before = repositoryState()
		expect(() => prepareWorktree(repo, branch)).toThrow(/branch/i)
		expect(repositoryState()).toEqual(before)
	})

	it("rejects previous-checkout shorthand instead of creating a path for an expanded branch", () => {
		git(repo, "switch", "-c", "previous")
		git(repo, "switch", "main")
		const before = repositoryState()
		expect(() => prepareWorktree(repo, "@{-1}")).toThrow(/branch/i)
		expect(repositoryState()).toEqual(before)
	})

	it("refuses an occupied destination before creating the branch", () => {
		const path = join(`${repo}.worktrees`, "occupied")
		mkdirSync(path, { recursive: true })
		writeFileSync(join(path, "keep.txt"), "keep\n")
		const before = repositoryState()
		expect(() => prepareWorktree(repo, "occupied")).toThrow(/exists|occupied/i)
		expect(repositoryState()).toEqual(before)
		expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep\n")
	})

	it("refuses a symlinked destination parent instead of creating files outside the worktree folder", () => {
		const elsewhere = join(directory, "elsewhere")
		mkdirSync(elsewhere)
		symlinkSync(elsewhere, `${repo}.worktrees`, "dir")
		const before = repositoryState()
		expect(() => prepareWorktree(repo, "redirected")).toThrow(/symlink|symbolic link/i)
		expect(repositoryState()).toEqual(before)
		expect(existsSync(join(elsewhere, "redirected"))).toBe(false)
	})

	it.each(["locked", "prunable"])("refuses a %s worktree without repairing or changing it", (state) => {
		const path = join(directory, "unavailable")
		git(repo, "worktree", "add", "-b", "unavailable", path)
		if (state === "locked") git(repo, "worktree", "lock", "--reason", "another owner", path)
		else rmSync(path, { recursive: true })
		const before = repositoryState()
		expect(() => prepareWorktree(repo, "unavailable")).toThrow(new RegExp(state, "i"))
		expect(repositoryState()).toEqual(before)
	})
})

describe("listWorktrees", () => {
	it("reports registered paths, local branches, detached HEAD and lock/prune flags", () => {
		const locked = join(directory, "locked\ncheckout")
		const missing = join(directory, "missing")
		const detached = join(directory, "detached")
		git(repo, "worktree", "add", "-b", "feature/locked", locked)
		git(repo, "worktree", "lock", "--reason", "reserved", locked)
		git(repo, "worktree", "add", "-b", "missing", missing)
		rmSync(missing, { recursive: true })
		git(repo, "worktree", "add", "--detach", detached)

		expect(listWorktrees(repo)).toEqual(
			expect.arrayContaining([
				{ path: repo, branch: "main" },
				{ path: locked, branch: "feature/locked", locked: true },
				{ path: missing, branch: "missing", prunable: true },
				{ path: detached },
			]),
		)
	})
})

describe("prepareBranch", () => {
	it("creates a branch in the current checkout and retains its dirty files", () => {
		writeFileSync(join(repo, "tracked.txt"), "unfinished\n")
		writeFileSync(join(repo, "untracked.txt"), "keep\n")
		const dirty = git(repo, "status", "--porcelain")

		expect(prepareBranch(repo, "feature/branch-only")).toEqual({
			path: repo,
			branch: "feature/branch-only",
			created: true,
		})
		expect(git(repo, "branch", "--show-current")).toBe("feature/branch-only")
		expect(git(repo, "status", "--porcelain")).toBe(dirty)
		expect(existsSync(`${repo}.worktrees`)).toBe(false)
	})

	it("switches to an existing branch and can reuse the current branch", () => {
		git(repo, "branch", "existing")
		expect(prepareBranch(repo, "existing")).toEqual({ path: repo, branch: "existing", created: false })
		expect(git(repo, "branch", "--show-current")).toBe("existing")
		expect(prepareBranch(repo, "existing")).toEqual({ path: repo, branch: "existing", created: false })
	})

	it("refuses a branch checked out elsewhere and keeps source files unchanged", () => {
		git(repo, "worktree", "add", "-b", "busy", join(directory, "busy"))
		writeFileSync(join(repo, "tracked.txt"), "unfinished\n")
		const before = repositoryState()
		expect(() => prepareBranch(repo, "busy")).toThrow(/already|another|elsewhere/i)
		expect(repositoryState()).toEqual(before)
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("unfinished\n")
	})

	it("lets Git refuse a switch that would overwrite source changes", () => {
		git(repo, "switch", "-c", "different")
		writeFileSync(join(repo, "tracked.txt"), "different branch\n")
		commit(repo, "Different contents")
		git(repo, "switch", "main")
		writeFileSync(join(repo, "tracked.txt"), "unfinished source\n")
		const before = repositoryState()
		expect(() => prepareBranch(repo, "different")).toThrow(/overwrite|local changes/i)
		expect(repositoryState()).toEqual(before)
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("unfinished source\n")
	})
})

describe("Git preflight", () => {
	it.each([prepareWorktree, prepareBranch])("rejects non-repositories and repositories without a commit", (prepare) => {
		const unborn = join(directory, "unborn")
		mkdirSync(unborn)
		expect(() => prepare(unborn, "new-branch")).toThrow(/git repository/i)
		git(unborn, "init", "-qb", "main")
		expect(() => prepare(unborn, "new-branch")).toThrow(/commit|HEAD/i)
		expect(git(unborn, "branch", "--show-current")).toBe("main")
		expect(git(unborn, "for-each-ref")).toBe("")
	})

	it.each([
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
	])("rejects %s before any Git operation can use a redirected repository", (name) => {
		const before = repositoryState()
		vi.stubEnv(name, join(directory, "redirected"))
		for (const operation of [
			() => listWorktrees(repo),
			() => prepareWorktree(repo, "safe"),
			() => prepareBranch(repo, "safe"),
		]) {
			expect(operation).toThrow(new RegExp(`unset.*${name}|${name}.*unset`, "i"))
		}
		vi.stubEnv(name, undefined)
		expect(repositoryState()).toEqual(before)
	})
})
