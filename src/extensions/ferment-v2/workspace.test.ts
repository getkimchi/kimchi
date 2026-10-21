import { execFile as execFileCallback, spawn } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	BASELINE_WORKTREE_PREFIX,
	type BaselineWorktree,
	gatherWorkspaceFacts,
	listSnapshotPaths,
	pruneStaleBaselineWorktrees,
	reserveBaselineWorktree,
	snapshotWorkspace,
} from "./workspace.js"

const execFile = promisify(execFileCallback)

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, encoding: "utf-8" })
	return stdout
}

/** Reserve and check out a baseline worktree; undefined (reservation disposed) when the checkout fails. */
async function checkedOutWorktree(repo: string, baseline: string): Promise<BaselineWorktree | undefined> {
	const worktree = reserveBaselineWorktree(repo, baseline)
	if (!worktree) return undefined
	if (await worktree.ensure()) return worktree
	await worktree.dispose()
	return undefined
}

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
	tempDirs.length = 0
})

/** A fresh git repository with one commit, ready to be dirtied. */
async function makeRepo(): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-"))
	tempDirs.push(repo)
	await git(repo, ["init", "-q"])
	await git(repo, ["config", "user.email", "test@example.com"])
	await git(repo, ["config", "user.name", "Test"])
	return repo
}

async function commitAll(repo: string, message: string): Promise<void> {
	await git(repo, ["add", "-A"])
	await git(repo, ["commit", "-q", "-m", message])
}

/** The first `git` binary on PATH (resolved before a test's shim can shadow it). */
function findRealGit(): string {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue
		const candidate = join(dir, "git")
		if (existsSync(candidate)) return realpathSync(candidate)
	}
	throw new Error("no git binary found on PATH")
}

/** Quote a string for safe interpolation into a /bin/sh script. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Run `body` with a `git` shim first on PATH. `shimScript` is a /bin/sh
 * fragment (with `$REAL` = the real git binary) that runs before the default
 * `exec` of the real git, so tests can fail one specific command or hold a
 * command's exit open while the module still awaits it. The real PATH is
 * restored afterwards; everything else on PATH keeps working.
 */
async function withGitShim(shimScript: string, body: () => Promise<void>): Promise<void> {
	const realGit = shellQuote(findRealGit())
	const shimDir = mkdtempSync(join(tmpdir(), "kimchi-v2-git-shim-"))
	tempDirs.push(shimDir)
	writeFileSync(join(shimDir, "git"), `#!/bin/sh\nREAL=${realGit}\n${shimScript}\nexec "$REAL" "$@"\n`)
	chmodSync(join(shimDir, "git"), 0o755)
	const previousPath = process.env.PATH
	process.env.PATH = `${shimDir}${delimiter}${previousPath}`
	try {
		await body()
	} finally {
		process.env.PATH = previousPath
	}
}

/**
 * Run `body` with a `git` shim on PATH that fails (exit 1) every command
 * whose leading arguments equal `fail` — simulating a git failure for
 * exactly those commands while everything else still works.
 */
async function withFailingGitCommands(fail: readonly string[], body: () => Promise<void>): Promise<void> {
	const test = fail.map((arg, index) => `[ "$${index + 1}" = ${shellQuote(arg)} ]`).join(" && ")
	await withGitShim(
		`if ${test}; then
	echo "simulated git failure" >&2
	exit 1
fi`,
		body,
	)
}

describe("snapshotWorkspace", () => {
	it("snapshots a repository where git has no author identity (fresh containers, CI images)", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		writeFileSync(join(repo, "b.txt"), "untracked\n")
		// No identity anywhere: no repository user, an empty global config, no
		// system config, no identity environment, and no hostname-derived
		// fallback — exactly what `git commit-tree` sees in a fresh container.
		await git(repo, ["config", "--unset", "user.name"])
		await git(repo, ["config", "--unset", "user.email"])
		await git(repo, ["config", "user.useConfigOnly", "true"])
		const emptyGlobal = join(repo, ".git", "empty-global-config")
		writeFileSync(emptyGlobal, "")
		vi.stubEnv("GIT_CONFIG_GLOBAL", emptyGlobal)
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
		for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
			vi.stubEnv(name, undefined)
		}
		try {
			// Precondition: git itself refuses to create a commit here.
			await expect(git(repo, ["commit-tree", "-m", "probe", await git(repo, ["write-tree"])])).rejects.toThrow()

			const snapshot = await snapshotWorkspace(repo)

			expect(snapshot?.commit).toMatch(/^[0-9a-f]{40}$/)
			expect(await git(repo, ["show", "-s", "--format=%an <%ae>", snapshot?.commit ?? ""])).toContain(
				"kimchi ferment-v2 <ferment-v2@kimchi.invalid>",
			)
			expect(await git(repo, ["ls-tree", "--name-only", snapshot?.commit ?? ""])).toContain("b.txt")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("leaves git status, the index, refs, and HEAD byte-identical on a dirty tree with untracked files", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "tracked.txt"), "original\n")
		await commitAll(repo, "initial")
		// Dirty on purpose: unstaged modification, staged new file, untracked
		// file, untracked nested directory.
		writeFileSync(join(repo, "tracked.txt"), "modified\n")
		writeFileSync(join(repo, "staged.txt"), "staged\n")
		await git(repo, ["add", "staged.txt"])
		writeFileSync(join(repo, "untracked.txt"), "untracked\n")
		mkdirSync(join(repo, "untracked-dir"))
		writeFileSync(join(repo, "untracked-dir", "nested.txt"), "nested\n")

		const statusBefore = await git(repo, ["status", "--porcelain=v1", "-z"])
		const indexPath = resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).trim())
		const indexBefore = readFileSync(indexPath)
		const refsBefore = await git(repo, ["for-each-ref"])
		const headBefore = await git(repo, ["rev-parse", "HEAD"])

		const snapshot = await snapshotWorkspace(repo)

		expect(snapshot).toBeDefined()
		expect(await git(repo, ["status", "--porcelain=v1", "-z"])).toBe(statusBefore)
		expect(readFileSync(indexPath)).toEqual(indexBefore)
		expect(await git(repo, ["for-each-ref"])).toBe(refsBefore)
		expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore)
		// The snapshot commit itself carries the untracked files.
		const listing = await git(repo, ["ls-tree", "-r", "--name-only", snapshot?.commit ?? ""])
		expect(listing).toContain("untracked.txt")
		expect(listing).toContain("untracked-dir/nested.txt")
		expect(listing).toContain("staged.txt")
	})

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-nongit-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "file.txt"), "no git\n")
		expect(await snapshotWorkspace(dir)).toBeUndefined()
	})
})

describe("gatherWorkspaceFacts", () => {
	it("lists added, modified, deleted, and renamed files against the baseline, untracked included", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "keep.txt"), "keep\n")
		writeFileSync(join(repo, "modify.txt"), "original\n")
		writeFileSync(join(repo, "delete.txt"), "delete\n")
		writeFileSync(join(repo, "rename-me.txt"), "rename\n")
		writeFileSync(join(repo, "untracked-start.txt"), "untracked\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		writeFileSync(join(repo, "modify.txt"), "modified\n")
		rmSync(join(repo, "delete.txt"))
		await git(repo, ["mv", "rename-me.txt", "renamed.txt"])
		writeFileSync(join(repo, "new-file.txt"), "new\n")

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		expect(facts).toBeDefined()
		const byPath = new Map(facts?.changedFiles.map((file) => [file.path, file]))
		expect(byPath.get("modify.txt")).toMatchObject({ status: "M" })
		expect(byPath.get("delete.txt")).toMatchObject({ status: "D" })
		expect(byPath.get("renamed.txt")).toMatchObject({ status: "R", from: "rename-me.txt" })
		expect(byPath.get("new-file.txt")).toMatchObject({ status: "A" })
		expect(facts?.baseline).toBe(baseline?.commit)
		expect(facts?.diffStat).toContain("new-file.txt")
		expect(facts?.truncated).toBe(false)
	})

	it("reports branch, HEAD, commits since baseline, and uncommitted files", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		await git(repo, ["commit", "-q", "--allow-empty", "-m", "work"])
		await git(repo, ["commit", "-q", "--allow-empty", "-m", "more work"])
		writeFileSync(join(repo, "dirty.txt"), "dirty\n")
		// Untracked files inside a fresh directory: the default status mode
		// collapses the directory to one record, and a repository's
		// status.showUntrackedFiles=no would hide untracked files entirely —
		// the count must still cover every file, like the snapshot does.
		mkdirSync(join(repo, "dirty-dir", "nested"), { recursive: true })
		writeFileSync(join(repo, "dirty-dir", "one.txt"), "one\n")
		writeFileSync(join(repo, "dirty-dir", "nested", "two.txt"), "two\n")
		await git(repo, ["config", "status.showUntrackedFiles", "no"])
		const current = await snapshotWorkspace(repo)

		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		expect(facts?.git.commitsSinceBaseline).toBe(2)
		expect(facts?.git.branch).toBeTruthy()
		expect(facts?.git.head).toMatch(/^[0-9a-f]{40}$/)
		expect(facts?.git.uncommittedFiles).toBe(3)
	})

	it("counts a staged rename as one uncommitted file even when its source path contains a space", async () => {
		const repo = await makeRepo()
		// The source path has a space at index 2 (`my file.txt`): porcelain -z
		// emits the rename record followed by the bare source field, and that
		// bare field otherwise passes the `XY ` shape check and is counted as
		// a second uncommitted file.
		writeFileSync(join(repo, "my file.txt"), "rename me\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		await git(repo, ["mv", "my file.txt", "renamed.txt"])
		const current = await snapshotWorkspace(repo)

		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		expect(facts?.changedFiles).toEqual([{ status: "R", path: "renamed.txt", from: "my file.txt" }])
		expect(facts?.git.uncommittedFiles).toBe(1)
	})

	it("flags deleted, renamed, and modified pre-existing test files, added skip markers, and kept-probe changes", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.test.ts"), "it('a', () => {})\n")
		writeFileSync(join(repo, "b.test.ts"), "it('b', () => {})\n")
		writeFileSync(join(repo, "c.test.ts"), "it('c', () => {})\n")
		// Kept probes from an earlier verifier run — present at the baseline
		// (a replaced ferment re-baselines the tree with them in it).
		writeFileSync(join(repo, "kept-modified.test.ts"), "it('km', () => {})\n")
		writeFileSync(join(repo, "kept-deleted.test.ts"), "it('kd', () => {})\n")
		writeFileSync(join(repo, "kept-renamed.test.ts"), "it('kr', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		rmSync(join(repo, "a.test.ts"))
		await git(repo, ["mv", "b.test.ts", "bb.test.ts"])
		writeFileSync(join(repo, "c.test.ts"), "it('c', () => {})\nit.skip('c skipped', () => {})\n")
		writeFileSync(join(repo, "new.test.ts"), "xit('never runs', () => {})\n")
		writeFileSync(join(repo, "kept-modified.test.ts"), "it('km changed', () => {})\n")
		rmSync(join(repo, "kept-deleted.test.ts"))
		await git(repo, ["mv", "kept-renamed.test.ts", "kept-elsewhere.test.ts"])

		const current = await snapshotWorkspace(repo)
		const keptProbes = [
			{ path: "kept-modified.test.ts", requirementId: "R1" },
			{ path: "kept-deleted.test.ts", requirementId: "R2" },
			{ path: "kept-renamed.test.ts", requirementId: "R3" },
		]
		const facts = await gatherWorkspaceFacts(
			repo,
			baseline?.commit ?? "",
			current ?? { commit: "", tree: "" },
			keptProbes,
		)

		const flags = facts?.testInventoryFlags ?? []
		const flag = (kind: string, path: string) => flags.find((entry) => entry.kind === kind && entry.path === path)
		expect(flag("test_file_deleted", "a.test.ts")).toBeDefined()
		expect(flag("test_file_renamed", "bb.test.ts")).toMatchObject({ detail: "was b.test.ts" })
		expect(flag("test_file_modified", "c.test.ts")).toBeDefined()
		expect(flag("skip_marker_added", "c.test.ts")).toBeDefined()
		expect(flag("kept_probe_modified", "kept-modified.test.ts")).toMatchObject({ requirementId: "R1" })
		expect(flag("kept_probe_deleted", "kept-deleted.test.ts")).toMatchObject({ requirementId: "R2" })
		expect(flag("kept_probe_deleted", "kept-renamed.test.ts")).toMatchObject({
			requirementId: "R3",
			detail: "renamed to kept-elsewhere.test.ts",
		})
		// The new test file's marker fires too, and every flag carries a
		// unique sequential fN ID.
		expect(flag("skip_marker_added", "new.test.ts")).toBeDefined()
		// Kept probes fire their own kinds, not the generic test-file kinds.
		expect(flag("test_file_deleted", "kept-deleted.test.ts")).toBeUndefined()
		expect(flag("test_file_modified", "kept-modified.test.ts")).toBeUndefined()
		const ids = flags.map((entry) => entry.id)
		expect(ids.length).toBeGreaterThan(0)
		expect(new Set(ids).size).toBe(ids.length)
		for (const id of ids) expect(id).toMatch(/^f\d+$/)
	})

	it("detects skip and only markers across ecosystems in added lines", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "test_py.py"), "def test_x():\n    pass\n")
		writeFileSync(join(repo, "main_test.go"), "func TestX(t *testing.T) {}\n")
		writeFileSync(join(repo, "stable.test.ts"), "it.skip('already skipped', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		writeFileSync(join(repo, "test_py.py"), "import pytest\n@pytest.mark.skip(reason='no')\ndef test_x():\n    pass\n")
		writeFileSync(join(repo, "main_test.go"), "func TestX(t *testing.T) { t.Skip('flaky') }\n")
		writeFileSync(join(repo, "new.test.ts"), "it.only('focused', () => {})\n")

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const markerPaths = (facts?.testInventoryFlags ?? [])
			.filter((flag) => flag.kind === "skip_marker_added")
			.map((flag) => flag.path)
		expect(markerPaths).toEqual(expect.arrayContaining(["test_py.py", "main_test.go", "new.test.ts"]))
		// A marker already present at the baseline is not an addition: the
		// unchanged file carries no flag at all.
		expect((facts?.testInventoryFlags ?? []).some((flag) => flag.path === "stable.test.ts")).toBe(false)
	})

	it("flags skip markers added to inline Rust tests in production source files", async () => {
		const repo = await makeRepo()
		// The canonical Rust layout keeps tests inline in production sources
		// (`#[cfg(test)] mod tests` in src/), invisible to every test-file path
		// heuristic — the marker scan must reach them anyway, or an `#[ignore]`
		// would disable a test without a flag for the verifier to address.
		mkdirSync(join(repo, "src"))
		const lib = [
			"pub fn add(a: i32, b: i32) -> i32 {",
			"    a + b",
			"}",
			"",
			"#[cfg(test)]",
			"mod tests {",
			"    use super::*;",
			"",
			"    #[test]",
			"    fn adds() {",
			"        assert_eq!(add(1, 2), 3);",
			"    }",
			"}",
			"",
		].join("\n")
		const utils = [
			"pub fn double(x: i32) -> i32 {",
			"    x * 2",
			"}",
			"",
			"pub fn triple(x: i32) -> i32 {",
			"    x * 3",
			"}",
			"",
			"#[cfg(test)]",
			"mod tests {",
			"    use super::*;",
			"",
			"    #[test]",
			"    fn doubles() {",
			"        assert_eq!(double(2), 4);",
			"    }",
			"",
			"    #[test]",
			"    fn triples() {",
			"        assert_eq!(triple(3), 9);",
			"    }",
			"}",
			"",
		].join("\n")
		writeFileSync(join(repo, "src", "lib.rs"), lib)
		writeFileSync(join(repo, "src", "utils.rs"), utils)
		writeFileSync(join(repo, "src", "plain.rs"), "pub fn unchanged() {}\n")
		writeFileSync(join(repo, "main.py"), "def main():\n    pass\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		writeFileSync(
			join(repo, "src", "lib.rs"),
			lib.replace("    #[test]\n    fn adds", "    #[test]\n    #[ignore]\n    fn adds"),
		)
		await git(repo, ["mv", "src/utils.rs", "src/helpers.rs"])
		writeFileSync(
			join(repo, "src", "helpers.rs"),
			utils.replace("    #[test]\n    fn doubles", '    #[test]\n    #[ignore = "slow"]\n    fn doubles'),
		)
		writeFileSync(
			join(repo, "src", "new.rs"),
			"#[cfg(test)]\nmod tests {\n    #[test]\n    #[ignore]\n    fn never() {}\n}\n",
		)
		// A plain production edit without markers, and a marker in a non-test
		// file of an ecosystem the heuristic does cover — neither flags.
		writeFileSync(join(repo, "src", "plain.rs"), "pub fn unchanged() {}\npub fn more() {}\n")
		writeFileSync(join(repo, "main.py"), "import pytest\n@pytest.mark.skip(reason='no')\ndef main():\n    pass\n")

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		const marker = (path: string) => flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === path)
		// Inline tests in modified, renamed, and newly added Rust sources are
		// all scanned; `#[ignore = "reason"]` is the same marker.
		expect(marker("src/lib.rs")).toBe(true)
		expect(marker("src/helpers.rs")).toBe(true)
		expect(marker("src/new.rs")).toBe(true)
		// Rust sources are scanned for markers, not classified as test files:
		// a plain production edit fires nothing, and the path heuristic keeps
		// governing the other ecosystems — the pytest marker in a non-test
		// `main.py` stays silent.
		expect(flags.some((flag) => flag.path === "src/plain.rs")).toBe(false)
		expect(flags.some((flag) => flag.path === "main.py")).toBe(false)
	})

	it("matches root-relative baseline paths and markers from a session subdirectory", async () => {
		const repo = await makeRepo()
		mkdirSync(join(repo, "sub"))
		writeFileSync(join(repo, "a.test.ts"), "it('a', () => {})\n")
		writeFileSync(join(repo, "sub", "b.test.ts"), "it('b', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		rmSync(join(repo, "a.test.ts"))
		writeFileSync(join(repo, "sub", "b.test.ts"), "it('b', () => {})\nit.skip('b skipped', () => {})\n")

		const current = await snapshotWorkspace(repo)
		// The session runs inside the repository's subdirectory: paths must
		// still line up root-relative on both sides of the comparison.
		const facts = await gatherWorkspaceFacts(
			join(repo, "sub"),
			baseline?.commit ?? "",
			current ?? { commit: "", tree: "" },
			[],
		)

		const flags = facts?.testInventoryFlags ?? []
		expect(flags.some((flag) => flag.kind === "test_file_deleted" && flag.path === "a.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "sub/b.test.ts")).toBe(true)
		expect(facts?.changedFiles).toEqual(
			expect.arrayContaining([
				{ status: "D", path: "a.test.ts" },
				{ status: "M", path: "sub/b.test.ts" },
			]),
		)
	})

	it("flags a skip marker added while renaming a test file, against its baseline source", async () => {
		const repo = await makeRepo()
		// Four lines with one changing later: rename detection needs the
		// similarity to stay above its threshold.
		const original =
			"describe('suite', () => {\n  it('works', () => { expect(1).toBe(1) })\n  it('other', () => { expect(2).toBe(2) })\n})\n"
		writeFileSync(join(repo, "old.test.ts"), original)
		writeFileSync(join(repo, "keep-marker.test.ts"), "it.skip('already skipped', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		await git(repo, ["mv", "old.test.ts", "new.test.ts"])
		writeFileSync(join(repo, "new.test.ts"), original.replace("it('works'", "it.skip('works'"))
		await git(repo, ["mv", "keep-marker.test.ts", "kept.test.ts"])

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		const renamed = flags.find((flag) => flag.kind === "test_file_renamed" && flag.path === "new.test.ts")
		expect(renamed).toMatchObject({ detail: "was old.test.ts" })
		// The rename does not conceal the added disabling marker.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "new.test.ts")).toBe(true)
		// A rename that keeps a pre-existing marker is not an addition.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "kept.test.ts")).toBe(false)
	})

	it("keeps marker-scan eligibility when a test file is renamed out of the path heuristic", async () => {
		const repo = await makeRepo()
		// `tests/` matches the test-file heuristic; `cases/` matches none. A
		// runner with a custom glob (or explicit imports) still executes the
		// renamed file, so an added skip marker there must not slip past the
		// scan just because the destination path stopped looking like a test.
		mkdirSync(join(repo, "tests"))
		const original =
			"describe('suite', () => {\n  it('works', () => { expect(1).toBe(1) })\n  it('other', () => { expect(2).toBe(2) })\n})\n"
		writeFileSync(join(repo, "tests", "a.ts"), original)
		writeFileSync(join(repo, "tests", "pre-skipped.ts"), "it.skip('already skipped', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		mkdirSync(join(repo, "cases"))
		await git(repo, ["mv", "tests/a.ts", "cases/a.ts"])
		writeFileSync(join(repo, "cases", "a.ts"), original.replace("it('works'", "it.skip('works'"))
		await git(repo, ["mv", "tests/pre-skipped.ts", "cases/pre-skipped.ts"])

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		expect(flags.find((flag) => flag.kind === "test_file_renamed" && flag.path === "cases/a.ts")).toMatchObject({
			detail: "was tests/a.ts",
		})
		// Baseline-source eligibility carries the scan across the rename.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "cases/a.ts")).toBe(true)
		// A pre-existing marker carried across the same kind of rename is not
		// an addition.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "cases/pre-skipped.ts")).toBe(false)
	})

	it("detects markers when color.ui=always is configured", async () => {
		const repo = await makeRepo()
		// `color.ui=always` prefixes diff lines with ANSI escapes, so the
		// added-line scan must force uncolored output — or it recognizes no
		// marker at all while the inventory still looks complete.
		await git(repo, ["config", "color.ui", "always"])
		const original =
			"describe('suite', () => {\n  it('works', () => { expect(1).toBe(1) })\n  it('other', () => { expect(2).toBe(2) })\n})\n"
		writeFileSync(join(repo, "plain.test.ts"), "it('plain', () => {})\n")
		writeFileSync(join(repo, "old.test.ts"), original)
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		writeFileSync(join(repo, "plain.test.ts"), "it('plain', () => {})\nit.skip('plain skipped', () => {})\n")
		await git(repo, ["mv", "old.test.ts", "new.test.ts"])
		writeFileSync(join(repo, "new.test.ts"), original.replace("it('works'", "it.skip('works'"))

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		// Both the ordinary and the renamed-blob comparison stay readable.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "plain.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "new.test.ts")).toBe(true)
		expect(facts?.testInventoryIncomplete).toBe(false)
	})

	it("reaches colon-named test files in the rename and marker scans", async () => {
		const repo = await makeRepo()
		const original =
			"describe('suite', () => {\n  it('works', () => { expect(1).toBe(1) })\n  it('other', () => { expect(2).toBe(2) })\n})\n"
		// Colons are legal in paths on macOS and Linux. In `<commit>:<path>`
		// the first colon separates the revision and the rest is the path, so
		// the rename scan's blob comparison must reach them; the pathspec scan
		// needs literal pathspecs, or a leading colon is read as pathspec magic
		// and silently matches nothing.
		writeFileSync(join(repo, "old:name.test.ts"), original)
		writeFileSync(join(repo, ":plain:name.test.ts"), original)
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		await git(repo, ["mv", "old:name.test.ts", "new:name.test.ts"])
		writeFileSync(join(repo, "new:name.test.ts"), original.replace("it('works'", "it.skip('works'"))
		writeFileSync(join(repo, ":plain:name.test.ts"), original.replace("it('works'", "it.only('works'"))

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		expect(flags.some((flag) => flag.kind === "test_file_renamed" && flag.path === "new:name.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "new:name.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "test_file_modified" && flag.path === ":plain:name.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === ":plain:name.test.ts")).toBe(true)
		expect(facts?.testInventoryIncomplete).toBe(false)
	})

	it("detects markers that repository diff configuration would conceal", async () => {
		const repo = await makeRepo()
		// A `-diff` attribute makes a plain diff report only "Binary files
		// differ", hiding the added markers; the scans must force textual,
		// untransformed comparisons so repository configuration cannot
		// conceal a marker.
		writeFileSync(join(repo, ".gitattributes"), "*.test.ts -diff\n")
		const original =
			"describe('suite', () => {\n  it('works', () => { expect(1).toBe(1) })\n  it('other', () => { expect(2).toBe(2) })\n})\n"
		writeFileSync(join(repo, "plain.test.ts"), "it('plain', () => {})\n")
		writeFileSync(join(repo, "old.test.ts"), original)
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		writeFileSync(join(repo, "plain.test.ts"), "it('plain', () => {})\nit.skip('plain skipped', () => {})\n")
		await git(repo, ["mv", "old.test.ts", "new.test.ts"])
		writeFileSync(join(repo, "new.test.ts"), original.replace("it('works'", "it.skip('works'"))

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const flags = facts?.testInventoryFlags ?? []
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "plain.test.ts")).toBe(true)
		expect(flags.some((flag) => flag.kind === "test_file_renamed" && flag.path === "new.test.ts")).toBe(true)
		// The rename destination's blob comparison stays textual too.
		expect(flags.some((flag) => flag.kind === "skip_marker_added" && flag.path === "new.test.ts")).toBe(true)
		expect(facts?.testInventoryIncomplete).toBe(false)
	})

	it("marks the inventory incomplete when the baseline enumeration or a marker diff fails", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.test.ts"), "it('a', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		writeFileSync(join(repo, "a.test.ts"), "it('a', () => {})\nit.skip('a skipped', () => {})\n")
		const current = await snapshotWorkspace(repo)

		// A failing marker diff (here simulated; in the wild: a diff whose
		// output exceeds the runner's buffer): its flag must not silently
		// vanish while the facts look complete.
		await withFailingGitCommands(["diff", "--text"], async () => {
			const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])
			expect(facts).toBeDefined()
			expect(facts?.testInventoryIncomplete).toBe(true)
			// The rest of the facts still arrive — the evaluator rejects a
			// `met` verdict on the incomplete flag list.
			expect(facts?.changedFiles).toEqual([{ status: "M", path: "a.test.ts" }])
			expect((facts?.testInventoryFlags ?? []).map((flag) => flag.kind)).toEqual(["test_file_modified"])
		})

		// A failed baseline test enumeration: the pre-existing test files
		// cannot be classified, so the inventory is incomplete as well.
		await withFailingGitCommands(["ls-tree"], async () => {
			const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])
			expect(facts?.testInventoryIncomplete).toBe(true)
		})

		// With git healthy again the same tree yields the complete inventory.
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])
		expect(facts?.testInventoryIncomplete).toBe(false)
		expect((facts?.testInventoryFlags ?? []).map((flag) => `${flag.id}:${flag.kind}`)).toEqual([
			"f1:test_file_modified",
			"f2:skip_marker_added",
		])
	})

	it("reports every test-inventory flag however many test files changed", async () => {
		const repo = await makeRepo()
		// One file more than the old marker-scan cap: every changed test file
		// must be scanned, because the host validates `met` against the
		// complete flag list.
		for (let i = 0; i < 51; i++) writeFileSync(join(repo, `t${i}.test.ts`), "it('x', () => {})\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		for (let i = 0; i < 51; i++) writeFileSync(join(repo, `t${i}.test.ts`), "it.skip('x', () => {})\n")

		const current = await snapshotWorkspace(repo)
		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		const markerFlags = (facts?.testInventoryFlags ?? []).filter((flag) => flag.kind === "skip_marker_added")
		expect(markerFlags).toHaveLength(51)
		expect(facts?.truncated).toBe(false)
	})

	it("caps the changed-file list and marks the facts truncated", async () => {
		const repo = await makeRepo()
		for (let i = 0; i < 210; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		for (let i = 0; i < 210; i++) writeFileSync(join(repo, `f${i}.txt`), `${i} changed\n`)
		const current = await snapshotWorkspace(repo)

		const facts = await gatherWorkspaceFacts(repo, baseline?.commit ?? "", current ?? { commit: "", tree: "" }, [])

		expect(facts?.changedFiles.length).toBe(200)
		expect(facts?.truncated).toBe(true)
	})

	it("returns undefined outside a git repository or against a missing baseline", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-nongit-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "file.txt"), "no git\n")
		expect(await gatherWorkspaceFacts(dir, "HEAD", { commit: "x", tree: "y" }, [])).toBeUndefined()
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		expect(await gatherWorkspaceFacts(repo, "0000000", { commit: "x", tree: "y" }, [])).toBeUndefined()
	})
})

describe("listSnapshotPaths", () => {
	it("lists every snapshot file root-relative, untracked ones included, from a subdirectory too", async () => {
		const repo = await makeRepo()
		mkdirSync(join(repo, "src"))
		writeFileSync(join(repo, "src", "a.ts"), "a\n")
		await commitAll(repo, "initial")
		writeFileSync(join(repo, "untracked.test.ts"), "new\n")
		const snapshot = await snapshotWorkspace(repo)
		if (!snapshot) throw new Error("expected a snapshot")

		const listed = await listSnapshotPaths(join(repo, "src"), snapshot)

		expect(listed?.root).toBe(realpathSync(repo))
		expect([...(listed?.paths ?? [])].sort()).toEqual(["src/a.ts", "untracked.test.ts"])
	})

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-nongit-"))
		tempDirs.push(dir)
		expect(await listSnapshotPaths(dir, { commit: "x", tree: "y" })).toBeUndefined()
	})
})

describe("reserveBaselineWorktree", () => {
	it("reserves a path without checking anything out, and disposes an unused reservation", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		const worktree = reserveBaselineWorktree(repo, baseline?.commit ?? "")

		expect(worktree?.path).toContain(BASELINE_WORKTREE_PREFIX)
		expect(existsSync(join(worktree?.path ?? "", "a.txt"))).toBe(false)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(BASELINE_WORKTREE_PREFIX)
		await worktree?.dispose()
		expect(existsSync(worktree?.path ?? "")).toBe(false)
	})

	it("checks the worktree out once, however often ensure is called", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)
		const worktree = reserveBaselineWorktree(repo, baseline?.commit ?? "")

		const [first, second] = await Promise.all([worktree?.ensure(), worktree?.ensure()])

		expect(first).toBe(true)
		expect(second).toBe(true)
		expect(await worktree?.ensure()).toBe(true)
		const list = await git(repo, ["worktree", "list", "--porcelain"])
		expect(list.split(BASELINE_WORKTREE_PREFIX).length - 1).toBe(1)
		await worktree?.dispose()
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(BASELINE_WORKTREE_PREFIX)
	})

	it("checks the baseline out with untracked-at-start files and disposes it", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "tracked.txt"), "tracked\n")
		await commitAll(repo, "initial")
		writeFileSync(join(repo, "untracked-start.txt"), "untracked\n")
		const baseline = await snapshotWorkspace(repo)
		// The implementer moves on: the untracked file disappears from the main
		// tree, the tracked one changes.
		rmSync(join(repo, "untracked-start.txt"))
		writeFileSync(join(repo, "tracked.txt"), "changed\n")

		const worktree = await checkedOutWorktree(repo, baseline?.commit ?? "")

		expect(worktree).toBeDefined()
		expect(existsSync(join(worktree?.path ?? "", "untracked-start.txt"))).toBe(true)
		expect(readFileSync(join(worktree?.path ?? "", "tracked.txt"), "utf-8")).toBe("tracked\n")
		expect(await git(repo, ["worktree", "list", "--porcelain"])).toContain(worktree?.path ?? "")
		await worktree?.dispose()
		expect(existsSync(worktree?.path ?? "")).toBe(false)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree?.path ?? "")
		// The main tree is untouched by the worktree's life and death.
		expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("changed\n")
	})

	it("shares nested package node_modules with the worktree, up to three levels deep", async () => {
		const repo = await makeRepo()
		mkdirSync(join(repo, "backend"))
		mkdirSync(join(repo, "packages", "core"), { recursive: true })
		mkdirSync(join(repo, "a", "b", "c", "d"), { recursive: true })
		for (const dir of ["backend", "packages/core", "a/b/c/d"]) writeFileSync(join(repo, dir, "index.ts"), "x\n")
		writeFileSync(join(repo, ".gitignore"), "node_modules\n")
		await commitAll(repo, "initial")
		for (const dir of ["backend", "packages/core", "a/b/c/d"]) {
			mkdirSync(join(repo, dir, "node_modules"))
			writeFileSync(join(repo, dir, "node_modules", "marker.txt"), `${dir}\n`)
		}
		const baseline = await snapshotWorkspace(repo)

		const worktree = await checkedOutWorktree(repo, baseline?.commit ?? "")

		const wt = worktree?.path ?? ""
		expect(readFileSync(join(wt, "backend", "node_modules", "marker.txt"), "utf-8")).toBe("backend\n")
		expect(readFileSync(join(wt, "packages", "core", "node_modules", "marker.txt"), "utf-8")).toBe("packages/core\n")
		// Deeper than three levels below the root is not linked.
		expect(existsSync(join(wt, "a", "b", "c", "d", "node_modules"))).toBe(false)
		await worktree?.dispose()
		expect(existsSync(join(repo, "backend", "node_modules", "marker.txt"))).toBe(true)
	})

	it("shares the repository root's node_modules with the worktree", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		mkdirSync(join(repo, "node_modules"))
		writeFileSync(join(repo, "node_modules", "marker.txt"), "dep\n")
		const baseline = await snapshotWorkspace(repo)

		const worktree = await checkedOutWorktree(repo, baseline?.commit ?? "")

		const modules = join(worktree?.path ?? "", "node_modules")
		expect(existsSync(modules)).toBe(true)
		expect(readFileSync(join(modules, "marker.txt"), "utf-8")).toBe("dep\n")
		await worktree?.dispose()
		// The real node_modules survives the worktree's disposal.
		expect(existsSync(join(repo, "node_modules", "marker.txt"))).toBe(true)
	})

	it("fails the checkout outside a git repository or for a missing baseline, and disposal still cleans up", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-nongit-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "file.txt"), "no git\n")
		const outside = reserveBaselineWorktree(dir, "HEAD")
		expect(await outside?.ensure()).toBe(false)
		await outside?.dispose()
		expect(existsSync(outside?.path ?? "")).toBe(false)
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const missing = reserveBaselineWorktree(repo, "0000000")
		expect(await missing?.ensure()).toBe(false)
		expect(await missing?.ensure()).toBe(false)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(BASELINE_WORKTREE_PREFIX)
		await missing?.dispose()
		expect(existsSync(missing?.path ?? "")).toBe(false)
	})
})

describe("pruneStaleBaselineWorktrees", () => {
	it("removes stale baseline worktrees but leaves unrelated ones alone", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		// A crashed run's leftover: one of ours, one unrelated, both registered.
		const staleDir = mkdtempSync(join(tmpdir(), BASELINE_WORKTREE_PREFIX))
		tempDirs.push(staleDir)
		await git(repo, ["worktree", "add", "--detach", staleDir, "HEAD"])
		const keepDir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-unrelated-"))
		tempDirs.push(keepDir)
		await git(repo, ["worktree", "add", "--detach", keepDir, "HEAD"])

		await pruneStaleBaselineWorktrees(repo)

		expect(existsSync(staleDir)).toBe(false)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(staleDir)
		expect(existsSync(keepDir)).toBe(true)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).toContain(keepDir)
	})

	it("is a no-op outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-v2-workspace-nongit-"))
		tempDirs.push(dir)
		writeFileSync(join(dir, "file.txt"), "no git\n")
		await expect(pruneStaleBaselineWorktrees(dir)).resolves.toBeUndefined()
	})

	it("keeps worktrees of live owners and removes only abandoned ones", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		// This process's live worktree: a verifier run is still using it.
		const live = await checkedOutWorktree(repo, baseline?.commit ?? "")
		// Another live process's worktree (a second session in the same repo).
		const foreign = spawn("sleep", ["30"], { stdio: "ignore" })
		if (!foreign.pid) throw new Error("expected a child pid")
		const foreignLive = mkdtempSync(join(tmpdir(), `${BASELINE_WORKTREE_PREFIX}${foreign.pid}-`))
		tempDirs.push(foreignLive)
		await git(repo, ["worktree", "add", "--detach", foreignLive, "HEAD"])
		// A crashed run's leftover: its owning process is gone.
		const crashedOwner = spawn("sleep", ["30"], { stdio: "ignore" })
		if (!crashedOwner.pid) throw new Error("expected a child pid")
		const crashed = mkdtempSync(join(tmpdir(), `${BASELINE_WORKTREE_PREFIX}${crashedOwner.pid}-`))
		tempDirs.push(crashed)
		await git(repo, ["worktree", "add", "--detach", crashed, "HEAD"])
		crashedOwner.kill()
		await new Promise<void>((resolve) => crashedOwner.once("exit", resolve))

		await pruneStaleBaselineWorktrees(repo)

		expect(existsSync(live?.path ?? "")).toBe(true)
		expect(existsSync(foreignLive)).toBe(true)
		expect(existsSync(crashed)).toBe(false)
		expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(crashed)

		await live?.dispose()
		foreign.kill()
	})

	it("keeps a worktree whose creation is still in flight", async () => {
		const repo = await makeRepo()
		writeFileSync(join(repo, "a.txt"), "a\n")
		await commitAll(repo, "initial")
		const baseline = await snapshotWorkspace(repo)

		// The shim runs the real `worktree add` and then holds its exit open,
		// so the creation's await — and, pre-fix, its live-set registration —
		// has not resolved while the prune below runs: the exact race of a
		// session starting (and pruning) in this same process while another
		// session's verifier worktree is being created.
		await withGitShim(
			`if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
	"$REAL" "$@"
	status=$?
	sleep 2
	exit $status
fi`,
			async () => {
				const reserved = reserveBaselineWorktree(repo, baseline?.commit ?? "")
				const creation = reserved?.ensure()
				// Wait until git has registered the in-flight worktree, so the
				// prune observably sees it rather than racing past it.
				let registered = false
				for (let attempt = 0; attempt < 500; attempt++) {
					const list = await git(repo, ["worktree", "list", "--porcelain"])
					if (list.includes(BASELINE_WORKTREE_PREFIX)) {
						registered = true
						break
					}
					await new Promise<void>((resolve) => setTimeout(resolve, 10))
				}
				expect(registered).toBe(true)

				await pruneStaleBaselineWorktrees(repo)

				expect(await creation).toBe(true)
				expect(existsSync(join(reserved?.path ?? "", "a.txt"))).toBe(true)
				expect(await git(repo, ["worktree", "list", "--porcelain"])).toContain(reserved?.path ?? "")
				await reserved?.dispose()
			},
		)
	})
})
