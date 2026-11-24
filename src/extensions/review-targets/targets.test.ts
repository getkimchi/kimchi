import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { submitFinding } from "../review-submit/store.js"
import { parseReviewTargetArgs } from "./parser.js"
import { cleanupStaleReviewSnapshots, getReviewTargetChoices, resolveReviewTarget } from "./resolve.js"
import { REVIEW_SNAPSHOT_REF_PREFIX } from "./snapshot.js"
import type { ExplicitReviewRequest, ProviderAnchorMap, ResolveReviewTargetOptions } from "./types.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function gitBuffer(cwd: string, ...args: string[]): Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "buffer",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	})
}

function write(root: string, path: string, contents: string | Buffer): void {
	const destination = join(root, path)
	mkdirSync(dirname(destination), { recursive: true })
	writeFileSync(destination, contents)
}

function fileDigests(root: string): Record<string, string> {
	const result: Record<string, string> = {}
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue
			const path = join(directory, entry.name)
			const key = relative(root, path)
			const metadata = lstatSync(path)
			if (metadata.isSymbolicLink()) result[key] = `link:${readlinkSync(path)}`
			else if (metadata.isDirectory()) visit(path)
			else result[key] = `${metadata.mode & 0o777}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`
		}
	}
	visit(root)
	return result
}

function checkoutState(root: string) {
	const indexPath = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")
	return {
		branch: git(root, "symbolic-ref", "--short", "HEAD"),
		head: git(root, "rev-parse", "HEAD"),
		index: readFileSync(indexPath),
		status: gitBuffer(root, "status", "--porcelain=v2", "-z", "--untracked-files=all").toString("base64"),
		stash: gitBuffer(root, "stash", "list", "--format=%H").toString("utf8"),
		files: fileDigests(root),
	}
}

function expectCheckoutState(root: string, before: ReturnType<typeof checkoutState>): void {
	const after = checkoutState(root)
	expect(after.branch).toBe(before.branch)
	expect(after.head).toBe(before.head)
	expect(after.index.equals(before.index)).toBe(true)
	expect(after.status).toBe(before.status)
	expect(after.stash).toBe(before.stash)
	expect(after.files).toEqual(before.files)
}

function snapshotRefs(root: string): string[] {
	const output = git(root, "for-each-ref", "--format=%(refname)", REVIEW_SNAPSHOT_REF_PREFIX)
	return output ? output.split("\n") : []
}

function fixtureFiles(): Record<string, string | Buffer> {
	return {
		".gitignore": "ignored.txt\n",
		"both.txt": "base\nsecond\n",
		"staged.txt": "base\n",
		"deleted.txt": "delete me\n",
		"old-name.txt": "rename base\nshared two\nshared three\n",
		"binary.bin": Buffer.from([0, 1, 2, 3]),
		"mode.sh": "#!/bin/sh\nexit 0\n",
		"stash.txt": "stash base\n",
	}
}

describe("review target resolution", () => {
	let sandbox: string
	let repo: string

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "kimchi-review-targets-"))
		repo = join(sandbox, "repo")
		mkdirSync(repo)
		const home = join(sandbox, "home")
		const xdg = join(sandbox, "xdg")
		const globalConfig = join(sandbox, "global.gitconfig")
		mkdirSync(home, { recursive: true })
		mkdirSync(xdg, { recursive: true })
		writeFileSync(globalConfig, "")
		for (const [name, value] of Object.entries({
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: globalConfig,
			HOME: home,
			XDG_CONFIG_HOME: xdg,
		}))
			vi.stubEnv(name, value)
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Test User")
		git(repo, "config", "user.email", "test@example.com")
		git(repo, "config", "commit.gpgsign", "false")
		git(repo, "config", "tag.gpgsign", "false")
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(sandbox, { recursive: true, force: true })
	})

	function initialize(files: Record<string, string | Buffer> = { "file.txt": "one\ntwo\nthree\n" }): string {
		for (const [path, contents] of Object.entries(files)) write(repo, path, contents)
		git(repo, "add", "--all")
		git(repo, "commit", "-m", "initial")
		return git(repo, "rev-parse", "HEAD")
	}

	function options(context = "context"): ResolveReviewTargetOptions {
		return { root: repo, contextDir: join(sandbox, context) }
	}

	async function resolve(request: ExplicitReviewRequest, overrides: Partial<ResolveReviewTargetOptions> = {}) {
		return resolveReviewTarget(request, { ...options(), ...overrides })
	}

	function configureGlobalLfs(name: string): string {
		const marker = join(sandbox, `${name}.log`)
		const driver = join(sandbox, `${name}.sh`)
		writeFileSync(driver, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`)
		chmodSync(driver, 0o755)
		writeFileSync(
			join(sandbox, "global.gitconfig"),
			`[filter "lfs"]\n\tclean = ${driver}\n\tsmudge = ${driver}\n\tprocess = ${driver}\n`,
		)
		return marker
	}

	it("freezes final working contents, anchors every supported edit type, and preserves the checkout", async () => {
		const tip = initialize(fixtureFiles())
		write(repo, "stash.txt", "stashed version\n")
		git(repo, "add", "stash.txt")
		git(repo, "stash", "push", "-m", "retain this stash")

		write(repo, "staged.txt", "staged final\n")
		git(repo, "add", "staged.txt")
		write(repo, "both.txt", "staged version\n")
		git(repo, "add", "both.txt")
		write(repo, "both.txt", "working tree wins\n")
		rmSync(join(repo, "deleted.txt"))
		git(repo, "mv", "old-name.txt", "new-name.txt")
		write(repo, "new-name.txt", "rename base\nshared two\nshared three\nrenamed working\n")
		write(repo, "binary.bin", Buffer.from([0, 9, 8, 7]))
		chmodSync(join(repo, "mode.sh"), 0o755)
		write(repo, "untracked.txt", "first\nsecond\n")
		write(repo, "ignored.txt", "not part of the review\n")
		const before = checkoutState(repo)

		const target = await resolveReviewTarget(
			parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest,
			options(),
		)
		const { scope } = target
		expect(scope.pinned.baseSha).toBe(tip)
		expect(scope.pinned.tipSha).toBe(tip)
		expect(scope.pinned.headSha).not.toBe(tip)
		expect(scope.headKind).toBe("working-tree-snapshot")
		expect(scope.dirty).toBe(true)
		expect(scope.pinned.snapshotRef).toMatch(/^refs\/kimchi\/review\/snapshots\//)
		if (scope.pinned.snapshotRef === undefined) throw new Error("expected a private snapshot ref")
		expect(git(repo, "rev-parse", scope.pinned.snapshotRef)).toBe(scope.pinned.headSha)
		expect(git(repo, "rev-parse", `${scope.pinned.headSha}^`)).toBe(tip)
		expect(git(repo, "show", `${scope.pinned.headSha}:staged.txt`)).toBe("staged final")
		expect(git(repo, "show", `${scope.pinned.headSha}:both.txt`)).toBe("working tree wins")
		expect(git(repo, "show", `${scope.pinned.headSha}:new-name.txt`)).toBe(
			"rename base\nshared two\nshared three\nrenamed working",
		)
		expect(git(repo, "show", `${scope.pinned.headSha}:untracked.txt`)).toBe("first\nsecond")
		expect(gitBuffer(repo, "show", `${scope.pinned.headSha}:binary.bin`)).toEqual(Buffer.from([0, 9, 8, 7]))
		expect(git(repo, "ls-tree", scope.pinned.headSha, "--", "mode.sh")).toMatch(/^100755 /)
		expect(() => git(repo, "cat-file", "-e", `${scope.pinned.headSha}:deleted.txt`)).toThrow()
		expect(() => git(repo, "cat-file", "-e", `${scope.pinned.headSha}:ignored.txt`)).toThrow()

		const map = JSON.parse(readFileSync(scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		expect(map).toMatchObject({
			schema_version: "commentable-lines/v1",
			commit_sha: scope.pinned.headSha,
			merge_base_sha: tip,
			files_cap_reached: false,
			files: {
				"both.txt": { ranges: [{ start_line: 1, end_line: 1 }] },
				"staged.txt": { ranges: [{ start_line: 1, end_line: 1 }] },
				"new-name.txt": { ranges: [{ start_line: 4, end_line: 4 }] },
				"untracked.txt": { ranges: [{ start_line: 1, end_line: 2 }] },
				"deleted.txt": { reason: "no_patch" },
				"binary.bin": { reason: "no_patch" },
				"mode.sh": { reason: "no_patch" },
			},
		})
		expect(map.files["ignored.txt"]).toBeUndefined()
		expect(map.files["old-name.txt"]).toBeUndefined()
		expect(scope.files).toEqual({ changed: 7, anchorable: 4, unanchorable: 3 })
		expect(scope.anchorSource).toBe("local")
		expect(scope.limitations.map((item) => item.code)).toContain("provider_anchor_map_not_applicable")
		expectCheckoutState(repo, before)

		const outputDir = join(sandbox, "review-output")
		const storeContext = { contextDir: scope.contextDir, outputDir, writer: "spec" }
		const accepted = await submitFinding(
			{
				path: "both.txt",
				line: 1,
				severity: "warning",
				type: "correctness",
				description: "The final working-tree content is reviewed.",
				suggestion: "",
			},
			storeContext,
		)
		expect(accepted).toMatchObject({ accepted: true, id: "spec-1", seq: 1 })
		const rejected = await submitFinding(
			{
				path: "both.txt",
				line: 99,
				severity: "warning",
				type: "correctness",
				description: "This line is outside the local hunk.",
				suggestion: "",
			},
			storeContext,
		)
		expect(rejected).toMatchObject({ accepted: false, reason: "line_outside_hunks" })

		expectCheckoutState(repo, before)
		await target.cleanup()
		await target.cleanup()
		expect(snapshotRefs(repo)).toEqual([])
		expect(() => git(repo, "cat-file", "-e", scope.pinned.headSha)).not.toThrow()
		expectCheckoutState(repo, before)
		expect(existsSync(join(outputDir, "findings", "spec.jsonl"))).toBe(true)
	}, 20_000)

	it("returns ordered bare choices, defaults to branch when clean, and working tree only for non-ignored edits", async () => {
		initialize({ ".gitignore": "ignored.txt\n", "file.txt": "base\n" })
		let choices = await getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
		expect(choices.choices.map((choice) => [choice.kind, choice.preselected])).toEqual([
			["working-tree", false],
			["branch", true],
		])
		expect(choices.choices[1]).toMatchObject({ requiresExplicitBase: true })
		expect(choices.syntax).toContain("/review branch <ref> --base <ref> --include-working-tree [--fetch]")

		write(repo, "ignored.txt", "ignored\n")
		choices = await getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
		expect(choices.choices[1].preselected).toBe(true)
		write(repo, "file.txt", "edited\n")
		choices = await getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
		expect(choices.choices[0].preselected).toBe(true)
		expect(choices.choices[1].preselected).toBe(false)
	})

	it("pins a remote tracking comparison at the merge base and suggests remote HEAD or a known target", async () => {
		const base = initialize()
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "one\ntwo\nthree\nfeature\n")
		git(repo, "commit", "-am", "feature")
		const feature = git(repo, "rev-parse", "HEAD")
		git(repo, "checkout", "main")
		write(repo, "main.txt", "main\n")
		git(repo, "add", "main.txt")
		git(repo, "commit", "-m", "main continues")
		const main = git(repo, "rev-parse", "HEAD")
		git(repo, "remote", "add", "origin", repo)
		git(repo, "update-ref", "refs/remotes/origin/main", main)
		git(repo, "update-ref", "refs/remotes/origin/feature", feature)
		git(repo, "update-ref", "refs/remotes/origin/release", base)
		git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

		const explicit = await resolve(
			parseReviewTargetArgs(["branch", "origin/feature", "--base", "origin/main"]) as ExplicitReviewRequest,
		)
		expect(explicit.scope).toMatchObject({
			kind: "branch",
			refs: { branch: "origin/feature", base: "origin/main", resolvedBase: "refs/remotes/origin/main" },
			baseSource: "explicit",
			pinned: { baseSha: base, headSha: feature, tipSha: feature },
			headKind: "commit",
			dirty: false,
		})
		expect(explicit.scope.pinned.baseSha).not.toBe(main)
		await explicit.cleanup()

		const suggested = await resolve(parseReviewTargetArgs(["branch", "origin/feature"]) as ExplicitReviewRequest)
		expect(suggested.scope).toMatchObject({
			baseSource: "remote-default",
			refs: { base: undefined, resolvedBase: "refs/remotes/origin/HEAD" },
			pinned: { baseSha: base },
		})
		await suggested.cleanup()

		const provider = await resolve(parseReviewTargetArgs(["branch", "origin/feature"]) as ExplicitReviewRequest, {
			pullRequestTargetBranch: "release",
		})
		expect(provider.scope).toMatchObject({
			baseSource: "pull-request-target",
			refs: { resolvedBase: "refs/remotes/origin/release" },
			pinned: { baseSha: base },
		})
		await provider.cleanup()

		const choices = await getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
		expect(choices.choices[1].baseSuggestion).toMatchObject({
			ref: "refs/remotes/origin/HEAD",
			resolvedRef: "refs/remotes/origin/main",
		})
		expect(choices.choices[1].requiresExplicitBase).toBe(false)
	})

	it("requires an explicit base when no local provider metadata or unique remote HEAD exists", async () => {
		initialize()
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "feature\n")
		git(repo, "commit", "-am", "feature")
		await expect(resolve(parseReviewTargetArgs(["branch", "feature"]) as ExplicitReviewRequest)).rejects.toMatchObject({
			code: "base_required",
		})
		const target = await resolve(
			parseReviewTargetArgs(["branch", "feature", "--base", "main"]) as ExplicitReviewRequest,
		)
		expect(target.scope.baseSource).toBe("explicit")
	})

	it("includes the working tree only when the selected tip equals checkout HEAD", async () => {
		const base = initialize()
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "one\ntwo\nthree\nfeature\n")
		git(repo, "commit", "-am", "feature")
		const feature = git(repo, "rev-parse", "HEAD")
		write(repo, "file.txt", "one\ntwo\nthree\nfeature\nworking\n")
		const before = checkoutState(repo)
		const target = await resolve(
			parseReviewTargetArgs(["branch", "feature", "--base", "main", "--include-working-tree"]) as ExplicitReviewRequest,
		)
		expect(target.scope).toMatchObject({
			includeWorkingTree: true,
			pinned: { baseSha: base, tipSha: feature },
			headKind: "working-tree-snapshot",
		})
		expect(target.scope.pinned.headSha).not.toBe(feature)
		expect(git(repo, "rev-parse", `${target.scope.pinned.headSha}^`)).toBe(feature)
		expect(git(repo, "show", `${target.scope.pinned.headSha}:file.txt`)).toContain("working")
		expectCheckoutState(repo, before)
		await target.cleanup()

		git(repo, "reset", "--hard", feature)
		git(repo, "checkout", "main")
		await expect(
			resolve(
				parseReviewTargetArgs([
					"branch",
					"feature",
					"--base",
					"main",
					"--include-working-tree",
				]) as ExplicitReviewRequest,
			),
		).rejects.toMatchObject({ code: "head_mismatch" })
		expect(snapshotRefs(repo)).toEqual([])
	})

	it("accepts exact provider anchors only for a clean pinned comparison and never transfers them to a snapshot", async () => {
		const base = initialize()
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "one\nchanged\nthree\n")
		git(repo, "commit", "-am", "feature")
		const feature = git(repo, "rev-parse", "HEAD")
		const provider: ProviderAnchorMap = {
			schema_version: "commentable-lines/v1",
			commit_sha: feature,
			merge_base_sha: base,
			files: { "file.txt": { ranges: [{ start_line: 100, end_line: 100 }] } },
		}
		const clean = await resolve(
			parseReviewTargetArgs(["branch", "feature", "--base", "main"]) as ExplicitReviewRequest,
			{ providerAnchorMap: provider },
		)
		expect(clean.scope.anchorSource).toBe("provider")
		expect(JSON.parse(readFileSync(clean.scope.commentableLinesPath, "utf8"))).toEqual(provider)

		write(repo, "file.txt", "one\nworking snapshot\nthree\n")
		const dirty = await resolveReviewTarget(
			parseReviewTargetArgs(["branch", "feature", "--base", "main", "--include-working-tree"]) as ExplicitReviewRequest,
			{ ...options("dirty-context"), providerAnchorMap: provider },
		)
		expect(dirty.scope.anchorSource).toBe("local")
		expect(dirty.scope.pinned.headSha).not.toBe(provider.commit_sha)
		expect(dirty.scope.limitations.map((item) => item.code)).toContain("provider_anchor_map_not_applicable")
		const dirtyMap = JSON.parse(readFileSync(dirty.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		expect(dirtyMap.files["file.txt"].ranges).toEqual([{ start_line: 2, end_line: 2 }])
		const store = { contextDir: dirty.scope.contextDir, outputDir: join(sandbox, "dirty-output"), writer: "spec" }
		const localLine = await submitFinding(
			{
				path: "file.txt",
				line: 2,
				severity: "warning",
				type: "correctness",
				description: "The snapshot line is valid locally.",
				suggestion: "",
			},
			store,
		)
		expect(localLine.accepted).toBe(true)
		const providerOnlyLine = await submitFinding(
			{
				path: "file.txt",
				line: 100,
				severity: "warning",
				type: "correctness",
				description: "The provider-only line must not transfer to the snapshot.",
				suggestion: "",
			},
			store,
		)
		expect(providerOnlyLine).toMatchObject({ accepted: false, reason: "line_outside_hunks" })
		await dirty.cleanup()
	})

	it("rejects unmerged paths without touching the conflicted index or source files", async () => {
		initialize()
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "feature\n")
		git(repo, "commit", "-am", "feature change")
		git(repo, "checkout", "main")
		write(repo, "file.txt", "main\n")
		git(repo, "commit", "-am", "main change")
		expect(() => git(repo, "merge", "feature")).toThrow()
		const before = checkoutState(repo)
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({ code: "unmerged_paths" })
		expect(snapshotRefs(repo)).toEqual([])
		expectCheckoutState(repo, before)
	})

	it("fetches only when requested, using a local transport in this test", async () => {
		initialize()
		const clone = join(sandbox, "clone")
		git(sandbox, "clone", "--no-hardlinks", repo, clone)
		git(repo, "checkout", "-b", "feature")
		write(repo, "file.txt", "fetched\n")
		git(repo, "commit", "-am", "feature")
		const feature = git(repo, "rev-parse", "HEAD")
		const request = parseReviewTargetArgs([
			"branch",
			"origin/feature",
			"--base",
			"origin/main",
		]) as ExplicitReviewRequest
		await expect(
			resolveReviewTarget(request, { root: clone, contextDir: join(sandbox, "before-fetch") }),
		).rejects.toMatchObject({ code: "unknown_revision" })
		expect(() => git(clone, "rev-parse", "--verify", "refs/remotes/origin/feature")).toThrow()

		const fetched = await resolveReviewTarget(
			{ ...request, fetch: true },
			{ root: clone, contextDir: join(sandbox, "after-fetch") },
		)
		expect(fetched.scope.pinned.headSha).toBe(feature)
		expect(git(clone, "rev-parse", "refs/remotes/origin/feature")).toBe(feature)
		await fetched.cleanup()
	})

	it("reports a concurrent file change and leaves the real index unchanged", async () => {
		initialize()
		write(repo, "file.txt", "before capture\n")
		const indexPath = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index")
		const index = readFileSync(indexPath)
		await expect(
			resolve(
				{ kind: "working-tree", fetch: false },
				{
					beforeSnapshotCommit: () => {
						write(repo, "file.txt", "changed during capture\n")
					},
				},
			),
		).rejects.toMatchObject({ code: "snapshot_changed" })
		expect(readFileSync(indexPath).equals(index)).toBe(true)
		expect(snapshotRefs(repo)).toEqual([])
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("changed during capture\n")
	})

	it("rejects content filters on changed paths instead of reviewing transformed content", async () => {
		initialize({ ".gitattributes": "*.dat filter=lfs\n", "data.dat": "original\n" })
		git(repo, "config", "filter.lfs.clean", "cat")
		write(repo, "data.dat", "changed\n")
		const before = checkoutState(repo)
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_content_filter",
		})
		expectCheckoutState(repo, before)
	})

	it.each([
		"working-tree",
		"branch",
	] as const)("allows globally configured LFS commands without repository filter attributes during %s resolution", async (targetKind) => {
		initialize()
		if (targetKind === "branch") {
			git(repo, "checkout", "-b", "feature")
			write(repo, "file.txt", "changed\n")
			git(repo, "commit", "-am", "feature")
		} else {
			write(repo, "file.txt", "changed\n")
		}
		const marker = configureGlobalLfs(`global-only-${targetKind}`)
		const target =
			targetKind === "working-tree"
				? await resolve({ kind: "working-tree", fetch: false })
				: await resolve({
						kind: "branch",
						branch: "feature",
						base: "main",
						includeWorkingTree: false,
						fetch: false,
					})
		expect(target.scope.files.changed).toBe(1)
		const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		expect(map.files["file.txt"].ranges).toEqual([{ start_line: 1, end_line: 1 }])
		expect(existsSync(marker)).toBe(false)
		await target.cleanup()
		expect(existsSync(marker)).toBe(false)
	})

	it("rejects an in-scope path whose global LFS driver applies", async () => {
		initialize({ ".gitattributes": "*.bin filter=lfs\n", "data.bin": "base\n" })
		write(repo, "data.bin", "evil\n")
		const marker = configureGlobalLfs("in-scope-filter")
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_content_filter",
			message: expect.stringContaining("data.bin (filter=lfs)"),
		})
		expect(existsSync(marker)).toBe(false)
	})

	it("allows a configured filter attribute only on a path outside the comparison", async () => {
		initialize({
			".gitattributes": "outside.bin filter=lfs\n",
			"file.txt": "base\n",
			"outside.bin": "unchanged\n",
		})
		write(repo, "file.txt", "changed\n")
		const marker = configureGlobalLfs("outside-filter")
		const target = await resolve({ kind: "working-tree", fetch: false })
		expect(target.scope.files).toEqual({ changed: 1, anchorable: 1, unanchorable: 0 })
		const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		expect(map.files["file.txt"].ranges).toEqual([{ start_line: 1, end_line: 1 }])
		expect(map.files["outside.bin"]).toBeUndefined()
		expect(existsSync(marker)).toBe(false)
		await target.cleanup()
	})

	it("allows filter attributes in a committed-only branch comparison without working-tree conversion", async () => {
		const base = initialize({ ".gitattributes": "*.bin filter=lfs\n", "data.bin": "base\n" })
		git(repo, "checkout", "-b", "feature")
		write(repo, "data.bin", "changed\n")
		git(repo, "commit", "-am", "feature")
		const marker = configureGlobalLfs("branch-filter")
		const target = await resolve({
			kind: "branch",
			branch: "feature",
			base: "main",
			includeWorkingTree: false,
			fetch: false,
		})
		expect(target.scope).toMatchObject({
			pinned: { baseSha: base },
			files: { changed: 1, anchorable: 1 },
		})
		expect(existsSync(marker)).toBe(false)
	})

	it("rejects working-tree-encoding on an in-scope path", async () => {
		initialize({ "file.txt": "base\n" })
		write(repo, ".gitattributes", "file.txt working-tree-encoding=UTF-16LE\n")
		write(repo, "file.txt", "evil\n")
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_content_filter",
			message: expect.stringContaining("file.txt (working-tree-encoding=UTF-16LE)"),
		})
	})

	it("rejects sparse checkouts explicitly", async () => {
		initialize()
		write(repo, "file.txt", "changed\n")
		git(repo, "config", "core.sparseCheckout", "true")
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_sparse_checkout",
		})
	})

	it("rejects changed submodule revisions without touching either checkout", async () => {
		initialize()
		const nested = join(repo, "nested")
		mkdirSync(nested)
		git(nested, "init", "--initial-branch=trunk")
		git(nested, "config", "user.name", "Test User")
		git(nested, "config", "user.email", "[EMAIL_ADDRESS_3]")
		write(nested, "file.txt", "one\n")
		git(nested, "add", "file.txt")
		git(nested, "commit", "-m", "nested initial")
		git(repo, "add", "nested")
		git(repo, "commit", "-m", "add nested checkout")
		write(nested, "file.txt", "two\n")
		git(nested, "commit", "-am", "nested change")
		const before = checkoutState(repo)
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_submodule",
		})
		expectCheckoutState(repo, before)
	})

	it.runIf(process.platform !== "win32")(
		"preserves quoted, non-ASCII, and newline paths in local anchors",
		async () => {
			initialize()
			const unusual = ['dir/a "quote"\\name.txt', "dir/café.txt", "dir/line\nbreak.txt"]
			for (const path of unusual) write(repo, path, "new line\n")
			const target = await resolve({ kind: "working-tree", fetch: false })
			const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
			for (const path of unusual) {
				expect(map.files[path]).toEqual({ ranges: [{ start_line: 1, end_line: 1 }] })
				expect(git(repo, "show", `${target.scope.pinned.headSha}:${path}`)).toBe("new line")
			}
			await target.cleanup()
		},
	)

	it.runIf(process.platform !== "win32")(
		"captures pathspec metacharacters literally without changing committed decoys",
		async () => {
			const decoys = {
				"a1.ts": "committed a1\n",
				"decoy.txt": "committed text\n",
				"q.md": "committed markdown\n",
				x: "committed magic-name decoy\n",
			}
			initialize(decoys)
			const changed = new Map([
				["a[1].ts", "literal brackets\n"],
				["*.txt", "literal star\n"],
				["?.md", "literal question mark\n"],
				[":(glob)x", "literal pathspec magic\n"],
			])
			for (const [path, contents] of changed) write(repo, path, contents)
			const target = await resolve({ kind: "working-tree", fetch: false })
			expect(target.scope.files).toEqual({ changed: changed.size, anchorable: changed.size, unanchorable: 0 })
			const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
			expect(new Set(Object.keys(map.files))).toEqual(new Set(changed.keys()))
			for (const [path, contents] of changed) {
				expect(map.files[path]).toEqual({ ranges: [{ start_line: 1, end_line: 1 }] })
				expect(git(repo, "show", `${target.scope.pinned.headSha}:${path}`)).toBe(contents.trim())
			}
			for (const [path, contents] of Object.entries(decoys)) {
				expect(git(repo, "show", `${target.scope.pinned.headSha}:${path}`)).toBe(contents.trim())
				expect(map.files[path]).toBeUndefined()
			}
			await target.cleanup()
		},
	)

	it("uses stdin pathspec files instead of an argv-sized changed-path list", async () => {
		initialize()
		const paths = Array.from(
			{ length: 5000 },
			(_, index) => `many/${"f".repeat(80)}-${String(index).padStart(4, "0")}.txt`,
		)
		expect(paths.reduce((size, path) => size + Buffer.byteLength(path) + 1, 0)).toBeGreaterThan(256 * 1024)
		for (const path of paths) write(repo, path, "payload\n")
		const target = await resolve({ kind: "working-tree", fetch: false })
		expect(target.scope.files).toEqual({ changed: 5000, anchorable: 5000, unanchorable: 0 })
		const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		for (const path of [paths[0], paths[2499], paths[4999]]) {
			expect(map.files[path]).toEqual({ ranges: [{ start_line: 1, end_line: 1 }] })
			expect(git(repo, "show", `${target.scope.pinned.headSha}:${path}`)).toBe("payload")
		}
		await target.cleanup()
	}, 60_000)

	it.runIf(process.platform !== "win32").each(["default", "configured"] as const)(
		"never executes %s repository hooks during success, failure, or cleanup",
		async (hookLocation) => {
			initialize()
			write(repo, "file.txt", "dirty\n")
			const marker = join(sandbox, `hooks-${hookLocation}.log`)
			const hooks = hookLocation === "default" ? join(repo, ".git", "hooks") : join(sandbox, "configured-hooks")
			mkdirSync(hooks, { recursive: true })
			if (hookLocation === "configured") git(repo, "config", "core.hooksPath", hooks)
			for (const name of ["post-index-change", "reference-transaction", "post-commit", "post-merge"]) {
				const script = [
					"#!/bin/sh",
					`printf '%s\\n' '${name}' >> ${JSON.stringify(marker)}`,
					`: > ${JSON.stringify(join(repo, "hook-created.txt"))}`,
					"git config --local review.hookRan yes",
				].join("\n")
				writeFileSync(join(hooks, name), `${script}\n`)
				chmodSync(join(hooks, name), 0o755)
			}
			const before = checkoutState(repo)
			const target = await resolve({ kind: "working-tree", fetch: false })
			await target.cleanup()
			expect(existsSync(marker)).toBe(false)
			expect(existsSync(join(repo, "hook-created.txt"))).toBe(false)
			expectCheckoutState(repo, before)

			const unsafeContext = join(sandbox, `unsafe-context-${hookLocation}`)
			symlinkSync(join(sandbox, "context-target"), unsafeContext, "dir")
			await expect(
				resolve({ kind: "working-tree", fetch: false }, { contextDir: unsafeContext }),
			).rejects.toMatchObject({ code: "unsafe_context_dir" })
			expect(snapshotRefs(repo)).toEqual([])
			expect(existsSync(marker)).toBe(false)
			expect(existsSync(join(repo, "hook-created.txt"))).toBe(false)
			expect(() => git(repo, "config", "--local", "--get", "review.hookRan")).toThrow()
			expectCheckoutState(repo, before)
		},
		20_000,
	)

	it.each([
		"choices",
		"resolution",
	] as const)("rejects executable conversion filters before %s can invoke them", async (operation) => {
		initialize({ ".gitattributes": "*.txt filter=probe\n", "file.txt": "base\n" })
		const marker = join(sandbox, `filter-${operation}.log`)
		const filter = join(sandbox, `filter-${operation}.sh`)
		writeFileSync(filter, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`)
		chmodSync(filter, 0o755)
		git(repo, "config", "filter.probe.clean", filter)
		git(repo, "config", "filter.probe.smudge", filter)
		write(repo, "file.txt", "evil\n")
		const indexPath = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index")
		const index = readFileSync(indexPath)
		const head = git(repo, "rev-parse", "HEAD")
		const files = fileDigests(repo)
		const pending =
			operation === "choices"
				? getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
				: resolve({ kind: "working-tree", fetch: false })
		await expect(pending).rejects.toMatchObject({ code: "unsupported_content_filter" })
		expect(existsSync(marker)).toBe(false)
		expect(readFileSync(indexPath).equals(index)).toBe(true)
		expect(git(repo, "rev-parse", "HEAD")).toBe(head)
		expect(fileDigests(repo)).toEqual(files)
	})

	it.each([
		"working-tree",
		"branch",
	] as const)("allows configured diff drivers without executing them during %s resolution", async (targetKind) => {
		initialize({ ".gitattributes": "*.txt diff=probe\n", "file.txt": "base\n" })
		if (targetKind === "branch") {
			git(repo, "checkout", "-b", "feature")
			write(repo, "file.txt", "changed\n")
			git(repo, "commit", "-am", "feature")
		} else {
			write(repo, "file.txt", "changed\n")
		}
		const marker = join(sandbox, `diff-driver-${targetKind}.log`)
		const driver = join(sandbox, `diff-driver-${targetKind}.sh`)
		writeFileSync(driver, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`)
		chmodSync(driver, 0o755)
		git(repo, "config", "diff.probe.command", driver)
		git(repo, "config", "diff.probe.textconv", driver)
		const target =
			targetKind === "working-tree"
				? await resolve({ kind: "working-tree", fetch: false })
				: await resolve({
						kind: "branch",
						branch: "feature",
						base: "main",
						includeWorkingTree: false,
						fetch: false,
					})
		expect(target.scope.files.changed).toBe(1)
		const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		expect(map.files["file.txt"].ranges).toEqual([{ start_line: 1, end_line: 1 }])
		expect(existsSync(marker)).toBe(false)
		await target.cleanup()
		expect(existsSync(marker)).toBe(false)
	})

	it("rejects ambiguous branch names while allowing qualified branches and tag or commit bases", async () => {
		const base = initialize()
		git(repo, "checkout", "-b", "same")
		write(repo, "file.txt", "branch version\n")
		git(repo, "commit", "-am", "branch tip")
		const branchTip = git(repo, "rev-parse", "HEAD")
		git(repo, "tag", "same", base)
		const ambiguous = resolve({
			kind: "branch",
			branch: "same",
			base: "main",
			includeWorkingTree: false,
			fetch: false,
		})
		await expect(ambiguous).rejects.toMatchObject({
			code: "ambiguous_ref",
			message: expect.stringContaining("refs/heads/same, refs/tags/same"),
		})

		git(repo, "tag", "-d", "same")
		git(repo, "tag", "-a", "same", base, "-m", "annotated collision")
		await expect(
			resolve({ kind: "branch", branch: "same", base: "main", includeWorkingTree: false, fetch: false }),
		).rejects.toMatchObject({ code: "ambiguous_ref" })

		const qualified = await resolve({
			kind: "branch",
			branch: "refs/heads/same",
			base: "main",
			includeWorkingTree: false,
			fetch: false,
		})
		expect(qualified.scope).toMatchObject({
			refs: { resolvedBase: "refs/heads/main" },
			pinned: { baseSha: base, headSha: branchTip },
		})

		git(repo, "tag", "-a", "base-tag", base, "-m", "base tag")
		const tagBase = await resolve({
			kind: "branch",
			branch: "refs/heads/same",
			base: "base-tag",
			includeWorkingTree: false,
			fetch: false,
		})
		expect(tagBase.scope).toMatchObject({
			refs: { resolvedBase: "refs/tags/base-tag" },
			pinned: { baseSha: base },
		})
		const commitBase = await resolve({
			kind: "branch",
			branch: "refs/heads/same",
			base,
			includeWorkingTree: false,
			fetch: false,
		})
		expect(commitBase.scope.pinned.baseSha).toBe(base)

		git(repo, "tag", "-d", "same")
		git(repo, "update-ref", "refs/remotes/same", branchTip)
		await expect(
			resolve({ kind: "branch", branch: "same", base: "main", includeWorkingTree: false, fetch: false }),
		).rejects.toMatchObject({ code: "ambiguous_ref", message: expect.stringContaining("refs/remotes/same") })
		await expect(
			resolve({ kind: "branch", branch: "-bad", base: "main", includeWorkingTree: false, fetch: false }),
		).rejects.toMatchObject({ code: "invalid_ref" })
	})

	it.runIf(process.platform !== "win32")(
		"scopes promisor access to the complete --fetch resolution",
		async () => {
			const base = initialize()
			const source = repo
			git(source, "checkout", "-b", "feature")
			write(source, "file.txt", "feature\n")
			git(source, "commit", "-am", "feature")
			const feature = git(source, "rev-parse", "HEAD")
			git(source, "checkout", "main")
			write(source, "main.txt", "main\n")
			git(source, "add", "main.txt")
			git(source, "commit", "-m", "main tip")
			git(source, "config", "uploadpack.allowFilter", "true")
			const hydrated = join(sandbox, "partial-hydrated")
			const offline = join(sandbox, "partial-offline")
			for (const checkout of [hydrated, offline]) {
				git(
					sandbox,
					"-c",
					"protocol.file.allow=always",
					"clone",
					"--filter=blob:none",
					"--no-checkout",
					`file://${source}`,
					checkout,
				)
				expect(() =>
					execFileSync("git", ["-C", checkout, "cat-file", "-e", `${base}:file.txt`], {
						env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
						stdio: "pipe",
					}),
				).toThrow()
			}
			const request = (fetch: boolean) => ({
				kind: "branch" as const,
				branch: "origin/feature",
				base: "origin/main",
				includeWorkingTree: false,
				fetch,
			})
			const target = await resolveReviewTarget(request(true), {
				root: hydrated,
				contextDir: join(sandbox, "hydrated-context"),
			})
			expect(target.scope).toMatchObject({
				pinned: { baseSha: base, headSha: feature, tipSha: feature },
				files: { changed: 1, anchorable: 1 },
			})
			const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
			expect(map.files["file.txt"].ranges).toEqual([{ start_line: 1, end_line: 1 }])
			expect(() =>
				execFileSync("git", ["-C", hydrated, "cat-file", "-e", `${base}:file.txt`], {
					env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
					stdio: "pipe",
				}),
			).not.toThrow()
			expect(git(hydrated, "rev-parse", "refs/remotes/origin/feature")).toBe(feature)
			await target.cleanup()

			renameSync(source, `${source}-unavailable`)
			await expect(
				resolveReviewTarget(request(false), { root: offline, contextDir: join(sandbox, "offline-context") }),
			).rejects.toMatchObject({
				code: "missing_object",
				message: expect.stringContaining("lazy fetching is disabled"),
			})
			const failure = await resolveReviewTarget(request(true), {
				root: offline,
				contextDir: join(sandbox, "unreachable-context"),
			}).catch((error: unknown) => error)
			if (!(failure instanceof Error)) throw new Error("expected the unreachable authorized fetch to fail")
			expect(failure.message.length).toBeGreaterThan(0)
			expect(failure.message).not.toContain("--fetch")
		},
		30_000,
	)

	it.each(["--assume-unchanged", "--skip-worktree"])("reports and rejects %s hidden edits", async (flag) => {
		initialize({ "file.txt": "base\n" })
		git(repo, "update-index", flag, "file.txt")
		write(repo, "file.txt", "evil\n")
		const before = checkoutState(repo)
		const choices = await getReviewTargetChoices({ kind: "bare", fetch: false }, { root: repo })
		expect(choices).toMatchObject({
			workingTreeStatus: "possible-edits",
			flaggedPaths: ["file.txt"],
			flaggedPathCount: 1,
		})
		expect(choices.choices[0].preselected).toBe(true)
		await expect(resolve({ kind: "working-tree", fetch: false })).rejects.toMatchObject({
			code: "unsupported_index_flags",
			message: expect.stringContaining("file.txt"),
		})
		expectCheckoutState(repo, before)
	})

	it("uses a fresh cleanup signal and surfaces actual cleanup failures", async () => {
		initialize()
		write(repo, "file.txt", "dirty\n")
		const controller = new AbortController()
		const target = await resolve({ kind: "working-tree", fetch: false }, { signal: controller.signal })
		const snapshotRef = target.scope.pinned.snapshotRef
		if (!snapshotRef) throw new Error("expected a snapshot ref")
		controller.abort()
		await target.cleanup()
		expect(snapshotRefs(repo)).not.toContain(snapshotRef)

		const second = await resolve(
			{ kind: "working-tree", fetch: false },
			{ contextDir: join(sandbox, "second-cleanup-context") },
		)
		const secondRef = second.scope.pinned.snapshotRef
		if (!secondRef) throw new Error("expected another snapshot ref")
		const gitDir = git(repo, "rev-parse", "--absolute-git-dir")
		const hiddenGitDir = `${gitDir}-held`
		renameSync(gitDir, hiddenGitDir)
		try {
			await expect(second.cleanup()).rejects.toThrow()
		} finally {
			renameSync(hiddenGitDir, gitDir)
		}
		expect(snapshotRefs(repo)).toContain(secondRef)
		await second.cleanup()
	})

	it("reclaims only backdated leaked snapshots older than the requested threshold", async () => {
		const tip = initialize()
		write(repo, "file.txt", "dirty\n")
		const current = await resolve({ kind: "working-tree", fetch: false })
		const currentRef = current.scope.pinned.snapshotRef
		if (!currentRef) throw new Error("expected a current snapshot ref")
		const staleRef = `${REVIEW_SNAPSHOT_REF_PREFIX}backdated`
		const tree = git(repo, "rev-parse", `${current.scope.pinned.headSha}^{tree}`)
		const staleSha = execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", tip], {
			input: "stale review snapshot\n",
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test",
				GIT_AUTHOR_DATE: "@1 +0000",
				GIT_COMMITTER_DATE: "@1 +0000",
			},
		}).trim()
		git(repo, "update-ref", staleRef, staleSha)
		const removed = await cleanupStaleReviewSnapshots({ root: repo, olderThanMs: 60 * 60 * 1000 })
		expect(removed).toEqual([{ ref: staleRef, headSha: staleSha }])
		expect(snapshotRefs(repo)).not.toContain(staleRef)
		expect(snapshotRefs(repo)).toContain(currentRef)
		await current.cleanup()
	})

	it("serializes proto, constructor, prototype, and __proto__ paths and accepts their anchors", async () => {
		initialize()
		const names = ["proto", "constructor", "prototype", "__proto__"]
		for (const name of names) write(repo, name, "first\nsecond\n")
		const target = await resolve({ kind: "working-tree", fetch: false })
		const map = JSON.parse(readFileSync(target.scope.commentableLinesPath, "utf8")) as ProviderAnchorMap
		for (const name of names) {
			expect(Object.hasOwn(map.files, name)).toBe(true)
			expect(map.files[name]).toEqual({ ranges: [{ start_line: 1, end_line: 2 }] })
		}
		const accepted = await submitFinding(
			{
				path: "__proto__",
				line: 2,
				severity: "warning",
				type: "correctness",
				description: "A prototype-named path retains its local source anchor.",
				suggestion: "",
			},
			{ contextDir: target.scope.contextDir, outputDir: join(sandbox, "prototype-output"), writer: "spec" },
		)
		expect(accepted).toMatchObject({ accepted: true, id: "spec-1" })
		await target.cleanup()
	})
})
