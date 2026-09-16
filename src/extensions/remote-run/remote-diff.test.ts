import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type * as SandboxGitModule from "./sandbox-git.js"

const { mockRunSandboxGit } = vi.hoisted(() => ({
	mockRunSandboxGit: vi.fn(),
}))

vi.mock("./sandbox-git.js", async (importOriginal) => ({
	...(await importOriginal<typeof SandboxGitModule>()),
	runSandboxGit: mockRunSandboxGit,
}))

const { collectCompletionDiff, parseDiffStat, streamRemotePatch } = await import("./remote-diff.js")
const { SandboxGitError } = await import("./sandbox-git.js")

type Connection = Parameters<typeof collectCompletionDiff>[0]["connection"]

const CONNECTION = {
	host: "worker.example.com",
	remoteUser: "sandbox",
	authToken: "tok",
	cwd: "/home/sandbox/acp-test",
} as unknown as Connection

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)

function gitResult(stdout: string): Awaited<ReturnType<typeof SandboxGitModule.runSandboxGit>> {
	return { stdout, stderr: "" }
}

const CLEAN_STATUS = gitResult("")

function setupHappyPath(opts?: { status?: string; head?: string }) {
	mockRunSandboxGit.mockImplementation(({ args }: { args: string[] }) => {
		if (args[0] === "rev-parse") return Promise.resolve(gitResult(`${opts?.head ?? HEAD_SHA}\n`))
		if (args[0] === "diff" && args.includes("--stat"))
			return Promise.resolve(
				gitResult(" src/a.ts | 10 +++++++---\n 2 files changed, 8 insertions(+), 3 deletions(-)\n"),
			)
		if (args[0] === "diff" && args.includes("--name-only")) return Promise.resolve(gitResult("src/a.ts\nsrc/b.ts\n"))
		if (args[0] === "status") return Promise.resolve(gitResult(opts?.status ?? ""))
		throw new Error(`unexpected git call: ${args.join(" ")}`)
	})
}

describe("parseDiffStat", () => {
	it("parses the trailing summary line, ignoring the per-file columns", () => {
		expect(parseDiffStat(" a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n")).toEqual({
			files: 1,
			additions: 1,
			deletions: 1,
		})
	})

	it("tolerates missing insertion/deletion segments", () => {
		expect(parseDiffStat("3 files changed, 5 deletions(-)")).toEqual({ files: 3, additions: 0, deletions: 5 })
	})

	it("returns zeros for empty or unrecognised output", () => {
		expect(parseDiffStat("")).toEqual({ files: 0, additions: 0, deletions: 0 })
		expect(parseDiffStat("no summary here")).toEqual({ files: 0, additions: 0, deletions: 0 })
	})
})

describe("collectCompletionDiff", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("issues rev-parse, diff --stat, diff --name-only and status --porcelain over SSH", async () => {
		setupHappyPath()

		await collectCompletionDiff({ connection: CONNECTION, baseSha: BASE_SHA })

		const argLists = mockRunSandboxGit.mock.calls.map((call) => (call[0] as { args: string[] }).args)
		expect(argLists).toContainEqual(["rev-parse", "HEAD"])
		expect(argLists).toContainEqual(["diff", "--stat", `${BASE_SHA}...HEAD`])
		expect(argLists).toContainEqual(["diff", "--name-only", `${BASE_SHA}...HEAD`])
		expect(argLists).toContainEqual(["status", "--porcelain"])
	})

	it("returns files/additions/deletions and the changed-file list", async () => {
		setupHappyPath()

		const stat = await collectCompletionDiff({ connection: CONNECTION, baseSha: BASE_SHA })

		expect(stat).toMatchObject({
			files: 2,
			additions: 8,
			deletions: 3,
			filesList: ["src/a.ts", "src/b.ts"],
			leftoverFiles: [],
			touchedBaselineFiles: [],
		})
	})

	it("returns undefined and skips the diff when HEAD still equals baseSha (no committed work)", async () => {
		setupHappyPath({ head: BASE_SHA })

		const stat = await collectCompletionDiff({ connection: CONNECTION, baseSha: BASE_SHA })

		expect(stat).toBeUndefined()
		expect(mockRunSandboxGit).toHaveBeenCalledTimes(1)
	})

	it("separates baseline files the run touched from real leftover files", async () => {
		setupHappyPath({ status: " M src/user-file.ts\n?? notes.txt\n M src/other.ts\n" })

		const stat = await collectCompletionDiff({
			connection: CONNECTION,
			baseSha: BASE_SHA,
			baselineDirtyFiles: ["src/user-file.ts"],
		})

		expect(stat?.leftoverFiles).toEqual(["notes.txt", "src/other.ts"])
		expect(stat?.touchedBaselineFiles).toEqual(["src/user-file.ts"])
	})

	it("treats a fully clean tree as no leftovers", async () => {
		setupHappyPath({ status: "" })

		const stat = await collectCompletionDiff({
			connection: CONNECTION,
			baseSha: BASE_SHA,
			baselineDirtyFiles: ["src/user-file.ts"],
		})

		expect(stat?.leftoverFiles).toEqual([])
		expect(stat?.touchedBaselineFiles).toEqual([])
	})

	it("propagates SSH git failures to the caller", async () => {
		mockRunSandboxGit.mockRejectedValue(new SandboxGitError(255, "stderr text", "boom"))

		await expect(collectCompletionDiff({ connection: CONNECTION, baseSha: BASE_SHA })).rejects.toThrow("boom")
	})

	void CLEAN_STATUS
})

describe("streamRemotePatch", () => {
	const tmp = mkdtempSync(join(tmpdir(), "remote-diff-test-"))
	afterAll(() => rmSync(tmp, { recursive: true, force: true }))

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("streams chunks to onChunk, appends them to the patch file, and totals bytes", async () => {
		mockRunSandboxGit.mockImplementation(({ onStdoutChunk }: { onStdoutChunk?: (chunk: string) => void }) => {
			onStdoutChunk?.("diff --git a/a.ts b/a.ts\n")
			onStdoutChunk?.("+hello\n")
			return Promise.resolve(gitResult(""))
		})
		const patchPath = join(tmp, "case-1", "remote-diff.patch")
		const chunks: Array<[number, string]> = []

		const stream = streamRemotePatch({
			connection: CONNECTION,
			baseSha: BASE_SHA,
			patchPath,
			onChunk: (version, chunk) => chunks.push([version, chunk]),
		})
		const outcome = await stream.promise

		expect(chunks).toEqual([
			[1, "diff --git a/a.ts b/a.ts\n"],
			[1, "+hello\n"],
		])
		expect(readFileSync(patchPath, "utf8")).toBe("diff --git a/a.ts b/a.ts\n+hello\n")
		expect(outcome).toEqual({ bytesAppended: Buffer.byteLength("diff --git a/a.ts b/a.ts\n") + 7, cancelled: false })
		const call = mockRunSandboxGit.mock.calls[0]?.[0] as { args: string[] }
		expect(call.args).toEqual(["diff", "--binary", `${BASE_SHA}...HEAD`])
	})

	it("works without a patch file", async () => {
		mockRunSandboxGit.mockImplementation(({ onStdoutChunk }: { onStdoutChunk?: (chunk: string) => void }) => {
			onStdoutChunk?.("chunk")
			return Promise.resolve(gitResult(""))
		})
		const chunks: string[] = []

		const stream = streamRemotePatch({ connection: CONNECTION, baseSha: BASE_SHA, onChunk: (_v, c) => chunks.push(c) })
		const outcome = await stream.promise

		expect(chunks).toEqual(["chunk"])
		expect(outcome).toEqual({ bytesAppended: 5, cancelled: false })
	})

	it("cancel() resolves with what arrived instead of rejecting", async () => {
		mockRunSandboxGit.mockImplementation(
			({ onStdoutChunk, signal }: { onStdoutChunk?: (chunk: string) => void; signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					onStdoutChunk?.("partial\n")
					signal?.addEventListener("abort", () => reject(new SandboxGitError(-1, "", "killed")))
				}),
		)

		const stream = streamRemotePatch({ connection: CONNECTION, baseSha: BASE_SHA, onChunk: () => {} })
		stream.cancel()
		const outcome = await stream.promise

		expect(outcome).toEqual({ bytesAppended: 8, cancelled: true })
	})

	it("propagates failures that are not our own cancellation", async () => {
		mockRunSandboxGit.mockRejectedValue(new SandboxGitError(255, "stderr text", "ssh died"))

		const stream = streamRemotePatch({ connection: CONNECTION, baseSha: BASE_SHA, onChunk: () => {} })
		await expect(stream.promise).rejects.toThrow("ssh died")
	})
})
