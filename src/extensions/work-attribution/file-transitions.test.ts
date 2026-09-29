import * as childProcess from "node:child_process"
import { execFileSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import toolRenderingExtension from "../tool-rendering.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import { createCommitTrackingBashTool } from "./commits.js"
import { createTrackedEditTool, createTrackedWriteTool, reconcileFileTransitions } from "./file-transitions.js"
import { flushWorkSummaries } from "./summary.js"

vi.mock("node:child_process", { spy: true })

let root: string
let repo: string
function git(...args: string[]) {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function context(session = "original") {
	return createContext({ cwd: repo, sessionManager: { getSessionId: () => session } })
}
function rows() {
	const dir = join(root, "agent", "work-attribution")
	return readdirSync(dir, { recursive: true })
		.filter((file) => typeof file === "string" && file.endsWith(".jsonl"))
		.flatMap((file) =>
			readFileSync(join(dir, String(file)), "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line)),
		)
}
function contributions() {
	return rows().filter((row) => row.type === "commit" && row.source === "native-file-transition")
}
async function write(path: string, content: string, ctx = context()) {
	await createTrackedWriteTool(ctx, "write-call").execute("write-call", { path, content })
}
async function edit(oldText: string, newText: string, ctx = context()) {
	await createTrackedEditTool(ctx, "edit-call").execute("edit-call", {
		path: "file.txt",
		edits: [{ oldText, newText }],
	})
}
function commit() {
	git("add", ".")
	git("commit", "-qm", "manual")
	return git("rev-parse", "HEAD")
}
function baseline() {
	writeFileSync(join(repo, "file.txt"), "one\ntwo\n")
	return commit()
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-file-work-"))
	repo = join(root, "repo")
	mkdirSync(repo)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	git("init", "-q")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.test")
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(root, { recursive: true, force: true })
})

describe("manual commit reconciliation", () => {
	it("keeps another session's contribution after a tracked Bash commit", async () => {
		baseline()
		const first = context("first")
		const second = context("second")
		const workId = getWorkId(first)
		setWorkId(second, workId)
		await write("first.txt", "first", first)
		await write("second.txt", "second", second)
		await createCommitTrackingBashTool(second).execute(
			"commit",
			{ command: "git add . && git commit -qm tracked" },
			undefined,
			undefined,
			second,
		)
		const sha = git("rev-parse", "HEAD")
		reconcileFileTransitions(context("reopened"))
		reconcileFileTransitions(context("repeated"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, workId, sessionId: "first", paths: ["first.txt"] }),
		])
		await flushWorkSummaries()
		const summary = JSON.parse(readFileSync(join(root, "agent", "work", workId, "work.json"), "utf8"))
		expect(summary.commits.map((row: { sessionId: string }) => row.sessionId).sort()).toEqual(["first", "second"])
	})

	it("retains both sessions when same-work edits compose into one committed file", async () => {
		baseline()
		const first = context("first")
		const second = context("second")
		const workId = getWorkId(first)
		setWorkId(second, workId)
		await edit("one", "first edit", first)
		await edit("two", "second edit", second)
		const sha = commit()
		reconcileFileTransitions(context("reopened"))
		reconcileFileTransitions(context("repeated"))
		const matched = contributions().sort((a, b) => a.sessionId.localeCompare(b.sessionId))
		expect(matched).toEqual([
			expect.objectContaining({ sha, workId, sessionId: "first", paths: ["file.txt"] }),
			expect.objectContaining({ sha, workId, sessionId: "second", paths: ["file.txt"] }),
		])
		for (const match of matched) {
			const expected = rows()
				.filter((row) => row.type === "file_transition" && row.sessionId === match.sessionId)
				.map((row) => row.transitionId)
			expect(match.transitionIds).toEqual(expected)
		}
		await flushWorkSummaries()
		const summary = JSON.parse(readFileSync(join(root, "agent", "work", workId, "work.json"), "utf8"))
		expect(summary.commits.map((row: { sessionId: string }) => row.sessionId).sort()).toEqual(["first", "second"])
	})

	it("rechecks completed commits when additional transition evidence becomes available", async () => {
		baseline()
		await write("first.txt", "first")
		await write("second.txt", "second")
		const dir = join(root, "agent", "work-attribution", "transitions")
		const journal = join(dir, readdirSync(dir)[0])
		const evidence = readFileSync(journal, "utf8")
		writeFileSync(journal, `${evidence.split("\n")[0]}\n`)
		const sha = commit()
		reconcileFileTransitions(context("first-launch"))
		expect(contributions()).toEqual([expect.objectContaining({ sha, paths: ["first.txt"] })])

		writeFileSync(journal, evidence)
		reconcileFileTransitions(context("next-launch"))
		reconcileFileTransitions(context("repeat-launch"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, paths: ["first.txt"] }),
			expect.objectContaining({ sha, paths: ["second.txt"] }),
		])
	})

	it("backfills a missing session from a completed older checkpoint", async () => {
		baseline()
		const first = context("first")
		const second = context("second")
		const workId = getWorkId(first)
		setWorkId(second, workId)
		await edit("one", "first edit", first)
		await edit("two", "second edit", second)
		const sha = commit()
		reconcileFileTransitions(context("initial"))
		const directory = join(root, "agent", "work-attribution")
		for (const file of readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
			const path = join(directory, file)
			const retained = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((row) => row.type !== "commit" || row.sessionId !== "second")
			writeFileSync(path, `${retained.map((row) => JSON.stringify(row)).join("\n")}\n`)
		}
		const transitionDirectory = join(directory, "transitions")
		const progressFile = readdirSync(transitionDirectory).find((name) => name.endsWith(".progress"))
		if (!progressFile) throw new Error("Expected a completed reconciliation checkpoint")
		const progressPath = join(transitionDirectory, progressFile)
		const progress = JSON.parse(readFileSync(progressPath, "utf8"))
		progress.evidence = progress.evidence.replace(/^sessions-v1:/, "")
		writeFileSync(progressPath, JSON.stringify(progress))
		reconcileFileTransitions(context("upgrade"))
		reconcileFileTransitions(context("repeat"))
		expect(
			contributions()
				.filter((row) => row.sha === sha)
				.map((row) => row.sessionId)
				.sort(),
		).toEqual(["first", "second"])
	})

	it.each([false, true])("advances through a bounded backlog across launches (mixed newest: %s)", async (mixed) => {
		baseline()
		const expected: string[] = []
		for (let i = 0; i < 4; i++) {
			await write(`new-${i}.txt`, `agent ${i}`)
			if (mixed && i === 3) writeFileSync(join(repo, `new-${i}.txt`), "human changed it")
			const sha = commit()
			if (!mixed || i !== 3) expected.push(sha)
		}
		let clock = 0
		vi.spyOn(Date, "now").mockImplementation(() => clock)
		const { execFileSync: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFileSync").mockImplementation((...args) => {
			clock += 250
			return execute(...args)
		})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		reconcileFileTransitions(context("first-launch"))
		expect(contributions().length).toBeLessThan(expected.length)
		for (let i = 0; i < 5; i++) reconcileFileTransitions(context(`launch-${i}`))
		expect(
			contributions()
				.map((row) => row.sha)
				.sort(),
			warn.mock.calls.map((call) => String(call[1])).join("\n"),
		).toEqual(expected.sort())
	})

	it("retries the whole commit when reading a parent file exhausts the budget", async () => {
		baseline()
		await write("first.txt", "first")
		await write("second.txt", "second")
		const sha = commit()
		let clock = 0
		vi.spyOn(Date, "now").mockImplementation(() => clock)
		const { execFileSync: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFileSync").mockImplementation((...args) => {
			const result = execute(...args)
			const command = args[1]
			if (Array.isArray(command) && command.includes("ls-tree") && command.includes("second.txt")) clock += 4000
			return result
		})
		vi.spyOn(console, "warn").mockImplementation(() => {})
		reconcileFileTransitions(context("interrupted"))
		expect(contributions()).toEqual([])

		vi.restoreAllMocks()
		reconcileFileTransitions(context("retry"))
		reconcileFileTransitions(context("repeat"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, sessionId: "original", paths: ["first.txt", "second.txt"] }),
		])
	})

	it.each([
		"child",
		"rendered",
	])("captures the winning %s native tool and reconciles on session_start", async (kind) => {
		baseline()
		const api = createExtensionApi()
		if (kind === "rendered") toolRenderingExtension(api.api)
		else {
			createWorkAttributionExtension()(api.api)
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, context())
		}
		await api
			.getRegisteredTool("write")
			.execute("native-write", { path: join(repo, "new.txt"), content: "new" }, undefined, undefined, context())
		await api
			.getRegisteredTool("edit")
			.execute(
				"native-edit",
				{ path: join(repo, "file.txt"), edits: [{ oldText: "one", newText: "first" }] },
				undefined,
				undefined,
				context(),
			)
		const sha = commit()
		const fresh = createExtensionApi()
		createWorkAttributionExtension()(fresh.api)
		await fresh.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "startup" },
			context("fresh"),
		)
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, paths: ["file.txt", "new.txt"], sessionId: "original" }),
		])
	})

	it("joins composed native edits after shutdown to the original work/session and deduplicates launches", async () => {
		baseline()
		const workId = getWorkId(context())
		await edit("one", "first")
		await edit("two", "second")
		const sha = commit()
		reconcileFileTransitions(context("fresh"))
		reconcileFileTransitions(context("another"))
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				sessionId: "original",
				paths: ["file.txt"],
				source: "native-file-transition",
			}),
		])
		expect(contributions()[0].transitionIds).toHaveLength(2)
		expect(rows().filter((row) => row.type === "file_transition")).toHaveLength(2)
		expect(JSON.stringify(rows())).not.toContain("first\\nsecond")
	})
	it("tracks a new file in a root commit and retains evidence for amend", async () => {
		await write("new.txt", "new\n")
		const first = commit()
		reconcileFileTransitions(context("fresh"))
		git("commit", "--amend", "-qm", "amended")
		const amended = git("rev-parse", "HEAD")
		reconcileFileTransitions(context("next"))
		expect(contributions().map((row) => row.sha)).toEqual([first, amended])
	})
	it("uses the actual linked worktree and repository identity", async () => {
		baseline()
		const primary = repo
		repo = join(root, "linked")
		execFileSync("git", ["-C", primary, "worktree", "add", "-qb", "linked", repo])
		await edit("one", "first")
		const sha = commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({
			sha,
			worktree: realpathSync(repo),
			repository: realpathSync(join(primary, ".git")),
		})
	})
	it.each(["dirty", "partial", "human", "overlap", "unrelated"])("leaves %s evidence unresolved", async (kind) => {
		baseline()
		if (kind === "dirty") writeFileSync(join(repo, "file.txt"), "dirty\ntwo\n")
		await edit(kind === "dirty" ? "dirty" : "one", "first")
		await edit("two", "second")
		if (kind === "overlap") {
			setWorkId(context())
			await edit("second", "third")
		}
		if (kind === "human") writeFileSync(join(repo, "file.txt"), "first\nhuman\n")
		if (kind === "partial") {
			writeFileSync(join(repo, "file.txt"), "first\ntwo\n")
			git("add", "file.txt")
			writeFileSync(join(repo, "file.txt"), "first\nsecond\n")
			git("commit", "-qm", "partial")
		}
		if (kind === "unrelated") {
			writeFileSync(join(repo, "other.txt"), "other")
			git("add", "other.txt")
			git("commit", "-qm", "unrelated")
		} else if (kind !== "partial") commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})
	it("matches only contributed files in a mixed commit", async () => {
		baseline()
		await edit("one", "first")
		writeFileSync(join(repo, "other.txt"), "human")
		commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()[0].paths).toEqual(["file.txt"])
	})
	it("does not match identical history from before the native edit", async () => {
		const base = baseline()
		writeFileSync(join(repo, "file.txt"), "first\ntwo\n")
		commit()
		git("reset", "--hard", base)
		await edit("one", "first")
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})
	it("matches a commit before a later edit without retroactively claiming the later change", async () => {
		baseline()
		await edit("one", "first")
		const first = commit()
		await edit("two", "second")
		const second = commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions().map((row) => row.sha)).toEqual([second, first])
		expect(contributions().every((row) => row.transitionIds.length === 1)).toBe(true)
	})
	it("rejects a changed reflog prefix even when the new suffix has an exact commit", async () => {
		baseline()
		await edit("one", "first")
		git("reflog", "expire", "--expire=all", "--all")
		commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})
	it("normalizes ordinary Git text attributes and preserves effective index mode", async () => {
		writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=lf\n")
		baseline()
		git("config", "core.filemode", "false")
		chmodSync(join(repo, "file.txt"), 0o755)
		await write("file.txt", "first\r\ntwo\r\n")
		const sha = commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, paths: ["file.txt"] })
	})
	it("captures concurrent queued writes with pinned work/session and no raw-hook race", async () => {
		baseline()
		const ctx = context()
		const workId = getWorkId(ctx)
		const first = createTrackedWriteTool(ctx, "first")
		const second = createTrackedWriteTool(ctx, "second")
		setWorkId(ctx)
		await Promise.all([
			first.execute("first", { path: "file.txt", content: "first\ntwo\n" }),
			second.execute("second", { path: "file.txt", content: "first\nsecond\n" }),
		])
		const sha = commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, workId, sessionId: "original" })
		expect(contributions()[0].transitionIds).toHaveLength(2)
	})
	it("does not attribute a matching transition from a different branch's later baseline", async () => {
		const base = baseline()
		writeFileSync(join(repo, "branch-only.txt"), "branch")
		commit()
		await edit("one", "first")
		git("reset", "--hard", base)
		writeFileSync(join(repo, "file.txt"), "first\ntwo\n")
		commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it("preserves a successful mutation when the ledger fails after identity was pinned", async () => {
		baseline()
		const tool = createTrackedWriteTool(context(), "pinned")
		rmSync(join(root, "agent", "work-attribution"), { recursive: true })
		writeFileSync(join(root, "agent", "work-attribution"), "blocked")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		await tool.execute("pinned", { path: "file.txt", content: "changed" })
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("changed")
		expect(warn).toHaveBeenCalled()
	})
	it("preserves failed native edits and does not capture unchanged writes", async () => {
		baseline()
		await expect(edit("missing", "replacement")).rejects.toThrow()
		await write("file.txt", "one\ntwo\n")
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
	})
	it("skips external clean filters without executing them", async () => {
		baseline()
		writeFileSync(join(repo, ".gitattributes"), "*.txt filter=unsupported\n")
		git("config", "filter.unsupported.clean", "false")
		git("config", "filter.unsupported.required", "true")
		await edit("one", "first")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
	})

	it("leaves overlapping work unresolved across baselines after git restore", async () => {
		baseline()
		await edit("one", "first")
		git("restore", "file.txt")
		writeFileSync(join(repo, "other.txt"), "unrelated")
		commit()
		setWorkId(context())
		await edit("one", "first")
		commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it.each(["many sessions", "large request history"])("ignores unrelated %s during reconciliation", async (kind) => {
		baseline()
		await edit("one", "first")
		const sha = commit()
		const dir = join(root, "agent", "work-attribution")
		if (kind === "many sessions") {
			for (let i = 0; i < 513; i++) writeFileSync(join(dir, `unrelated-${i}.jsonl`), "")
		} else writeFileSync(join(dir, "unrelated.jsonl"), " ".repeat(8 * 1024 * 1024 + 1))
		vi.spyOn(console, "warn").mockImplementation(() => {})
		reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, paths: ["file.txt"] })
	})

	it("reconciles fresh work after more than 512 unrelated reflog entries", async () => {
		baseline()
		await write("old.txt", "old")
		for (let i = 0; i < 513; i++) git("reset", "--soft", "HEAD")
		const workId = setWorkId(context())
		await edit("one", "first")
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([expect.objectContaining({ sha, workId, paths: ["file.txt"] })])
	}, 15000)

	it.each(["amend", "unrelated commit"])("composes same-work edits across an intervening %s", async (kind) => {
		baseline()
		await edit("one", "first")
		if (kind === "amend") commit()
		else {
			writeFileSync(join(repo, "other.txt"), "other")
			git("add", "other.txt")
			git("commit", "-qm", "unrelated")
		}
		await edit("two", "second")
		git("add", "file.txt")
		if (kind === "amend") git("commit", "--amend", "-qm", "amended")
		else git("commit", "-qm", "manual")
		const sha = git("rev-parse", "HEAD")
		reconcileFileTransitions(context("fresh"))
		const matched = contributions().find((row) => row.sha === sha)
		expect(matched).toMatchObject({ sha, paths: ["file.txt"] })
		expect(matched.transitionIds).toHaveLength(2)
	})
	it("does not execute a filter enabled by the native write itself", async () => {
		baseline()
		git("config", "filter.unexpected.clean", "touch filter-ran; cat")
		await write(".gitattributes", "* filter=unexpected\n")
		expect(readFileSync(join(repo, ".gitattributes"), "utf8")).toBe("* filter=unexpected\n")
		expect(existsSync(join(repo, "filter-ran"))).toBe(false)
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
	})

	it("leaves an amended file shared by two work IDs unresolved", async () => {
		baseline()
		await edit("one", "first")
		commit()
		setWorkId(context())
		await edit("two", "second")
		git("add", "file.txt")
		git("commit", "--amend", "-qm", "mixed")
		const sha = git("rev-parse", "HEAD")
		reconcileFileTransitions(context("fresh"))
		expect(contributions().some((row) => row.sha === sha)).toBe(false)
	})
	it("does not claim a file whose native edits cancel each other", async () => {
		baseline()
		await edit("one", "first")
		await edit("first", "one")
		writeFileSync(join(repo, "other.txt"), "human")
		commit()
		reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it("keeps native write and edit working when attribution storage fails", async () => {
		baseline()
		writeFileSync(join(root, "blocked"), "file")
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "blocked"))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		await edit("one", "first")
		await write("new.txt", "new")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new")
		expect(warn).toHaveBeenCalled()
	})
})
