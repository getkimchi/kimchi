import { execFile as execFileCallback } from "node:child_process"
import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import {
	createVerifierGuard,
	enforceWorkspaceIntegrity,
	isVerifierWritablePath,
	type VerifierGuard,
} from "./verifier-guard.js"
import {
	detectGitWorkspace,
	diffSnapshots,
	removePaths,
	restorePaths,
	snapshotWorkspace,
	workspaceHead,
} from "./workspace.js"

const execFile = promisify(execFileCallback)

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, encoding: "utf-8" })
	return stdout
}

/** HEAD commit sha of the workspace, or undefined when HEAD is unborn/unresolvable. */
async function headSha(dir: string): Promise<string | undefined> {
	const head = await workspaceHead(dir)
	return head?.kind === "commit" ? head.sha : undefined
}

/** Bind the guard's inline extension to a fresh mock ExtensionAPI and expose its handler registry. */
function bindGuard(guard: VerifierGuard): ReturnType<typeof createExtensionApi> {
	const ext = createExtensionApi()
	const factory = typeof guard.extension === "function" ? guard.extension : guard.extension?.factory
	factory?.(ext.api)
	return ext
}

/** Emit one tool_result through the bound guard and return its first result. */
async function await0(
	ext: ReturnType<typeof createExtensionApi>,
	payload: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] } | undefined> {
	const results = await ext.emit("tool_result", payload)
	return results[0] as { content: { type: string; text: string }[] } | undefined
}

async function initRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-verifier-guard-"))
	await git(dir, ["init", "-q"])
	await git(dir, ["config", "user.email", "test@example.com"])
	await git(dir, ["config", "user.name", "Test"])
	writeFileSync(join(dir, "tracked.txt"), "original\n")
	mkdirSync(join(dir, "src"))
	writeFileSync(join(dir, "src", "nested.txt"), "nested original\n")
	await git(dir, ["add", "-A"])
	await git(dir, ["commit", "-q", "-m", "initial"])
	return dir
}

/** A repository with an unborn HEAD: initialized and configured, but no commits. */
async function initFreshRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-verifier-fresh-"))
	await git(dir, ["init", "-q"])
	await git(dir, ["config", "user.email", "test@example.com"])
	await git(dir, ["config", "user.name", "Test"])
	writeFileSync(join(dir, "tracked.txt"), "original\n")
	return dir
}

describe("createVerifierGuard evidence stamping", () => {
	it("prefixes every tool result with a sequential [eN] id and records evidence", async () => {
		const guard = createVerifierGuard()
		const ext = bindGuard(guard)
		const first = await await0(ext, {
			type: "tool_result",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "echo hi" },
			content: [{ type: "text", text: "hi" }],
			isError: false,
		})
		const second = await await0(ext, {
			type: "tool_result",
			toolCallId: "c2",
			toolName: "read",
			input: { path: "src/a.ts" },
			content: [{ type: "text", text: "file body" }],
			isError: true,
		})
		expect(first?.content[0]?.text).toBe("[e1] hi")
		expect(second?.content[0]?.text).toBe("[e2] file body")
		expect([...guard.evidence.keys()]).toEqual(["e1", "e2"])
		expect(guard.evidence.get("e1")).toMatchObject({
			id: "e1",
			toolName: "bash",
			input: { command: "echo hi" },
			isError: false,
			excerpt: "hi",
		})
		expect(guard.evidence.get("e2")?.isError).toBe(true)
	})
})

function toolCall(input: Record<string, unknown>, toolName = "bash") {
	return { type: "tool_call", toolCallId: "c1", toolName, input }
}

/** The blocking results of one tool_call emission (handlers that let the call through return undefined). */
async function blocks(ext: ReturnType<typeof createExtensionApi>, payload: unknown): Promise<unknown[]> {
	return (await ext.emit("tool_call", payload)).filter((result) => result !== undefined)
}

describe("createVerifierGuard baseline worktree", () => {
	it("checks the worktree out only when a tool call references its path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-verifier-lazy-wt-"))
		try {
			const ensure = vi.fn(async () => true)
			const ext = bindGuard(createVerifierGuard({ baselineWorktree: { path: dir, ensure } }))
			expect(await blocks(ext, toolCall({ command: "pnpm test" }))).toEqual([])
			expect(ensure).not.toHaveBeenCalled()
			expect(await blocks(ext, toolCall({ command: `cd ${dir} && pnpm test` }))).toEqual([])
			expect(await blocks(ext, toolCall({ path: join(dir, "src", "a.ts") }, "read"))).toEqual([])
			// The symlink-resolved form (macOS keeps the temp dir under /private) counts too.
			expect(await blocks(ext, toolCall({ command: `ls ${realpathSync(dir)}` }))).toEqual([])
			expect(ensure).toHaveBeenCalledTimes(3)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("blocks a call that references the worktree when it cannot be created", async () => {
		const path = "/tmp/kimchi-ferment-v2-baseline-missing"
		const ext = bindGuard(createVerifierGuard({ baselineWorktree: { path, ensure: async () => false } }))
		const [result] = await blocks(ext, toolCall({ command: `cd ${path} && pnpm test` }))
		expect(result).toMatchObject({ block: true })
		expect((result as { reason: string }).reason).toContain("could not be created")
	})

	it("does not intercept non-write tool calls without a reserved worktree", async () => {
		const ext = bindGuard(createVerifierGuard())
		expect(await blocks(ext, toolCall({ command: "ls /tmp" }))).toEqual([])
	})
})

describe("createVerifierGuard write confinement", () => {
	it("allows new repository files and anything in the worktree, blocks existing repository files and outside paths", async () => {
		const repo = mkdtempSync(join(tmpdir(), "kimchi-verifier-writes-"))
		const worktree = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-baseline-writes-"))
		try {
			writeFileSync(join(repo, "existing.ts"), "original\n")
			writeFileSync(join(worktree, "existing.ts"), "baseline\n")
			const ext = bindGuard(
				createVerifierGuard({ cwd: repo, baselineWorktree: { path: worktree, ensure: async () => true } }),
			)
			const write = (path: string) => blocks(ext, toolCall({ path, content: "probe" }, "write"))

			expect(await write("test/probe.test.ts")).toEqual([])
			expect(await write(join(worktree, "existing.ts"))).toEqual([])
			expect(await write(join(worktree, "new.test.ts"))).toEqual([])
			for (const path of ["existing.ts", join(repo, "existing.ts"), "/etc/kimchi-probe", "../escape.ts"]) {
				const [result] = await write(path)
				expect(result, path).toMatchObject({ block: true })
				expect((result as { reason: string }).reason).toContain("NEW files inside the repository")
			}
			const [edit] = await blocks(ext, toolCall({ path: "existing.ts", oldText: "a", newText: "b" }, "edit"))
			expect(edit).toMatchObject({ block: true })
		} finally {
			rmSync(repo, { recursive: true, force: true })
			rmSync(worktree, { recursive: true, force: true })
		}
	})

	it("records files created by successful writes, resolved against the repository", async () => {
		const guard = createVerifierGuard({ cwd: "/repo" })
		const ext = bindGuard(guard)
		const result = (path: string, isError: boolean) => ({
			type: "tool_result",
			toolCallId: "w",
			toolName: "write",
			input: { path, content: "probe" },
			content: [{ type: "text", text: "ok" }],
			isError,
		})
		await ext.emit("tool_result", result("test/probe.test.ts", false))
		await ext.emit("tool_result", result("test/failed.test.ts", true))
		expect([...guard.createdFiles]).toEqual(["/repo/test/probe.test.ts"])
	})
})

describe("isVerifierWritablePath", () => {
	it("rejects non-string and empty paths and writes without any root", () => {
		expect(isVerifierWritablePath(undefined, { cwd: "/repo" })).toBe(false)
		expect(isVerifierWritablePath("  ", { cwd: "/repo" })).toBe(false)
		expect(isVerifierWritablePath("a.ts", {})).toBe(false)
	})
})

describe("createVerifierGuard usage accumulation", () => {
	it("accumulates assistant usage per message_end, including cost", async () => {
		const guard = createVerifierGuard()
		const ext = bindGuard(guard)
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
		}
		await ext.emit("message_end", { type: "message_end", message: { role: "assistant", usage } })
		// Non-assistant messages and messages without usage never contribute.
		await ext.emit("message_end", { type: "message_end", message: { role: "user", content: "hi", usage } })
		await ext.emit("message_end", { type: "message_end", message: { role: "assistant", content: [] } })
		expect(guard.usage).toEqual({
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			costUsd: 0.33,
		})
	})

	it("accumulates compaction usage from session_compact events", async () => {
		const guard = createVerifierGuard()
		const ext = bindGuard(guard)
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 8,
			cacheWrite: 4,
			totalTokens: 162,
			cost: { input: 0.5, output: 0.25, cacheRead: 0.02, cacheWrite: 0.01, total: 0.78 },
		}
		await ext.emit("message_end", { type: "message_end", message: { role: "assistant", usage } })
		// Compaction bills a summarization completion no assistant message carries:
		// its usage reaches the guard only through the session_compact event.
		await ext.emit("session_compact", {
			type: "session_compact",
			compactionEntry: { type: "compaction", usage },
			fromExtension: false,
			reason: "threshold",
			willRetry: false,
		})
		// A compaction entry without usage never contributes.
		await ext.emit("session_compact", {
			type: "session_compact",
			compactionEntry: { type: "compaction" },
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		})
		expect(guard.usage).toMatchObject({
			input: 200,
			output: 100,
			cacheRead: 16,
			cacheWrite: 8,
			totalTokens: 324,
		})
		expect(guard.usage.costUsd).toBeCloseTo(1.56)
	})
})

describe("snapshotWorkspace", () => {
	it("snapshots the working tree without touching the real index, tree, or refs", async () => {
		const dir = await initRepo()
		try {
			// Dirty the tree first: the snapshot must capture this state while the
			// real index, the working tree, and all refs stay untouched by it.
			writeFileSync(join(dir, "tracked.txt"), "modified\n")
			writeFileSync(join(dir, "untracked.txt"), "new\n")
			const beforeStatus = await git(dir, ["status", "--porcelain"])
			const beforeIndex = readFileSync(join(dir, ".git", "index"))
			const head = await headSha(dir)

			const snapshot = await snapshotWorkspace(dir)

			expect(snapshot?.tree).toMatch(/^[0-9a-f]{40}$/)
			expect(snapshot?.commit).toMatch(/^[0-9a-f]{40}$/)
			// The snapshot commit has HEAD as parent but does not move any ref.
			expect(snapshot?.commit).not.toBe(head)
			const refs = await git(dir, ["show-ref"])
			expect(refs).not.toContain(snapshot?.commit ?? "")
			// The real index and status are byte-identical after the snapshot.
			expect(await git(dir, ["status", "--porcelain"])).toBe(beforeStatus)
			expect(readFileSync(join(dir, ".git", "index"))).toEqual(beforeIndex)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-not-git-"))
		try {
			expect(await snapshotWorkspace(dir)).toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("snapshots a fresh repository without commits or an index file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-fresh-repo-"))
		try {
			await git(dir, ["init", "-q"])
			// commit-tree needs an ident even for a parentless snapshot commit; the
			// isolated test HOME has no global gitconfig to provide one.
			await git(dir, ["config", "user.email", "test@example.com"])
			await git(dir, ["config", "user.name", "Test"])
			writeFileSync(join(dir, "tracked.txt"), "original\n")
			expect(existsSync(join(dir, ".git", "index"))).toBe(false)
			const snapshot = await snapshotWorkspace(dir)
			expect(snapshot?.tree).toMatch(/^[0-9a-f]{40}$/)
			expect(snapshot?.commit).toMatch(/^[0-9a-f]{40}$/)
			expect(await workspaceHead(dir)).toMatchObject({ kind: "unborn" })
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("captures edits to skip-worktree and assume-unchanged files without touching the real index bits", async () => {
		const dir = await initRepo()
		try {
			await git(dir, ["update-index", "--skip-worktree", "tracked.txt"])
			await git(dir, ["update-index", "--assume-unchanged", "src/nested.txt"])
			writeFileSync(join(dir, "tracked.txt"), "hidden edit\n")
			writeFileSync(join(dir, "src", "nested.txt"), "hidden nested edit\n")

			const snapshot = await snapshotWorkspace(dir)

			// The snapshot tree records the edited content, not the stale blob the
			// flagged index entries would keep `git add -A` from refreshing.
			expect(await git(dir, ["show", `${snapshot?.tree}:tracked.txt`])).toBe("hidden edit\n")
			expect(await git(dir, ["show", `${snapshot?.tree}:src/nested.txt`])).toBe("hidden nested edit\n")
			// The user's index bits survive the snapshot untouched.
			const tags = await git(dir, ["ls-files", "-v", "--", "tracked.txt", "src/nested.txt"])
			expect(tags).toContain("S tracked.txt")
			expect(tags).toContain("h src/nested.txt")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("captures edits to flagged files outside the session subdirectory", async () => {
		const dir = await initRepo()
		try {
			// git ls-files and update-index scope to the directory they run
			// from: from the src/ subdirectory they would see only src/, leaving
			// the root file's skip-worktree bit set in the temporary index copy.
			await git(dir, ["update-index", "--skip-worktree", "tracked.txt"])
			writeFileSync(join(dir, "tracked.txt"), "hidden edit\n")

			const snapshot = await snapshotWorkspace(join(dir, "src"))

			// The snapshot tree records the edited content even though the session
			// runs from a subdirectory: enumeration and clearing anchor at the
			// repository root, not the session cwd.
			expect(await git(dir, ["show", `${snapshot?.tree}:tracked.txt`])).toBe("hidden edit\n")
			expect(await git(dir, ["show", `${snapshot?.tree}:src/nested.txt`])).toBe("nested original\n")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("diffSnapshots", () => {
	it("classifies modified, deleted, and added paths", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			writeFileSync(join(dir, "tracked.txt"), "changed\n")
			rmSync(join(dir, "src", "nested.txt"))
			writeFileSync(join(dir, "new-file.txt"), "brand new\n")
			const after = await snapshotWorkspace(dir)
			const diff = await diffSnapshots(dir, before as never, after as never)
			expect(diff.modified).toEqual(["tracked.txt"])
			expect(diff.deleted).toEqual(["src/nested.txt"])
			expect(diff.added).toEqual(["new-file.txt"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("restorePaths", () => {
	it("restores modified and deleted files from the snapshot tree", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			writeFileSync(join(dir, "tracked.txt"), "verifier-mangled\n")
			rmSync(join(dir, "src", "nested.txt"))
			await restorePaths(dir, before as never, ["tracked.txt", "src/nested.txt"])
			expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe("original\n")
			expect(readFileSync(join(dir, "src", "nested.txt"), "utf-8")).toBe("nested original\n")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("restores binary bytes, executable bits, and symlinks from the snapshot tree", async () => {
		const dir = await initRepo()
		try {
			// core.filemode must be forced so the executable bit is recorded even on filesystems that cannot represent it.
			await git(dir, ["config", "core.filemode", "true"])
			const binary = Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x01, 0x02, 0xff, 0xfe])
			writeFileSync(join(dir, "blob.bin"), binary)
			writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 })
			symlinkSync("tracked.txt", join(dir, "link.txt"))
			await git(dir, ["add", "-A"])
			await git(dir, ["commit", "-q", "-m", "binaries"])
			const before = await snapshotWorkspace(dir)
			// Corrupt the binary, drop the executable bit, and replace the symlink with a regular file.
			writeFileSync(join(dir, "blob.bin"), "text-mangled\n")
			chmodSync(join(dir, "run.sh"), 0o644)
			rmSync(join(dir, "link.txt"))
			writeFileSync(join(dir, "link.txt"), "tracked.txt")
			await restorePaths(dir, before as never, ["blob.bin", "run.sh", "link.txt"])
			expect(readFileSync(join(dir, "blob.bin"))).toEqual(binary)
			expect(lstatSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0)
			expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true)
			expect(readFileSync(join(dir, "link.txt"), "utf-8")).toBe("original\n")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("resolves snapshot paths against the repository root, not the session cwd", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			writeFileSync(join(dir, "tracked.txt"), "verifier-mangled\n")
			// Kimchi can run from a repository subdirectory; snapshot paths stay repo-root-relative.
			await restorePaths(join(dir, "src"), before as never, ["tracked.txt"])
			expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe("original\n")
			expect(existsSync(join(dir, "src", "tracked.txt"))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("removePaths", () => {
	it("removes added files and prunes emptied directories", async () => {
		const dir = await initRepo()
		try {
			mkdirSync(join(dir, "scratch"))
			writeFileSync(join(dir, "scratch", "probe.txt"), "x")
			await removePaths(dir, ["scratch/probe.txt"])
			expect(existsSync(join(dir, "scratch", "probe.txt"))).toBe(false)
			expect(existsSync(join(dir, "scratch"))).toBe(false)
			expect(existsSync(join(dir, "tracked.txt"))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("removes repository-root-relative paths when run from a subdirectory", async () => {
		const dir = await initRepo()
		try {
			writeFileSync(join(dir, "root-scratch.txt"), "x")
			await removePaths(join(dir, "src"), ["root-scratch.txt"])
			expect(existsSync(join(dir, "root-scratch.txt"))).toBe(false)
			expect(existsSync(join(dir, "src", "root-scratch.txt"))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("enforceWorkspaceIntegrity", () => {
	it("restores a bash-edited tracked file, removes added files, and reports the violation", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			// Simulate the verifier: a bash edit to a tracked file + a scratch file.
			writeFileSync(join(dir, "tracked.txt"), "verifier edit\n")
			writeFileSync(join(dir, "verifier-scratch.txt"), "scratch\n")
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.violated).toBe(true)
			expect(result.restored).toEqual(["tracked.txt"])
			expect(result.removed).toEqual(["verifier-scratch.txt"])
			expect(result.headMoved).toBe(false)
			expect(result.postRunSnapshot).toMatch(/^[0-9a-f]{40}$/)
			expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe("original\n")
			expect(existsSync(join(dir, "verifier-scratch.txt"))).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects a HEAD move without git surgery", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			writeFileSync(join(dir, "another.txt"), "more\n")
			await git(dir, ["add", "-A"])
			await git(dir, ["commit", "-q", "-m", "verifier committed"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.headMoved).toBe(true)
			expect(result.violated).toBe(true)
			// No git surgery: the new commit stays checked out.
			expect(await headSha(dir)).not.toBe(head?.kind === "commit" ? head.sha : undefined)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects a branch switch at the same commit as a HEAD move", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			expect(head?.kind).toBe("commit")
			// `git checkout -b` moves HEAD to a new branch without changing the commit.
			await git(dir, ["checkout", "-q", "-b", "verifier-scratch"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.headMoved).toBe(true)
			expect(result.violated).toBe(true)
			// No git surgery: the workspace stays on the verifier's branch.
			const after = await workspaceHead(dir)
			expect(after?.kind === "commit" ? after.ref : undefined).toBe("refs/heads/verifier-scratch")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects detaching HEAD at the same commit as a HEAD move", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			// `git checkout --detach` keeps the same commit but detaches HEAD.
			await git(dir, ["checkout", "-q", "--detach"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.headMoved).toBe(true)
			expect(result.violated).toBe(true)
			const after = await workspaceHead(dir)
			expect(after?.kind === "commit" ? after.ref : "attached").toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects a transition to an unborn HEAD as a HEAD move", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			// `git checkout --orphan` leaves files and index untouched but HEAD unborn.
			await git(dir, ["checkout", "-q", "--orphan", "scratch"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.headMoved).toBe(true)
			expect(result.violated).toBe(true)
			expect(result.restored).toEqual([])
			expect(await workspaceHead(dir)).toMatchObject({ kind: "unborn", ref: "refs/heads/scratch" })
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects a commit onto an unborn HEAD as a HEAD move", async () => {
		const dir = await initFreshRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			expect(head?.kind).toBe("unborn")
			await git(dir, ["add", "-A"])
			await git(dir, ["commit", "-q", "-m", "verifier committed"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.headMoved).toBe(true)
			expect(result.violated).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports a clean run without violations", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const result = await enforceWorkspaceIntegrity(dir, before as never, await workspaceHead(dir))
			expect(result).toMatchObject({ violated: false, restored: [], removed: [], headMoved: false })
			expect(result.postRunSnapshot).toMatch(/^[0-9a-f]{40}$/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports a clean run on an unchanged unborn HEAD", async () => {
		const dir = await initFreshRepo()
		try {
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result).toMatchObject({ violated: false, restored: [], removed: [], headMoved: false })
			expect(result.postRunSnapshot).toMatch(/^[0-9a-f]{40}$/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("restores a verifier-edited skip-worktree file to its pre-run content, keeping the user's index bit", async () => {
		const dir = await initRepo()
		try {
			// The user carries a local edit in a skip-worktree file when the
			// verifier runs: the restore must return to that pre-run content, not
			// to HEAD, and must not clear the user's index bit.
			writeFileSync(join(dir, "tracked.txt"), "user local change\n")
			await git(dir, ["update-index", "--skip-worktree", "tracked.txt"])
			await git(dir, ["update-index", "--assume-unchanged", "src/nested.txt"])
			const before = await snapshotWorkspace(dir)
			const head = await workspaceHead(dir)
			writeFileSync(join(dir, "tracked.txt"), "verifier edit\n")
			writeFileSync(join(dir, "src", "nested.txt"), "verifier nested edit\n")
			const result = await enforceWorkspaceIntegrity(dir, before as never, head)
			expect(result.violated).toBe(true)
			expect([...result.restored].sort()).toEqual(["src/nested.txt", "tracked.txt"])
			expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe("user local change\n")
			expect(readFileSync(join(dir, "src", "nested.txt"), "utf-8")).toBe("nested original\n")
			const tags = await git(dir, ["ls-files", "-v", "--", "tracked.txt", "src/nested.txt"])
			expect(tags).toContain("S tracked.txt")
			expect(tags).toContain("h src/nested.txt")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("restores a verifier-edited skip-worktree file at the repository root when the session runs from a subdirectory", async () => {
		const dir = await initRepo()
		try {
			// Regression: flag enumeration and clearing used to run from the
			// session cwd, so git ls-files saw only the subdirectory's subtree and
			// the root file's skip-worktree bit survived in the temporary index —
			// the edit stayed undetected with violated: false.
			await git(dir, ["update-index", "--skip-worktree", "tracked.txt"])
			await git(dir, ["update-index", "--assume-unchanged", "src/nested.txt"])
			const subdir = join(dir, "src")
			const before = await snapshotWorkspace(subdir)
			const head = await workspaceHead(subdir)
			writeFileSync(join(dir, "tracked.txt"), "verifier edit\n")
			writeFileSync(join(dir, "src", "nested.txt"), "verifier nested edit\n")
			const result = await enforceWorkspaceIntegrity(subdir, before as never, head)
			expect(result.violated).toBe(true)
			expect([...result.restored].sort()).toEqual(["src/nested.txt", "tracked.txt"])
			expect(readFileSync(join(dir, "tracked.txt"), "utf-8")).toBe("original\n")
			expect(readFileSync(join(dir, "src", "nested.txt"), "utf-8")).toBe("nested original\n")
			const tags = await git(dir, ["ls-files", "-v", "--", "tracked.txt", "src/nested.txt"])
			expect(tags).toContain("S tracked.txt")
			expect(tags).toContain("h src/nested.txt")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("skips HEAD-move detection when the before-run HEAD is unknown", async () => {
		const dir = await initRepo()
		try {
			const before = await snapshotWorkspace(dir)
			await git(dir, ["checkout", "-q", "-b", "verifier-scratch"])
			const result = await enforceWorkspaceIntegrity(dir, before as never, undefined)
			expect(result).toMatchObject({ violated: false, headMoved: false, restored: [], removed: [] })
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports unenforced outside git", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-not-git-"))
		try {
			const result = await enforceWorkspaceIntegrity(dir, { commit: "c", tree: "t" }, undefined)
			expect(result.unenforced).toBe(true)
			expect(result.violated).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("detectGitWorkspace", () => {
	it("detects a git work tree", async () => {
		const dir = await initRepo()
		try {
			expect(await detectGitWorkspace(dir)).toBe("git")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("detects a confirmed non-repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-not-git-"))
		try {
			expect(await detectGitWorkspace(dir)).toBe("outside_git")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("reports unknown when git could not answer (aborted probe)", async () => {
		const dir = await initRepo()
		try {
			const controller = new AbortController()
			controller.abort()
			expect(await detectGitWorkspace(dir, controller.signal)).toBe("unknown")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
