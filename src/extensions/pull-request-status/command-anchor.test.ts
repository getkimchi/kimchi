import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { anchorDirectory, directoryLabel, observedCommandDirectory } from "./command-anchor.js"

/** Real temp-directory roots, so realpath comparisons behave as in production. */
let root: string
let base: string
/** Repositories created outside `root`, removed once the file's suites finish. */
const created: string[] = []

function scratch(name: string): string {
	const path = mkdtempSync(join(tmpdir(), `kimchi-pr-anchor-${name}-`))
	created.push(path)
	return realpathSync(path)
}

beforeEach(() => {
	base = scratch("base").replace(/\/[^/]+$/, "")
	root = scratch("root")
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
	for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("observedCommandDirectory", () => {
	it("resolves an absolute cd path", () => {
		const target = scratch("absolute")
		expect(observedCommandDirectory(`cd ${target}`, root)).toBe(target)
	})

	it("resolves a relative cd path against the base cwd", () => {
		expect(observedCommandDirectory("cd ../..", join(base, "a", "b"))).toBe(realpathSync(base))
		expect(observedCommandDirectory("cd .", root)).toBe(realpathSync(root))
	})

	it("resolves a quoted cd path with spaces", () => {
		const target = scratch("with space")
		expect(observedCommandDirectory(`cd "${target}" && pnpm test`, root)).toBe(target)
		expect(observedCommandDirectory(`cd '${target}' && pnpm test`, root)).toBe(target)
	})

	it("takes the last cd of a compound command", () => {
		const first = scratch("first")
		const second = scratch("second")
		expect(observedCommandDirectory(`cd ${first} && cd ${second} && pnpm test`, root)).toBe(second)
		expect(observedCommandDirectory(`cd ${first}; cd ${second}`, root)).toBe(second)
		expect(observedCommandDirectory(`cd ${first} || cd ${second} || pnpm test`, root)).toBe(second)
		expect(observedCommandDirectory(`cd ${first} | cat`, root)).toBe(first)
	})

	it("resolves git -C in both spellings, after leading global flags", () => {
		const target = scratch("gitc")
		expect(observedCommandDirectory(`git -C ${target} status`, root)).toBe(target)
		expect(observedCommandDirectory(`git -C${target} status`, root)).toBe(target)
		expect(observedCommandDirectory(`git --no-pager -C ${target} log`, root)).toBe(target)
		// Keep `-Cpath` glued only when unquoted: a space inside it would be a separate word anyway.
		expect(observedCommandDirectory(`git -c core.editor=true -C ${target} log`, root)).toBe(target)
	})

	it("resolves git -C glued to a quoted path", () => {
		const target = scratch("gitc-quoted")
		expect(observedCommandDirectory(`git -C"${target}" status`, root)).toBe(target)
	})

	it("resolves ~ against the home directory", () => {
		expect(observedCommandDirectory("cd ~", root)).toBe(realpathSync(homedir()))
	})

	it("rejects cd flags, substitutions and non-leading matches", () => {
		expect(observedCommandDirectory("cd -", root)).toBeUndefined()
		expect(observedCommandDirectory("cd", root)).toBeUndefined()
		expect(observedCommandDirectory("cd $WORKTREE", root)).toBeUndefined()
		expect(observedCommandDirectory("cd $(pwd)", root)).toBeUndefined()
		expect(observedCommandDirectory("cd `pwd`", root)).toBeUndefined()
		expect(observedCommandDirectory("cd /tmp /var", root)).toBeUndefined()
		expect(observedCommandDirectory('echo "cd /definitely/not/here"', root)).toBeUndefined()
		expect(observedCommandDirectory("echo cd /definitely/not/here", root)).toBeUndefined()
		expect(observedCommandDirectory(`grep -c cd ${root}`, root)).toBeUndefined()
		expect(observedCommandDirectory(`git status -C ${root}`, root)).toBeUndefined()
		expect(observedCommandDirectory("ls", root)).toBeUndefined()
	})
})

describe("anchorDirectory with a real repository", () => {
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

	/** A repository with one linked worktree, both outside `root` so they survive its cleanup. */
	function repository(name: string): { repo: string; worktree: string } {
		const repo = scratch(name)
		git(repo, "init", "-q")
		git(repo, "config", "user.name", "Anchor Test")
		git(repo, "config", "user.email", "anchor@example.invalid")
		git(repo, "commit", "-q", "--allow-empty", "-m", "Baseline")
		const worktree = scratch(`${name}-tree`)
		git(repo, "worktree", "add", "-q", "-b", "feature", worktree)
		return { repo, worktree }
	}

	it("anchors on an observed directory inside or equal to a linked worktree", async () => {
		const { repo, worktree } = repository("repo")
		const signal = new AbortController().signal
		expect(await anchorDirectory(repo, worktree, signal, Date.now() + 5000)).toBe(worktree)
		const nested = join(worktree, "nested")
		mkdirSync(nested)
		expect(await anchorDirectory(repo, nested, signal, Date.now() + 5000)).toBe(nested)
	})

	it("falls back to cwd for a foreign repository, a missing path or no observation", async () => {
		const { repo, worktree } = repository("session")
		const foreign = repository("foreign").worktree
		const signal = new AbortController().signal
		expect(await anchorDirectory(repo, foreign, signal, Date.now() + 5000)).toBe(repo)
		expect(await anchorDirectory(repo, join(root, "missing"), signal, Date.now() + 5000)).toBe(repo)
		expect(await anchorDirectory(repo, undefined, signal, Date.now() + 5000)).toBe(repo)
		expect(await anchorDirectory(repo, worktree, signal, Date.now() + 5000)).toBe(worktree)
	})

	it("falls back to cwd when cwd is not a git repository", async () => {
		const plain = scratch("plain")
		const target = scratch("plain-target")
		expect(await anchorDirectory(plain, target, new AbortController().signal, Date.now() + 5000)).toBe(plain)
	})
})

describe("directoryLabel", () => {
	it("labels an anchor inside the session directory relatively, outside by basename", () => {
		const inside = join(root, "worktree")
		mkdirSync(inside)
		expect(directoryLabel(root, inside)).toBe("worktree")
		const outside = scratch("outside")
		expect(directoryLabel(root, outside)).toBe(basename(outside))
	})
})
