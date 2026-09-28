import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createBackgroundBashToolDefinition } from "../bash-background/bash-background-tool.js"
import bashBackgroundExtension from "../bash-background/index.js"
import { createProcessRegistry } from "../bash-background/process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "../bash-background/session-registry.js"
import * as attribution from "../work-attribution.js"
import { createCommitTrackingBashTool, createCommitTrackingOperations, type ObservedCommit } from "./commits.js"

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
}))

let directory: string
let repository: string
let commits: ObservedCommit[]

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

async function run(command: string, cwd = repository): Promise<number | null> {
	return (
		await createCommitTrackingOperations((commit) => commits.push(commit)).exec(command, cwd, {
			onData: () => {},
			env: { ...process.env },
		})
	).exitCode
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-commits-test-")))
	repository = join(directory, "repo")
	git(directory, "init", "--initial-branch=main", repository)
	git(repository, "config", "user.name", "Kimchi Test")
	git(repository, "config", "user.email", "test@example.invalid")
	git(repository, "config", "commit.gpgSign", "false")
	commits = []
})

afterEach(() => {
	vi.restoreAllMocks()
	rmSync(directory, { recursive: true, force: true })
})

describe("Git commit observation", () => {
	it("records root commits and amendments even when the shell later fails", async () => {
		expect(await run("git commit --allow-empty -m first && git commit --allow-empty --amend -m amended; false")).toBe(1)
		const shas = git(repository, "reflog", "--format=%H").split("\n").reverse()
		expect(commits).toEqual(shas.map((sha) => ({ sha, repository: join(repository, ".git"), worktree: repository })))
	})

	it("tracks the actual git -C and shell cd worktrees", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const worktree = join(directory, "linked tree")
		git(repository, "worktree", "add", "-b", "linked", worktree)
		expect(
			await run(
				`git -C ${quote(worktree)} commit --allow-empty -m linked; cd ${quote(repository)} && git commit --allow-empty -m main`,
				directory,
			),
		).toBe(0)
		expect(commits).toEqual([
			{ sha: git(worktree, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree },
			{ sha: git(repository, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree: repository },
		])
	})

	it("does not record checkout or reset alongside a real commit", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		await run("git commit --allow-empty -m ours; git reset --hard HEAD~; git checkout -b other")
		const ours = git(repository, "reflog", "--format=%H", "--grep-reflog=commit: ours")
		expect(commits.map((commit) => commit.sha)).toEqual([ours])
	})

	it("does not record pulled or concurrently externally created commits", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const remote = join(directory, "remote")
		git(directory, "clone", repository, remote)
		git(remote, "config", "user.name", "Other")
		git(remote, "config", "user.email", "other@example.invalid")
		git(remote, "commit", "--allow-empty", "-m", "remote")
		await run(`git pull --ff-only ${quote(remote)} main`)
		expect(commits).toEqual([])
		const operations = createCommitTrackingOperations((commit) => commits.push(commit))
		await operations.exec("echo ready; sleep 0.2", repository, {
			onData: () => git(repository, "commit", "--allow-empty", "-m", "external"),
			env: { ...process.env },
		})
		expect(commits).toEqual([])
	})

	it("preserves Git hooks and records the commit after a successful hook", async () => {
		writeFileSync(join(repository, ".git", "hooks", "pre-commit"), "#!/bin/sh\ngit rev-parse --git-dir >/dev/null\n", {
			mode: 0o700,
		})
		expect(await run("git commit --allow-empty -m hooked")).toBe(0)
		expect(commits.map((commit) => commit.sha)).toEqual([git(repository, "rev-parse", "HEAD")])
	})

	it("does not record failed commits or dry runs", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		await run("git commit -m empty; git commit --dry-run --allow-empty -m dry")
		expect(commits).toEqual([])
	})

	it("does not attribute a reset performed by a nested Git process in a commit hook", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		git(repository, "commit", "--allow-empty", "-m", "existing")
		const worktree = join(directory, "hook-worktree")
		git(repository, "worktree", "add", "-b", "hook-target", worktree)
		writeFileSync(
			join(repository, ".git", "hooks", "pre-commit"),
			`#!/bin/sh
unset GIT_INDEX_FILE
git -C ${quote(worktree)} reset --hard HEAD~ >/dev/null
`,
			{ mode: 0o700 },
		)
		expect(await run("git commit --allow-empty -m ours")).toBe(0)
		expect(commits).toEqual([
			{ sha: git(repository, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree: repository },
		])
	})

	it.each([5, 10])("records commits through the registered background Bash tool (timeout %s)", async (timeout) => {
		const ctx = createContext({ cwd: repository })
		const pi = createExtensionApi()
		vi.spyOn(attribution, "getWorkId").mockReturnValue("original-work")
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		bashBackgroundExtension(pi.api)
		await pi.getHandler("session_start")({ type: "session_start" }, ctx)
		try {
			await pi
				.getRegisteredTool("bash")
				.execute(
					"registered-commit",
					{ command: "git commit --allow-empty -m registered", timeout },
					undefined,
					undefined,
					ctx,
				)
			expect(record).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					type: "commit",
					sha: git(repository, "rev-parse", "HEAD"),
					toolCallId: "registered-commit",
				}),
				"original-work",
			)
		} finally {
			await getSessionRegistry()?.shutdown()
			setSessionRegistry(undefined)
		}
	})

	it("records a background commit after the first checkin under its original session and work", async () => {
		let sessionId = "original-session"
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: vi.fn(() => sessionId) } })
		const work = vi.spyOn(attribution, "getWorkId").mockReturnValue("original-work")
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		const registry = createProcessRegistry()
		try {
			const result = await createBackgroundBashToolDefinition(repository, { registry }).execute(
				"background-commit",
				{ command: "sleep 0.3; git commit --allow-empty -m delayed", timeout: 10, checkin_interval: 0.01 },
				undefined,
				undefined,
				ctx,
			)
			const handle = result.details?.handle
			expect(handle).toBeTruthy()
			expect(record).not.toHaveBeenCalled()
			if (!handle) throw new Error("Missing background process handle")
			sessionId = "replacement-session"
			work.mockReturnValue("replacement-work")
			await registry.whenExited(handle)
			expect(record).toHaveBeenCalledOnce()
			const [pinned, fields, workId] = record.mock.calls[0]
			expect(pinned.sessionManager.getSessionId()).toBe("original-session")
			expect(workId).toBe("original-work")
			expect(fields).toMatchObject({ sha: git(repository, "rev-parse", "HEAD"), toolCallId: "background-commit" })
		} finally {
			await registry.shutdown()
		}
	})

	it.each(["allocation", "cleanup"])("preserves Bash execution when trace %s fails", async (stage) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const failure = new Error("trace storage unavailable")
		const hook =
			stage === "allocation"
				? vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
						throw failure
					})
				: vi.spyOn(fs, "rmSync").mockImplementation(() => {
						throw failure
					})
		try {
			expect(await run("printf still-running")).toBe(0)
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("work-attribution"), failure)
		} finally {
			const tracePath = hook.mock.calls[0]?.[0]
			hook.mockRestore()
			if (stage === "cleanup" && tracePath) rmSync(tracePath, { recursive: true, force: true })
		}
	})

	it.each(["foreground", "background"])("runs %s Bash when work persistence fails", async (mode) => {
		const ctx = createContext({ cwd: repository })
		vi.spyOn(attribution, "getWorkId").mockImplementation(() => {
			throw new Error("ledger unavailable")
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const registry = createProcessRegistry()
		try {
			const tool =
				mode === "background"
					? createBackgroundBashToolDefinition(repository, { registry })
					: createCommitTrackingBashTool(ctx)
			const result = await tool.execute(
				"without-attribution",
				{ command: "printf bash-still-works" },
				undefined,
				undefined,
				ctx,
			)
			expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "bash-still-works" })]))
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining("work-attribution"),
				expect.objectContaining({ message: "ledger unavailable" }),
			)
		} finally {
			await registry.shutdown()
		}
	})

	it("pins the session and work while the tool is running", async () => {
		let sessionId = "original-session"
		let workId = "original-work"
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: vi.fn(() => sessionId) } })
		vi.spyOn(attribution, "getWorkId").mockImplementation(() => workId)
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		await createCommitTrackingBashTool(ctx).execute(
			"commit-tool",
			{
				command: "echo ready; sleep 0.3; git commit --allow-empty -m pinned",
			},
			undefined,
			() => {
				sessionId = "replacement-session"
				workId = "replacement-work"
			},
			ctx,
		)
		expect(sessionId).toBe("replacement-session")
		expect(record).toHaveBeenCalledOnce()
		const [pinned, fields, recordedWork] = record.mock.calls[0]
		expect(pinned.sessionManager.getSessionId()).toBe("original-session")
		expect(recordedWork).toBe("original-work")
		expect(fields).toMatchObject({
			type: "commit",
			toolCallId: "commit-tool",
			sha: git(repository, "rev-parse", "HEAD"),
		})
	})
})
