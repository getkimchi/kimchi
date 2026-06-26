import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	buildIncludeList,
	excludesBaseFilePattern,
	listGitDeletedFiles,
	listGitTrackedFiles,
	listGitUntrackedFiles,
	walkGitDir,
} from "./include-list.js"

interface FakeChild extends EventEmitter {
	stdout: Readable
	stderr: Readable
	stdin: null
}

function makeFakeChild(opts: { stdout?: string; exitCode: number; errorAfter?: boolean }): FakeChild {
	const child = new EventEmitter() as FakeChild
	child.stdout = Readable.from([opts.stdout ?? ""], { objectMode: false })
	child.stderr = Readable.from([""], { objectMode: false })
	child.stdin = null
	setImmediate(() => {
		if (opts.errorAfter) child.emit("error", new Error("ENOENT"))
		child.emit("close", opts.exitCode)
	})
	return child
}

describe("excludesBaseFilePattern", () => {
	it("matches BASE_EXCLUDE_GLOBS file-shape entries by basename", () => {
		expect(excludesBaseFilePattern(".env")).toBe(true)
		expect(excludesBaseFilePattern("src/.env")).toBe(true)
		expect(excludesBaseFilePattern(".envrc")).toBe(true)
		expect(excludesBaseFilePattern(".DS_Store")).toBe(true)
		expect(excludesBaseFilePattern("nested/dir/.DS_Store")).toBe(true)
	})

	it("matches .env.* basenames anywhere in the tree", () => {
		expect(excludesBaseFilePattern(".env.local")).toBe(true)
		expect(excludesBaseFilePattern("src/.env.production")).toBe(true)
	})

	it("matches *.log and *.tmp extensions anywhere", () => {
		expect(excludesBaseFilePattern("app.log")).toBe(true)
		expect(excludesBaseFilePattern("logs/access.log")).toBe(true)
		expect(excludesBaseFilePattern("scratch/foo.tmp")).toBe(true)
	})

	it("does not match arbitrary files", () => {
		expect(excludesBaseFilePattern("src/index.ts")).toBe(false)
		expect(excludesBaseFilePattern("README.md")).toBe(false)
		expect(excludesBaseFilePattern(".envoy")).toBe(false) // not .env nor .env.*
		expect(excludesBaseFilePattern("environment.ts")).toBe(false)
	})
})

describe("listGitTrackedFiles", () => {
	it("returns NUL-split stdout lines on success", async () => {
		const fakeSpawn: typeof spawn = (() =>
			makeFakeChild({ stdout: "src/a.ts\0src/b.ts\0README.md\0", exitCode: 0 })) as unknown as typeof spawn
		const result = await listGitTrackedFiles("/dummy", undefined, fakeSpawn)
		expect(result).toEqual(["src/a.ts", "src/b.ts", "README.md"])
	})

	it("invokes `git ls-files --cached -z`", async () => {
		let calledArgs: readonly string[] | undefined
		const fakeSpawn: typeof spawn = ((_cmd: string, args?: readonly string[]) => {
			calledArgs = args
			return makeFakeChild({ stdout: "", exitCode: 0 })
		}) as unknown as typeof spawn
		await listGitTrackedFiles("/dummy", undefined, fakeSpawn)
		expect(calledArgs).toEqual(["ls-files", "--cached", "-z"])
	})

	it("returns [] when git exits non-zero (not a repo)", async () => {
		const fakeSpawn: typeof spawn = (() => makeFakeChild({ exitCode: 128 })) as unknown as typeof spawn
		expect(await listGitTrackedFiles("/dummy", undefined, fakeSpawn)).toEqual([])
	})

	it("returns [] when git is missing (ENOENT)", async () => {
		const fakeSpawn: typeof spawn = (() => makeFakeChild({ exitCode: 0, errorAfter: true })) as unknown as typeof spawn
		expect(await listGitTrackedFiles("/dummy", undefined, fakeSpawn)).toEqual([])
	})
})

describe("listGitDeletedFiles", () => {
	it("invokes `git ls-files --deleted -z` and NUL-splits stdout", async () => {
		let calledArgs: readonly string[] | undefined
		const fakeSpawn: typeof spawn = ((_cmd: string, args?: readonly string[]) => {
			calledArgs = args
			return makeFakeChild({ stdout: "src/gone.ts\0src/also-gone.test.ts\0", exitCode: 0 })
		}) as unknown as typeof spawn
		const result = await listGitDeletedFiles("/dummy", undefined, fakeSpawn)
		expect(calledArgs).toEqual(["ls-files", "--deleted", "-z"])
		expect(result).toEqual(["src/gone.ts", "src/also-gone.test.ts"])
	})

	it("returns [] when git exits non-zero", async () => {
		const fakeSpawn: typeof spawn = (() => makeFakeChild({ exitCode: 128 })) as unknown as typeof spawn
		expect(await listGitDeletedFiles("/dummy", undefined, fakeSpawn)).toEqual([])
	})
})

describe("listGitUntrackedFiles", () => {
	it("invokes `git ls-files --others --exclude-standard -z`", async () => {
		let calledArgs: readonly string[] | undefined
		const fakeSpawn: typeof spawn = ((_cmd: string, args?: readonly string[]) => {
			calledArgs = args
			return makeFakeChild({ stdout: "scratch/.env\0", exitCode: 0 })
		}) as unknown as typeof spawn
		const result = await listGitUntrackedFiles("/dummy", undefined, fakeSpawn)
		expect(calledArgs).toEqual(["ls-files", "--others", "--exclude-standard", "-z"])
		expect(result).toEqual(["scratch/.env"])
	})
})

describe("walkGitDir", () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "kimchi-walkgit-"))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it("returns paths relative to cwd, prefixed with .git/", async () => {
		await mkdir(join(root, ".git", "objects", "pack"), { recursive: true })
		await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
		await writeFile(join(root, ".git", "config"), "[core]\n")
		await writeFile(join(root, ".git", "objects", "pack", "pack-abc.idx"), "x")
		const paths = (await walkGitDir(root)).sort()
		expect(paths).toEqual([".git/HEAD", ".git/config", ".git/objects/pack/pack-abc.idx"].sort())
	})

	it("returns [] when .git is missing", async () => {
		expect(await walkGitDir(root)).toEqual([])
	})

	it("skips symlinks", async () => {
		await mkdir(join(root, ".git"), { recursive: true })
		await writeFile(join(root, ".git", "real.txt"), "x")
		await symlink(join(root, ".git", "real.txt"), join(root, ".git", "link.txt"))
		const paths = await walkGitDir(root)
		expect(paths).toEqual([".git/real.txt"])
	})
})

describe("buildIncludeList", () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "kimchi-includelist-"))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	// Dispatch fake-spawner based on which `git ls-files` mode flag is
	// in the argv — buildIncludeList fires several calls and we want
	// distinct stdout for each. `deleted` defaults to "" so existing
	// cases (which don't exercise the deleted filter) are unaffected.
	function spawnDispatch(cached: string, others: string, deleted = ""): typeof spawn {
		return ((_cmd: string, args?: readonly string[]) => {
			const stdout = args?.includes("--cached") ? cached : args?.includes("--deleted") ? deleted : others
			return makeFakeChild({ stdout, exitCode: 0 })
		}) as unknown as typeof spawn
	}

	it("composes tracked + untracked + .git walk and applies the base-pattern filter only to untracked", async () => {
		await mkdir(join(root, ".git"), { recursive: true })
		await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
		const fakeSpawn = spawnDispatch("src/index.ts\0README.md\0", "logs/app.log\0scratch/.DS_Store\0extra/notes.md\0")
		const list = await buildIncludeList(root, undefined, fakeSpawn)
		// Tracked pass through, .git pass through, untracked .log/.DS_Store dropped.
		expect(list.sort()).toEqual(["src/index.ts", "README.md", "extra/notes.md", ".git/HEAD"].sort())
	})

	it("excludes tracked files that are deleted from the working tree (rsync code-23 fix)", async () => {
		// A tracked file the user `rm`'d (deletion not yet staged) still shows
		// under --cached but also under --deleted; it must not reach rsync.
		const fakeSpawn = spawnDispatch("src/a.ts\0src/gone.test.ts\0README.md\0", "", "src/gone.test.ts\0")
		const list = await buildIncludeList(root, undefined, fakeSpawn)
		expect(list).not.toContain("src/gone.test.ts")
		expect(list.sort()).toEqual(["src/a.ts", "README.md"].sort())
	})

	it("regression: tracked .env.example / .envrc / log.log survive the basename filter", async () => {
		// kubecast regression — these are all tracked files that were
		// being filtered out, causing the remote's `git status` to show
		// them as deleted.
		const fakeSpawn = spawnDispatch(
			"services/foo/.env.example\0services/bar/.envrc\0services/baz/log.log\0src/index.ts\0",
			"",
		)
		const list = await buildIncludeList(root, undefined, fakeSpawn)
		expect(list.sort()).toEqual(
			["services/foo/.env.example", "services/bar/.envrc", "services/baz/log.log", "src/index.ts"].sort(),
		)
	})

	it("drops an untracked .env even when a tracked .env.example exists", async () => {
		// Safety net intact: untracked .env still filtered out.
		const fakeSpawn = spawnDispatch("services/foo/.env.example\0", "scratch/.env\0")
		const list = await buildIncludeList(root, undefined, fakeSpawn)
		expect(list).toEqual(["services/foo/.env.example"])
	})

	it("returns [] when neither git nor .git produce anything", async () => {
		const fakeSpawn: typeof spawn = (() => makeFakeChild({ exitCode: 128 })) as unknown as typeof spawn
		const list = await buildIncludeList(root, undefined, fakeSpawn)
		expect(list).toEqual([])
	})
})
