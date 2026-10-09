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
	symlinkSync,
	writeFileSync,
} from "node:fs"
import * as asyncFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
	BeforeProviderHeadersEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import toolRenderingExtension from "../tool-rendering.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import { createCommitTrackingBashTool } from "./commits.js"
import * as diagnostics from "./diagnostics.js"
import {
	createTrackedEditTool,
	createTrackedWriteTool,
	knownTransitionRepositories,
	reconcileFileTransitions,
	reconcileRepositoryTransitions,
} from "./file-transitions.js"
import { flushWorkSummaries } from "./summary.js"

vi.mock("node:child_process", { spy: true })
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof asyncFs>()) }))

let root: string
let repo: string
const shutdowns: (() => unknown)[] = []
async function startSession(api: ReturnType<typeof createExtensionApi>, ctx = context()) {
	shutdowns.push(() =>
		api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx),
	)
	await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
}
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
	for (const shutdown of shutdowns.splice(0)) await shutdown()
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(root, { recursive: true, force: true })
})

describe("manual commit reconciliation", () => {
	it("rechecks a stale content checkpoint without duplicating contributions", async () => {
		baseline()
		await edit("one", "first")
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		const repository = realpathSync(join(repo, ".git"))
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toHaveLength(1)
		const ledger = join(root, "agent", "work-attribution", "original.jsonl")
		const retained = readFileSync(ledger, "utf8")
			.split("\n")
			.filter((line) => line && JSON.parse(line).type !== "commit")
		writeFileSync(ledger, `${retained.join("\n")}\n`)
		const directory = join(root, "agent", "work-attribution", "transitions")
		const checkpoint = readdirSync(directory).find((name) => name.endsWith(".content-checkpoint"))
		if (!checkpoint) throw new Error("Expected a content checkpoint")
		const path = join(directory, checkpoint)
		const progress = JSON.parse(readFileSync(path, "utf8"))
		progress.evidence = `content:${progress.evidence}`
		writeFileSync(path, JSON.stringify(progress))
		await reconcileRepositoryTransitions(repository)
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
	})

	it.each([
		"ls-tree",
		"merge-base",
	])("retries a timed-out %s comparison in an external linked worktree without checkpointing it", async (command) => {
		baseline()
		const primary = repo
		repo = join(root, "external-worktree")
		execFileSync("git", ["-C", primary, "worktree", "add", "-qb", "external", repo])
		await edit("one", "first")
		const workId = getWorkId(context())
		// Stash interrupts the exact file chain, exercising comparisons in the shared .git directory.
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		const repository = realpathSync(join(primary, ".git"))
		const worktree = realpathSync(repo)
		expect(await knownTransitionRepositories()).toEqual([repository])
		expect(rows().find((row) => row.type === "file_transition")).toMatchObject({ repository, worktree, workId })

		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
		const bin = join(root, "bin")
		mkdirSync(bin)
		const marker = join(root, "timed-out-command")
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\nif [ "$2" = '${repository}' ] && [ "$3" = "${command}" ] && [ ! -f '${marker}' ]; then\n  printf '%s\\n' "$@" > '${marker}'\n  exec sleep 10\nfi\nexec '${realGit}' "$@"\n`,
			{ mode: 0o755 },
		)
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)
		await expect(reconcileRepositoryTransitions(repository)).rejects.toMatchObject({
			killed: true,
			signal: "SIGTERM",
		})
		expect(readFileSync(marker, "utf8").split("\n").slice(0, 3)).toEqual(["-C", repository, command])
		expect(contributions()).toEqual([])
		const journals = join(root, "agent", "work-attribution", "transitions")
		expect(readdirSync(journals).filter((path) => path.endsWith(".content-checkpoint"))).toEqual([])

		await reconcileRepositoryTransitions(repository)
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				repository,
				worktree,
				fileMatches: [expect.objectContaining({ path: "file.txt", method: "path-blob", worktree })],
			}),
		])
	}, 10000)

	it("retains discovery progress when reading journal headers exhausts a pass", async () => {
		for (let index = 0; index < 5; index++) {
			repo = join(root, `repository-${index}`)
			mkdirSync(repo)
			git("init", "-q")
			await write("file.txt", "new")
		}
		await flushWorkSummaries()
		let clock = 0
		let deadline = 3000
		const original = asyncFs.open
		const headers = vi.spyOn(asyncFs, "open").mockImplementation((...args) => {
			if (String(args[0]).endsWith(".jsonl") && args[1] === "r") clock += 1100
			return original(...args)
		})
		const checkBudget = () => {
			if (clock > deadline) throw new Error("budget")
		}
		await expect(knownTransitionRepositories(checkBudget)).rejects.toThrow("budget")
		deadline = clock + 3000
		expect(await knownTransitionRepositories(checkBudget)).toHaveLength(5)
		expect(headers).toHaveBeenCalledTimes(5)
	})

	it("discovers another known repository even when a large journal cannot be read", async () => {
		baseline()
		await edit("one", "first")
		const directory = join(root, "agent", "work-attribution", "transitions")
		const large = join(directory, readdirSync(directory)[0])
		writeFileSync(large, `${readFileSync(large, "utf8")}${" ".repeat(8 * 1024 * 1024)}`)
		repo = join(root, "other")
		mkdirSync(repo)
		git("init", "-q")
		git("config", "user.name", "Test")
		git("config", "user.email", "test@example.test")
		await write("other.txt", "other")
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await startSession(api, context("survivor"))
		await vi.waitFor(() => expect(contributions()).toEqual([expect.objectContaining({ sha, paths: ["other.txt"] })]))
	})

	it("checks its lease before publishing a discovered contribution and retries it later", async () => {
		baseline()
		await edit("one", "first")
		const sha = commit()
		const repository = realpathSync(join(repo, ".git"))
		await expect(
			reconcileRepositoryTransitions(
				repository,
				undefined,
				() => {},
				() => {
					throw new Error("lost lease")
				},
			),
		).rejects.toThrow("lost lease")
		expect(contributions()).toEqual([])
		await reconcileFileTransitions(context("retry"))
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
	})

	it("advances through a rewrite backlog across bounded scans", async () => {
		baseline()
		const branch = git("branch", "--show-current")
		git("checkout", "-qb", "upstream")
		writeFileSync(join(repo, "upstream.txt"), "upstream")
		const upstream = commit()
		git("checkout", "-q", branch)
		for (let index = 0; index < 4; index++) {
			await write(`native-${index}.txt`, `native-${index}`)
			commit()
		}
		git("rebase", "upstream")
		const rewritten = git("rev-list", `${upstream}..HEAD`).split("\n")
		let clock = 0
		vi.spyOn(Date, "now").mockImplementation(() => clock)
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			clock += 250
			return execute(...args)
		}) as typeof execute)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("first"))
		expect(contributions().filter((row) => rewritten.includes(row.sha))).toHaveLength(0)
		for (let index = 0; index < 16; index++) await reconcileFileTransitions(context(`retry-${index}`))
		expect(
			contributions()
				.filter((row) => rewritten.includes(row.sha))
				.map((row) => row.sha)
				.sort(),
		).toEqual(rewritten.sort())
	}, 15000)

	it("reuses a compact history boundary with many refs and ignores refs to non-commits", async () => {
		const base = baseline()
		const tree = git("rev-parse", "HEAD^{tree}")
		const refs = Array.from(
			{ length: 130 },
			(_, index) =>
				`update refs/attribution/history-${index} ${git("commit-tree", tree, "-p", base, "-m", `history-${index}`)}`,
		)
		refs.push(`update refs/attribution/tree ${tree}`)
		execFileSync("git", ["-C", repo, "update-ref", "--stdin"], { input: `${refs.join("\n")}\n` })
		await edit("one", "first")
		await write("second.txt", "second")
		await write("third.txt", "third")
		const mutations = rows().filter((row) => row.type === "file_transition")
		expect(new Set(mutations.map((row) => row.historyBoundaryId)).size).toBe(1)
		expect(mutations[0].historyBoundaryId).toMatch(/^[a-f0-9]{64}$/)
		expect(mutations.every((row) => row.refTips === undefined)).toBe(true)
		const snapshots = join(root, "agent", "work-attribution", "ref-tips")
		expect(readdirSync(snapshots)).toEqual([`${mutations[0].historyBoundaryId}.json`])
		const snapshot = JSON.parse(readFileSync(join(snapshots, readdirSync(snapshots)[0]), "utf8"))
		expect(snapshot.refTips).toHaveLength(131)
		expect(snapshot.refTips).not.toContain(tree)
		expect(JSON.stringify(mutations).length).toBeLessThan(5000)
		git("stash", "push", "-qu")
		git("stash", "pop", "-q")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([expect.objectContaining({ sha, paths: ["file.txt", "second.txt", "third.txt"] })])
	})

	it.each(["missing", "truncated"])("retries weak matching after a %s history snapshot is repaired", async (damage) => {
		baseline()
		await edit("one", "first")
		const mutation = rows().find((row) => row.type === "file_transition")
		const path = join(root, "agent", "work-attribution", "ref-tips", `${mutation.historyBoundaryId}.json`)
		const saved = readFileSync(path)
		if (damage === "missing") rmSync(path)
		else writeFileSync(path, '{"version":1,"refTips":[')
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("damaged"))
		expect(contributions()).toEqual([])
		writeFileSync(path, saved)
		await reconcileFileTransitions(context("repaired"))
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
	})

	it("publishes one complete snapshot before concurrent transitions and repairs a damaged copy", async () => {
		baseline()
		const rename = asyncFs.rename
		let unblock!: () => void
		const gate = new Promise<void>((resolve) => {
			unblock = resolve
		})
		let waiting = 0
		vi.spyOn(asyncFs, "rename").mockImplementation(async (from, to) => {
			if (String(to).includes("/ref-tips/")) {
				waiting++
				await gate
			}
			return rename(from, to)
		})
		const writes = Promise.all([write("first.txt", "first"), write("second.txt", "second")])
		try {
			await vi.waitFor(() => expect(waiting).toBeGreaterThan(0))
			expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
		} finally {
			unblock()
			await writes
		}
		const mutations = rows().filter((row) => row.type === "file_transition")
		const directory = join(root, "agent", "work-attribution", "ref-tips")
		const file = `${mutations[0].historyBoundaryId}.json`
		expect(readdirSync(directory)).toEqual([file])
		expect(mutations[1].historyBoundaryId).toBe(mutations[0].historyBoundaryId)
		writeFileSync(join(directory, file), "partial")
		await write("third.txt", "third")
		expect(JSON.parse(readFileSync(join(directory, file), "utf8")).refTips).toEqual([git("rev-parse", "HEAD")])
		expect(readdirSync(directory)).toEqual([file])
	})

	it("preserves exact matching when its optional history snapshot is missing", async () => {
		baseline()
		await edit("one", "first")
		const mutation = rows().find((row) => row.type === "file_transition")
		rmSync(join(root, "agent", "work-attribution", "ref-tips", `${mutation.historyBoundaryId}.json`))
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "file-chain" })] }),
		])
	})

	it.each([
		"inline",
		"legacy",
	])("reads %s transition boundaries without changing their source format", async (format) => {
		baseline()
		await edit("one", "first")
		const directory = join(root, "agent", "work-attribution", "transitions")
		const journal = join(directory, readdirSync(directory)[0])
		const mutation = JSON.parse(readFileSync(journal, "utf8"))
		if (format === "inline") mutation.refTips = [git("rev-parse", "HEAD")]
		mutation.historyBoundaryId = undefined
		const saved = `${JSON.stringify(mutation)}\n`
		writeFileSync(journal, saved)
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
		expect(readFileSync(journal, "utf8")).toBe(saved)
	})

	it("finds a rewritten native contribution and labels its path/blob evidence", async () => {
		baseline()
		const originalBranch = git("branch", "--show-current")
		git("checkout", "-qb", "upstream")
		writeFileSync(join(repo, "upstream.txt"), "upstream")
		commit()
		git("checkout", "-q", originalBranch)
		await edit("one", "first")
		const original = commit()
		git("rebase", "upstream")
		const rewritten = git("rev-parse", "HEAD")
		expect(rewritten).not.toBe(original)
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toContainEqual(
			expect.objectContaining({
				sha: rewritten,
				fileMatches: [expect.objectContaining({ path: "file.txt", method: "path-blob" })],
			}),
		)
	})

	it.each([
		false,
		true,
	])("recovers a squash after the original worktree is deleted (path reused: %s)", async (reused) => {
		baseline()
		const primary = repo
		const linked = join(root, "deleted-worktree")
		git("worktree", "add", "-qb", "feature", linked)
		const canonicalLinked = realpathSync(linked)
		repo = linked
		await edit("one", "first")
		const workId = getWorkId(context())
		commit()
		repo = primary
		git("merge", "--squash", "feature")
		const squashed = commit()
		git("worktree", "remove", linked)
		if (reused) mkdirSync(linked)
		await reconcileFileTransitions(context("another-checkout"))
		expect(contributions()).toContainEqual(
			expect.objectContaining({
				sha: squashed,
				workId,
				worktree: canonicalLinked,
				fileMatches: [expect.objectContaining({ path: "file.txt", method: "path-blob", worktree: canonicalLinked })],
			}),
		)
	})

	it("recovers native content after stash and keeps its match separate from exact chains", async () => {
		baseline()
		await edit("one", "first")
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				fileMatches: [expect.objectContaining({ path: "file.txt", method: "path-blob" })],
			}),
		])
	})

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
		await reconcileFileTransitions(context("reopened"))
		await reconcileFileTransitions(context("repeated"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, workId, sessionId: "first", paths: ["first.txt"] }),
			expect.objectContaining({
				sha,
				workId,
				sessionId: "second",
				paths: ["second.txt"],
				fileMatches: [expect.objectContaining({ method: "file-chain" })],
			}),
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
		await reconcileFileTransitions(context("reopened"))
		await reconcileFileTransitions(context("repeated"))
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
		await reconcileFileTransitions(context("first-launch"))
		expect(contributions()).toEqual([expect.objectContaining({ sha, paths: ["first.txt"] })])

		writeFileSync(journal, evidence)
		await reconcileFileTransitions(context("next-launch"))
		await reconcileFileTransitions(context("repeat-launch"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, paths: ["first.txt"] }),
			expect.objectContaining({ sha, paths: ["second.txt"] }),
		])
	})

	it.each([
		"matches-v2",
		"sessions-v1:matches-v2",
	])("backfills a missing session from a completed %s checkpoint", async (prefix) => {
		baseline()
		const first = context("first")
		const second = context("second")
		const workId = getWorkId(first)
		setWorkId(second, workId)
		await edit("one", "first edit", first)
		await edit("two", "second edit", second)
		const sha = commit()
		await reconcileFileTransitions(context("initial"))
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
		progress.evidence = `${prefix}:${progress.evidence.replace(/^(?:sessions-v1:)?matches-v2:/, "")}`
		writeFileSync(progressPath, JSON.stringify(progress))
		await reconcileFileTransitions(context("upgrade"))
		await reconcileFileTransitions(context("repeat"))
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
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			clock += 250
			return execute(...args)
		}) as typeof execute)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("first-launch"))
		expect(contributions().length).toBeLessThan(expected.length)
		for (let i = 0; i < 5; i++) await reconcileFileTransitions(context(`launch-${i}`))
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
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			const command = args[1]
			if (Array.isArray(command) && command.includes("ls-tree") && command.includes("second.txt")) clock += 4000
			return execute(...args)
		}) as typeof execute)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("interrupted"))
		expect(contributions()).toEqual([])

		vi.restoreAllMocks()
		await reconcileFileTransitions(context("retry"))
		await reconcileFileTransitions(context("repeat"))
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
			await startSession(api)
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
		await startSession(fresh, context("fresh"))
		await vi.waitFor(() =>
			expect(contributions()).toEqual([
				expect.objectContaining({ sha, paths: ["file.txt", "new.txt"], sessionId: "original" }),
			]),
		)
	})

	it("records native edit evidence without blocking on synchronous Git calls", async () => {
		baseline()
		const syncGit = vi.spyOn(childProcess, "execFileSync")
		await edit("one", "first")
		expect(syncGit).not.toHaveBeenCalled()
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([
			expect.objectContaining({ path: "file.txt", toolCallId: "edit-call" }),
		])
	})

	it("reconciles off the session_start path and leaves child sessions to their parent", async () => {
		baseline()
		const workId = getWorkId(context())
		await write("new.txt", "new")
		const sha = commit()
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		let open!: () => void
		const gate = new Promise<void>((resolve) => {
			open = resolve
		})
		const gitCalls: string[][] = []
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			if (Array.isArray(args[1])) gitCalls.push(args[1].map(String))
			const callback = args.at(-1)
			if (typeof callback === "function")
				args[args.length - 1] = (...result: unknown[]) =>
					void gate.then(() => (callback as (...values: unknown[]) => void)(...result))
			return execute(...args)
		}) as typeof execute)
		const syncGit = vi.spyOn(childProcess, "execFileSync")
		const child = createExtensionApi()
		createWorkAttributionExtension(workId)(child.api)
		try {
			await startSession(child, context("child"))
			expect(gitCalls).toEqual([])
			expect(syncGit).not.toHaveBeenCalled()

			const parent = createExtensionApi()
			createWorkAttributionExtension()(parent.api)
			await startSession(parent, context("fresh"))
			expect(syncGit).not.toHaveBeenCalled()
			expect(contributions()).toEqual([])
		} finally {
			open()
		}
		await vi.waitFor(() =>
			expect(contributions()).toEqual([expect.objectContaining({ sha, workId, paths: ["new.txt"] })]),
		)
	})

	it("joins composed native edits after shutdown to the original work/session and deduplicates launches", async () => {
		baseline()
		const workId = getWorkId(context())
		await edit("one", "first")
		await edit("two", "second")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		await reconcileFileTransitions(context("another"))
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
		await reconcileFileTransitions(context("fresh"))
		git("commit", "--amend", "-qm", "amended")
		const amended = git("rev-parse", "HEAD")
		await reconcileFileTransitions(context("next"))
		expect(contributions().map((row) => row.sha)).toEqual([first, amended])
	})
	it("uses the actual linked worktree and repository identity", async () => {
		baseline()
		const primary = repo
		repo = join(root, "linked")
		execFileSync("git", ["-C", primary, "worktree", "add", "-qb", "linked", repo])
		await edit("one", "first")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
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
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})
	it("matches only contributed files in a mixed commit", async () => {
		baseline()
		await edit("one", "first")
		writeFileSync(join(repo, "other.txt"), "human")
		commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()[0].paths).toEqual(["file.txt"])
	})
	it("does not match identical history from before the native edit", async () => {
		const base = baseline()
		writeFileSync(join(repo, "file.txt"), "first\ntwo\n")
		commit()
		git("reset", "--hard", base)
		await edit("one", "first")
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})
	it("matches a commit before a later edit without retroactively claiming the later change", async () => {
		baseline()
		await edit("one", "first")
		const first = commit()
		await edit("two", "second")
		const second = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions().map((row) => row.sha)).toEqual([second, first])
		expect(contributions().every((row) => row.transitionIds.length === 1)).toBe(true)
	})
	it.each([
		"legacy",
		"snapshot",
	])("uses only independent birth evidence after a changed reflog prefix (%s)", async (format) => {
		baseline()
		await edit("one", "first")
		if (format === "legacy") {
			const directory = join(root, "agent", "work-attribution", "transitions")
			const path = join(directory, readdirSync(directory)[0])
			const row = JSON.parse(readFileSync(path, "utf8"))
			row.historyBoundaryId = undefined
			writeFileSync(path, `${JSON.stringify(row)}\n`)
		}
		git("reflog", "expire", "--expire=all", "--all")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		if (format === "snapshot")
			expect(contributions()).toEqual([
				expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "path-blob" })] }),
			])
		else expect(contributions()).toEqual([])
	})
	it("normalizes ordinary Git text attributes and preserves effective index mode", async () => {
		writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=lf\n")
		baseline()
		git("config", "core.filemode", "false")
		chmodSync(join(repo, "file.txt"), 0o755)
		await write("file.txt", "first\r\ntwo\r\n")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, paths: ["file.txt"] })
	})
	it("captures concurrent queued writes with pinned work/session and no raw-hook race", async () => {
		baseline()
		const ctx = context()
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "first", name: "write" },
						{ type: "toolCall", id: "second", name: "write" },
					],
				},
			},
			ctx,
		)
		const workId = getWorkId(ctx)
		const first = createTrackedWriteTool(ctx, "first")
		const second = createTrackedWriteTool(ctx, "second")
		setWorkId(ctx)
		await Promise.all([
			first.execute("first", { path: "file.txt", content: "first\ntwo\n" }),
			second.execute("second", { path: "file.txt", content: "first\nsecond\n" }),
		])
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, workId, sessionId: "original" })
		expect(contributions()[0].transitionIds).toHaveLength(2)
		expect(
			rows()
				.filter((row) => row.type === "file_transition")
				.map((row) => row.requestId),
		).toEqual([event.headers["X-Request-Id"], event.headers["X-Request-Id"]])
	})
	it("does not attribute a matching transition from a different branch's later baseline", async () => {
		const base = baseline()
		writeFileSync(join(repo, "branch-only.txt"), "branch")
		commit()
		await edit("one", "first")
		git("reset", "--hard", base)
		writeFileSync(join(repo, "file.txt"), "first\ntwo\n")
		commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it("preserves a successful mutation when the ledger fails after identity was pinned", async () => {
		baseline()
		const tool = createTrackedWriteTool(context(), "pinned")
		rmSync(join(root, "agent", "work-attribution"), { recursive: true })
		writeFileSync(join(root, "agent", "work-attribution"), "blocked")
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
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
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it.each([
		false,
		true,
	])("keeps expired competing ownership without blocking unrelated files (legacy: %s)", async (legacy) => {
		baseline()
		const primary = repo
		const first = join(root, "first-worktree")
		const second = join(root, "second-worktree")
		git("worktree", "add", "-qb", "first", first)
		git("worktree", "add", "-qb", "second", second)
		repo = first
		await edit("one", "same", context("first"))
		repo = second
		await edit("one", "same", context("second"))
		if (legacy) {
			const directory = join(root, "agent", "work-attribution", "transitions")
			for (const file of readdirSync(directory)) {
				const path = join(directory, file)
				const row = JSON.parse(readFileSync(path, "utf8"))
				if (row.worktree !== realpathSync(second)) continue
				row.historyBoundaryId = undefined
				writeFileSync(path, `${JSON.stringify(row)}\n`)
			}
		}
		repo = primary
		writeFileSync(join(repo, "file.txt"), "same\ntwo\n")
		const ambiguous = commit()
		await reconcileFileTransitions(context("before-expiry"))
		expect(contributions()).toEqual([])
		execFileSync("git", ["-C", second, "reflog", "expire", "--expire=all", "HEAD"])
		await reconcileFileTransitions(context("after-expiry"))
		expect(contributions()).toEqual([])
		repo = first
		await write("healthy.txt", "healthy", context("first"))
		repo = primary
		writeFileSync(join(repo, "healthy.txt"), "healthy")
		const healthy = commit()
		await reconcileFileTransitions(context("healthy"))
		expect(contributions().some((row) => row.sha === ambiguous)).toBe(false)
		expect(contributions()).toEqual([
			expect.objectContaining({ sha: healthy, paths: ["healthy.txt"], sessionId: "first" }),
		])
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
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()[0]).toMatchObject({ sha, paths: ["file.txt"] })
	})

	it("reconciles fresh work after more than 512 unrelated reflog entries", async () => {
		baseline()
		await write("old.txt", "old")
		const oldWorkId = getWorkId(context())
		for (let i = 0; i < 513; i++) git("reset", "--soft", "HEAD")
		const workId = setWorkId(context())
		await edit("one", "first")
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				paths: ["file.txt"],
				fileMatches: [expect.objectContaining({ method: "file-chain" })],
			}),
			// Soft resets preserved this file; the new history fallback recovers it with weaker evidence.
			expect.objectContaining({
				sha,
				workId: oldWorkId,
				paths: ["old.txt"],
				fileMatches: [expect.objectContaining({ method: "path-blob" })],
			}),
		])
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
		await reconcileFileTransitions(context("fresh"))
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
		await reconcileFileTransitions(context("fresh"))
		expect(contributions().some((row) => row.sha === sha)).toBe(false)
	})
	it("does not claim a file whose native edits cancel each other", async () => {
		baseline()
		await edit("one", "first")
		await edit("first", "one")
		writeFileSync(join(repo, "other.txt"), "human")
		commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([])
	})

	it("keeps native write and edit working when attribution storage fails", async () => {
		baseline()
		writeFileSync(join(root, "blocked"), "file")
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "blocked"))
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		await edit("one", "first")
		await write("new.txt", "new")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new")
		expect(warn).toHaveBeenCalled()
	})
})

describe("symlinked directories", () => {
	it("records a write through a directory that links into another repository", async () => {
		const other = join(root, "other")
		mkdirSync(join(other, "skills"), { recursive: true })
		execFileSync("git", ["-C", other, "init", "-q"])
		execFileSync("git", [
			"-C",
			other,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"base",
		])
		symlinkSync(join(other, "skills"), join(repo, "skills"))
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution")

		await write("skills/SKILL.md", "# Skill\n")

		// Git resolves the linked directory into the other repository; the paths it receives must agree.
		expect(warn).not.toHaveBeenCalledWith("Attribution unavailable:", expect.anything())
		expect(rows().find((row) => row.type === "file_transition")).toMatchObject({
			repository: realpathSync(join(other, ".git")),
			worktree: realpathSync(other),
			path: "skills/SKILL.md",
		})
	})
})
