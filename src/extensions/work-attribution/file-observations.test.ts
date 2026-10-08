import * as childProcess from "node:child_process"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { getWorkId, setWorkId } from "../work-attribution.js"
import { createWorkCommitTrackingOperations } from "./commits.js"
import { calculatePullRequestCosts } from "./costs.js"
import { observeToolFiles } from "./file-observations.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

vi.mock("node:child_process", { spy: true })

let cwd: string
function git(...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-observations-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, ".agent"))
	git("init", "-q")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.invalid")
	git("config", "commit.gpgSign", "false")
	writeFileSync(join(cwd, ".gitignore"), ".agent/\nignored/\n")
	writeFileSync(join(cwd, "source.ts"), "original\n")
	git("add", ".")
	git("commit", "-qm", "base")
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})
function observations() {
	return readWorkRecords(join(cwd, ".agent")).filter((row) => row.type === "file_observation")
}

it("compares actual pre-existing dirty content instead of claiming human changes", async () => {
	writeFileSync(join(cwd, "source.ts"), "human version\n")
	const ctx = createContext({ cwd })
	await observeToolFiles(ctx, "read", "bash", async () => "done")
	expect(observations()).toEqual([])
	await observeToolFiles(ctx, "write", "bash", async () => writeFileSync(join(cwd, "new.ts"), "new\n"))
	expect(observations()).toHaveLength(1)
	expect(observations()[0]).toMatchObject({ complete: true, files: [{ path: "new.ts", before: null }] })
})

it("records deletion and a renamed path containing spaces and a newline", async () => {
	await observeToolFiles(createContext({ cwd }), "rename", "bash", async () => {
		renameSync(join(cwd, "source.ts"), join(cwd, "other name\n.ts"))
		git("add", ".")
	})
	expect(observations()[0]).toMatchObject({
		complete: true,
		files: expect.arrayContaining([
			expect.objectContaining({ path: "source.ts", after: null }),
			expect.objectContaining({ path: "other name\n.ts", before: null }),
		]),
	})
})

it("keeps the tool's error after recording writes made before cancellation", async () => {
	const failure = new Error("cancelled")
	const ctx = createContext({ cwd })
	await expect(
		observeToolFiles(
			ctx,
			"cancel",
			"mcp",
			async () => {
				writeFileSync(join(cwd, "source.ts"), "written before cancellation\n")
				throw failure
			},
			{ workId: getWorkId(ctx) },
		),
	).rejects.toBe(failure)
	expect(observations()[0]).toMatchObject({ source: "mcp", complete: true, files: [{ path: "source.ts" }] })
})

it("does not start tracking when MCP runs without an attributed model tool call", async () => {
	await observeToolFiles(createContext({ cwd }), "untracked", "mcp", async () => {
		writeFileSync(join(cwd, "source.ts"), "untracked\n")
	})
	expect(readWorkRecords(join(cwd, ".agent"))).toEqual([])
})

it("reads many dirty files with the same Git processes as one", async () => {
	const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
	const commands: string[] = []
	vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
		if (Array.isArray(args[1])) commands.push(String(args[1][2]))
		return execute(...args)
	}) as typeof execute)
	async function spawned(dirty: number) {
		for (let i = 0; i < dirty; i++) writeFileSync(join(cwd, `${i}.txt`), "dirty\n")
		commands.length = 0
		await observeToolFiles(createContext({ cwd }), `read-${dirty}`, "bash", async () => "listing")
		return [...commands]
	}
	const one = await spawned(1)
	expect(await spawned(100)).toEqual(one)
})

it("reports an incomplete scan instead of treating a truncated dirty tree as complete", async () => {
	for (let i = 0; i < 129; i++) writeFileSync(join(cwd, `${i}.txt`), "dirty\n")
	await observeToolFiles(createContext({ cwd }), "large", "bash", async () => {
		writeFileSync(join(cwd, "source.ts"), "changed\n")
	})
	expect(observations()[0]).toMatchObject({ complete: false, reason: "incomplete-snapshot", files: [] })
})

it.each([
	[
		"symlink",
		() => {
			symlinkSync("source.ts", join(cwd, "link"))
			git("add", "link")
		},
	],
	[
		"submodule",
		() => {
			mkdirSync(join(cwd, "vendor"))
			git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},vendor`)
		},
	],
])("records nothing for a read-only Bash call beside a committed %s", async (_case, stage) => {
	stage()
	git("commit", "-qm", "unsupported entry")
	await observeToolFiles(createContext({ cwd }), "ls", "bash", async () => "listing")
	expect(observations()).toEqual([])
})

it("keeps an input's native-edit proof after its read-only Bash call beside a committed symlink", async () => {
	symlinkSync("source.ts", join(cwd, "link"))
	git("add", "link")
	git("commit", "-qm", "link")
	const ctx = createContext({ cwd })
	const workId = getWorkId(ctx)
	await observeToolFiles(ctx, "ls", "bash", async () => "listing", { workId, requestId: "implement" })
	const { scope } = createWorkScopeSnapshot(join(cwd, ".git"))
	const owner = { workId, sessionId: "test-session", repository: join(cwd, ".git"), worktree: cwd }
	const file = (blob: string) => ({ blob: blob.repeat(40), mode: "100644" })
	const report = calculatePullRequestCosts(
		[
			{
				...owner,
				version: 1,
				type: "request",
				requestId: "implement",
				recordedAt: "2026-10-02T10:10:00.000Z",
				scope,
				segment: { id: "input", attribution: "session", reason: "matching-disabled" },
			},
			{
				...owner,
				version: 1,
				type: "file_transition",
				requestId: "implement",
				transitionId: "edit",
				toolCallId: "edit",
				path: "source.ts",
				baseline: "c".repeat(40),
				baselineFile: file("d"),
				before: file("d"),
				after: file("e"),
				cursor: { bytes: 0, digest: "f".repeat(64) },
			},
			{
				...owner,
				version: 1,
				type: "commit",
				sha: "a".repeat(40),
				source: "native-file-transition",
				fileMatches: [{ path: "source.ts", worktree: cwd, method: "file-chain", transitionIds: ["edit"] }],
				pullRequests: [
					{
						provider: "github",
						host: "github.com",
						repository: "example/repository",
						number: 1,
						url: "https://github.com/example/repository/pull/1",
						state: "merged",
						headSha: "a".repeat(40),
						mergeCommitSha: "b".repeat(40),
						mergedAt: "2026-10-02T10:30:00.000Z",
						closedAt: "2026-10-02T10:30:00.000Z",
						checkedAt: "2026-10-02T10:40:00.000Z",
					},
				],
			},
			...observations(),
		],
		[{ requestId: "implement", billingRecordId: "bill", costUsd: "1", account: scope.account }],
	)
	expect(report.requests).toMatchObject([{ requestId: "implement", allocation: "pull-request" }])
	expect(report.pullRequests[0].explicit.knownCostUsd).toBe("1.000000000")
})

it("pins a delayed Bash operation to its original work before execution starts", async () => {
	const ctx = createContext({ cwd })
	const original = getWorkId(ctx)
	const operation = createWorkCommitTrackingOperations(ctx, "delayed")
	setWorkId(ctx)
	await operation.exec("printf 'changed\\n' > source.ts", cwd, { onData: () => {} })
	expect(observations()[0]).toMatchObject({ workId: original, toolCallId: "delayed", complete: true })
})

it.each([
	["an untracked symlink", () => symlinkSync("source.ts", join(cwd, "link"))],
	["a dirty file over 8 MiB", () => writeFileSync(join(cwd, "big.log"), Buffer.alloc(8 * 1024 * 1024 + 1, 97))],
	[
		"a nested repository",
		() => {
			mkdirSync(join(cwd, "vendor"))
			execFileSync("git", ["-C", join(cwd, "vendor"), "init", "-q"])
		},
	],
])("observes a read-only Bash call silently in a repository with %s", async (_case, setup) => {
	setup()
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	try {
		await observeToolFiles(createContext({ cwd }), "read-only", "bash", async () => "listing")
		expect(warn).not.toHaveBeenCalled()
	} finally {
		warn.mockRestore()
	}
})
