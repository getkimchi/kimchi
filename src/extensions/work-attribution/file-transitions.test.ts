import * as childProcess from "node:child_process"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { savedWorkSummary } from "../__mocks__/work-summary.js"
import { hydrateLegacy } from "../pr-cost-reporting/ledger/import.js"
import { createMemoryRecords } from "../pr-cost-reporting/ledger/memory-records.js"
import * as ledger from "../pr-cost-reporting/ledger/records.js"
import { closeBackends, getNote, setNote, useBackendFactory } from "../pr-cost-reporting/ledger/records.js"
import toolRenderingExtension from "../tool-rendering.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import { createCommitTrackingBashTool } from "./commits.js"
import * as diagnostics from "./diagnostics.js"
import {
	createTrackedEditTool,
	createTrackedWriteTool,
	type FileState,
	knownTransitionRepositories,
	readAttributedFileState,
	readAttributedFileStates,
	reconcileFileTransitions,
	reconcileRepositoryTransitions,
} from "./file-transitions.js"
import { flushWorkSummaries, readWorkRecords, type WorkRecord } from "./summary.js"

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
/** Kimchi's own store of retained edit snapshots for the test repository. */
function snapshots() {
	const repository = realpathSync(join(repo, ".git"))
	return join(root, "agent", "work-attribution", "objects", createHash("sha256").update(repository).digest("hex"))
}
function context(session = "original") {
	return createToolContext({ cwd: repo, sessionManager: { getSessionId: () => session } })
}
/** Ledger rows the fixtures actually read, narrowed by their row type. */
interface FixtureTransitionRow extends WorkRecord {
	type: "file_transition"
	transitionId: string
	toolCallId: string
	cwd: string
	repository: string
	worktree: string
	path: string
	baseline: string | null
	baselineFile: { blob: string; mode?: string } | null
	before: { blob: string; mode?: string } | null
	after: { blob: string; mode?: string }
	cursor: { bytes: number; digest: string }
	recordedAt: string
	historyBoundaryId?: string
	refTips?: string[]
}
interface FixtureCommitRow extends WorkRecord {
	type: "commit"
	sha: string
	repository: string
	worktree: string
	paths: string[]
	transitionIds: string[]
	fileMatches: Array<{ path: string; method: string; worktree: string }>
	source: string
}
/** Every other ledger row type; excluding the two concrete types keeps `type` a real discriminant. */
interface FixtureOtherRow extends WorkRecord {
	type: Exclude<WorkRecord["type"], "file_transition" | "commit">
}
type FixtureRow = FixtureTransitionRow | FixtureCommitRow | FixtureOtherRow
function rows() {
	// C2+ keeps the authority in the ledger; legacy JSONL is read-only for old installs.
	return readWorkRecords(join(root, "agent")) as FixtureRow[]
}
function firstTransition(): FixtureTransitionRow {
	const found = rows().find((row) => row.type === "file_transition")
	if (!found) throw new Error("Expected a captured file transition")
	return found
}
function contributions() {
	return rows().filter(
		(row): row is FixtureCommitRow => row.type === "commit" && row.source === "native-file-transition",
	)
}
async function write(path: string, content: string, ctx = context()) {
	await createTrackedWriteTool(ctx, "write-call").execute("write-call", { path, content })
}
async function edit(oldText: string, newText: string, ctx = context(), path = "file.txt") {
	await createTrackedEditTool(ctx, "edit-call").execute("edit-call", {
		path,
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
	useBackendFactory(() => createMemoryRecords())
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
	closeBackends()
	useBackendFactory(null)
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
		// The checkpoint is a bookkeeping note keyed by the transition journal path; corrupt its
		// evidence so the matcher re-runs, then prove it still does not duplicate contributions.
		const transitionFile = join(
			root,
			"agent",
			"work-attribution",
			"transitions",
			`${createHash("sha256")
				.update(JSON.stringify([repository, realpathSync(repo)]))
				.digest("hex")}.jsonl`,
		)
		const checkpointKey = `${transitionFile}.content-checkpoint`
		const progress = getNote(join(root, "agent"), checkpointKey, "content-checkpoint")
		if (!progress) throw new Error("Expected a content checkpoint")
		const note = JSON.parse(progress)
		note.evidence = `content:${note.evidence}`
		setNote(join(root, "agent"), checkpointKey, "content-checkpoint", JSON.stringify(note))
		await reconcileRepositoryTransitions(repository)
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
	})

	it.each([
		"ls-tree",
		"merge-base",
		"cat-file",
	])("retries a timed-out %s comparison in an external linked worktree without checkpointing it", async (command) => {
		writeFileSync(join(repo, "file.txt"), "heading\none\ncontext\nseparator\nhuman-before\nfooter\n")
		commit()
		const primary = repo
		repo = join(root, "external-worktree")
		execFileSync("git", ["-C", primary, "worktree", "add", "-qb", "external", repo])
		await edit("one", "first")
		const workId = getWorkId(context())
		// Stash interrupts the exact file chain, exercising comparisons in the shared .git directory.
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		if (command === "cat-file")
			writeFileSync(
				join(repo, "file.txt"),
				readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after"),
			)
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
		const transitionFile = join(
			root,
			"agent",
			"work-attribution",
			"transitions",
			`${createHash("sha256")
				.update(JSON.stringify([repository, worktree]))
				.digest("hex")}.jsonl`,
		)
		expect(getNote(join(root, "agent"), `${transitionFile}.content-checkpoint`, "content-checkpoint")).toBeUndefined()

		await reconcileRepositoryTransitions(repository)
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				repository,
				worktree,
				fileMatches: [
					expect.objectContaining({
						path: "file.txt",
						method: command === "cat-file" ? "file-hunks" : "path-blob",
						worktree,
					}),
				],
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
		const deadline = 3000
		const original = asyncFs.open
		const headers = vi.spyOn(asyncFs, "open").mockImplementation((...args) => {
			if (String(args[0]).endsWith(".jsonl") && args[1] === "r") clock += 1100
			return original(...args)
		})
		const checkBudget = () => {
			if (clock > deadline) throw new Error("budget")
		}
		// Repository discovery is one ledger read; no journal-header opens happen on this path.
		expect(await knownTransitionRepositories(checkBudget)).toHaveLength(5)
		expect(headers).not.toHaveBeenCalled()
	})

	it("discovers another known repository even when a large journal cannot be read", async () => {
		baseline()
		await edit("one", "first")
		// A legacy install may still hold an oversized transition journal; the ledger path ignores it.
		const directory = join(root, "agent", "work-attribution", "transitions")
		mkdirSync(directory, { recursive: true })
		const large = join(directory, "legacy-large.jsonl")
		writeFileSync(large, `${" ".repeat(8 * 1024 * 1024)}\n`)
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
		expect(existsSync(snapshots)).toBe(false)
		const snapshot = JSON.parse(
			getNote(join(root, "agent"), "ref-tips", String(mutations[0].historyBoundaryId)) ?? "null",
		)
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
		const mutation = firstTransition()
		const agentDir = join(root, "agent")
		const id = String(mutation.historyBoundaryId)
		const saved = getNote(agentDir, "ref-tips", id)
		if (saved === undefined) throw new Error("Expected a saved history boundary")
		const readNote = ledger.getNote
		const missing =
			damage === "missing"
				? vi
						.spyOn(ledger, "getNote")
						.mockImplementation((dir, workId, name) =>
							workId === "ref-tips" && name === id ? undefined : readNote(dir, workId, name),
						)
				: undefined
		if (damage === "truncated") setNote(agentDir, "ref-tips", id, '{"version":1,"refTips":[')
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await reconcileFileTransitions(context("damaged"))
		expect(contributions()).toEqual([])
		missing?.mockRestore()
		setNote(agentDir, "ref-tips", id, saved)
		await reconcileFileTransitions(context("repaired"))
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
	})

	it("publishes one complete snapshot before concurrent transitions and repairs a damaged copy", async () => {
		baseline()
		const agentDir = join(root, "agent")
		const backend = ledger.backendFor(agentDir)
		const insert = backend.insertRecord
		const stored = vi.spyOn(backend, "putNote")
		const checked = vi.spyOn(backend, "insertRecord").mockImplementation((record) => {
			if (record.type === "file_transition") {
				const row = JSON.parse(record.body)
				expect(JSON.parse(getNote(agentDir, "ref-tips", row.historyBoundaryId) ?? "null")).toEqual({
					version: 1,
					refTips: [git("rev-parse", "HEAD")],
				})
			}
			return insert(record)
		})
		await Promise.all([write("first.txt", "first"), write("second.txt", "second")])
		const mutations = rows().filter((row) => row.type === "file_transition")
		expect(mutations).toHaveLength(2)
		const id = String(mutations[0].historyBoundaryId)
		expect(mutations[1].historyBoundaryId).toBe(id)
		expect(stored.mock.calls.filter(([workId, name]) => workId === "ref-tips" && name === id)).toHaveLength(1)
		setNote(agentDir, "ref-tips", id, "partial")
		await write("third.txt", "third")
		expect(JSON.parse(getNote(agentDir, "ref-tips", id) ?? "null").refTips).toEqual([git("rev-parse", "HEAD")])
		expect(checked.mock.calls.filter(([record]) => record.type === "file_transition")).toHaveLength(3)
		expect(existsSync(join(agentDir, "work-attribution", "ref-tips"))).toBe(false)
	})

	it("preserves exact matching when its optional history snapshot is missing", async () => {
		baseline()
		await edit("one", "first")
		const mutation = firstTransition()
		const readNote = ledger.getNote
		vi.spyOn(ledger, "getNote").mockImplementation((dir, workId, name) =>
			workId === "ref-tips" && name === mutation.historyBoundaryId ? undefined : readNote(dir, workId, name),
		)
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
		// Reopen actual legacy input with either inline tips or no snapshot evidence.
		const legacy = rows().map((row) =>
			row.type === "file_transition"
				? {
						...row,
						historyBoundaryId: undefined,
						refTips: format === "inline" ? [git("rev-parse", "HEAD")] : undefined,
					}
				: row,
		)
		const directory = join(root, "agent", "work-attribution", "transitions")
		mkdirSync(directory, { recursive: true })
		const path = join(directory, "legacy.jsonl")
		const original = `${legacy.map((row) => JSON.stringify(row)).join("\n")}\n`
		writeFileSync(path, original)
		closeBackends()
		hydrateLegacy(join(root, "agent"))
		const stored = rows().filter((row) => row.type === "file_transition")
		expect(stored).toHaveLength(1)
		expect(stored[0].historyBoundaryId).toBeUndefined()
		expect(stored[0].refTips).toEqual(format === "inline" ? [git("rev-parse", "HEAD")] : undefined)
		git("stash", "push", "-q")
		git("stash", "pop", "-q")
		const sha = commit()
		await reconcileFileTransitions(context("fresh"))
		expect(contributions()).toEqual([expect.objectContaining({ sha })])
		expect(rows().filter((row) => row.type === "file_transition")).toEqual(stored)
		expect(readFileSync(path, "utf8")).toBe(original)
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
		const summary = savedWorkSummary(join(root, "agent"), workId)
		expect(summary.commits.map((row) => row.sessionId).sort()).toEqual(["first", "second"])
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
		const summary = savedWorkSummary(join(root, "agent"), workId)
		expect(summary.commits.map((row) => row.sessionId).sort()).toEqual(["first", "second"])
	})

	it("rechecks completed commits when additional transition evidence becomes available", async () => {
		baseline()
		await write("first.txt", "first")
		const firstSha = commit()
		await reconcileFileTransitions(context("first-launch"))
		expect(contributions()).toEqual([expect.objectContaining({ sha: firstSha, paths: ["first.txt"] })])
		// Additional evidence arrives in a later launch; the recheck reconciles it without
		// duplicating the already-recorded contribution.
		await write("second.txt", "second")
		const secondSha = commit()
		await reconcileFileTransitions(context("next-launch"))
		await reconcileFileTransitions(context("repeat-launch"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha: firstSha, paths: ["first.txt"] }),
			expect.objectContaining({ sha: secondSha, paths: ["second.txt"] }),
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
		// The ledger is immutable; the checkpoint itself holds the legacy-format evidence.
		// Degrade it the way an older install's checkpoint did, so the upgrade pass must
		// re-run reconciliation instead of trusting the completed marker.
		const agentDir = join(root, "agent")
		const transitionFile = join(
			agentDir,
			"work-attribution",
			"transitions",
			`${createHash("sha256")
				.update(JSON.stringify([realpathSync(join(repo, ".git")), realpathSync(repo)]))
				.digest("hex")}.jsonl`,
		)
		const progressKey = `${transitionFile}.progress`
		const checkpoint = getNote(agentDir, progressKey, "progress")
		if (!checkpoint) throw new Error("Expected a completed reconciliation checkpoint")
		const progress = JSON.parse(checkpoint)
		progress.evidence = `${prefix}:${progress.evidence.replace(/^(?:sessions-v1:)?matches-v2:/, "")}`
		setNote(agentDir, progressKey, "progress", JSON.stringify(progress))
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
	it.each([
		"before",
		"after",
		"shifted",
		"both",
	])("joins complete native hunks beside human edits (%s)", async (timing) => {
		const original = "heading\nnative-before\nnative-context\nseparator\nhuman-before\nfooter\n"
		writeFileSync(join(repo, "file.txt"), original)
		commit()
		const ctx = context()
		const workId = getWorkId(ctx)
		if (timing === "before" || timing === "both")
			writeFileSync(join(repo, "file.txt"), original.replace("human-before", "human-after"))
		await edit("native-before", "native-after", ctx)
		if (timing !== "before") {
			const content = readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after")
			writeFileSync(
				join(repo, "file.txt"),
				`${timing === "shifted" || timing === "both" ? "human-prefix\n" : ""}${content}`,
			)
		}
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		await reconcileFileTransitions(context("again"))
		const transition = firstTransition()
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				sessionId: "original",
				fileMatches: [
					{
						path: "file.txt",
						method: "file-hunks",
						worktree: realpathSync(repo),
						transitionIds: [transition.transitionId],
					},
				],
			}),
		])
	})
	it("reads the four texts of a hunk match with two Git processes", async () => {
		writeFileSync(join(repo, "file.txt"), "heading\nnative-before\ncontext\nseparator\nhuman-before\nfooter\n")
		commit()
		await edit("native-before", "native-after")
		writeFileSync(
			join(repo, "file.txt"),
			readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after"),
		)
		commit()
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		const reads: string[] = []
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			if (Array.isArray(args[1]) && args[1][2] === "cat-file") reads.push(String(args[1][3]))
			return execute(...args)
		}) as typeof execute)
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([
			expect.objectContaining({ fileMatches: [expect.objectContaining({ method: "file-hunks" })] }),
		])
		expect(reads).toEqual(["--batch-check=%(objecttype) %(objectsize)", "--batch"])
	})
	it("retains exact native text snapshots in Kimchi's store, never in the repository", async () => {
		baseline()
		const dirty = "one\ntwo\nhuman-before\n"
		writeFileSync(join(repo, "file.txt"), dirty)
		const inspected = await readAttributedFileState(join(repo, "file.txt"))
		expect(inspected?.blob).toBeDefined()
		expect(() => git("cat-file", "-e", inspected?.blob ?? "missing")).toThrow()
		const loose = git("count-objects")
		await edit("one", "first")
		const transition = firstTransition()
		expect(transition.before).toEqual(inspected)
		const retained: Array<[{ blob: string; mode?: string } | null, string]> = [
			[transition.before, dirty],
			[transition.after, dirty.replace("one", "first")],
		]
		for (const [state, content] of retained) {
			if (!state) throw new Error("Expected a retained snapshot")
			// Unreachable snapshots in the user's repository would keep Git's automatic gc repacking and warning.
			expect(() => git("cat-file", "-e", state.blob)).toThrow()
			const stored = execFileSync("git", ["-C", repo, "cat-file", "blob", state.blob], {
				env: { ...process.env, GIT_OBJECT_DIRECTORY: snapshots() },
			})
			expect(stored.equals(Buffer.from(content))).toBe(true)
		}
		expect(git("count-objects")).toBe(loose)
		expect(JSON.stringify(rows())).not.toContain("human-before")
	})
	it("retains each new edited content once and no copy of the committed file", async () => {
		baseline()
		await edit("one", "first")
		await edit("two", "second")
		await edit("second", "two")
		const transitions = rows().filter((row) => row.type === "file_transition")
		const stored = readdirSync(snapshots(), { recursive: true })
			.map(String)
			.filter((path) => /^[\da-f]{2}\/[\da-f]+$/.test(path))
			.map((path) => path.replace("/", ""))
		// The repository already has the committed blob the first edit starts from; later edits start from stored content.
		expect(transitions[0].before).toEqual(transitions[0].baselineFile)
		expect(stored.sort()).toEqual([transitions[0].after.blob, transitions[1].after.blob].sort())
	})
	it.each(["true", "false"])("reads many files like single-file inspections (core.filemode=%s)", async (filemode) => {
		writeFileSync(
			join(repo, ".gitattributes"),
			"*.txt text eol=lf\n*.utf16 working-tree-encoding=UTF-16\n*.filtered filter=unexpected\n",
		)
		writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\n")
		chmodSync(join(repo, "tool.sh"), 0o755)
		baseline()
		git("config", "core.filemode", filemode)
		git("config", "filter.unexpected.clean", "touch filter-ran; cat")
		const odd = 'odd "name" \\ with\nnewline.txt'
		const files = {
			"file.txt": "first\r\ntwo\r\n",
			"tool.sh": "#!/bin/sh\necho changed\n",
			[odd]: "odd\n",
			"text.utf16": "encoded\n",
			"data.filtered": "filtered\n",
			"big.log": "x".repeat(8 * 1024 * 1024 + 1),
		}
		for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content)
		chmodSync(join(repo, "tool.sh"), 0o644)
		symlinkSync("file.txt", join(repo, "link"))
		const worktree = realpathSync(repo)
		const paths = [...Object.keys(files), "link", "missing.txt"]
		const expected = new Map<string, FileState | null | undefined>()
		for (const path of paths) expected.set(path, await readAttributedFileState(join(worktree, path)))
		expect(await readAttributedFileStates(worktree, paths)).toEqual(expected)
		expect([...expected].filter(([, state]) => state).map(([path]) => path)).toEqual(["file.txt", "tool.sh", odd])
		expect(expected.get("tool.sh")?.mode).toBe(filemode === "false" ? "100755" : "100644")
		expect(existsSync(join(repo, "filter-ran"))).toBe(false)
	})
	it("preserves exact attribution when Git cannot retain the snapshot", async () => {
		baseline()
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		let snapshots = 0
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			if (Array.isArray(args[1]) && args[1].includes("hash-object") && args[1].includes("-w")) {
				snapshots += 1
				args[1] = [...args[1], "--invalid-retention-test"]
			}
			return execute(...args)
		}) as typeof execute)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await edit("one", "first")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		const transitions = rows().filter((row) => row.type === "file_transition")
		expect(transitions).toHaveLength(1)
		// The edit starts from the committed file, so only its new content needs a snapshot.
		expect(snapshots).toBe(1)
		expect(() => git("cat-file", "-e", transitions[0].after.blob)).toThrow()
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				fileMatches: [expect.objectContaining({ method: "file-chain", transitionIds: [transitions[0].transitionId] })],
			}),
		])
	})
	it("leaves attribution unresolved when both retained and dry hashing fail", async () => {
		baseline()
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			if (Array.isArray(args[1]) && args[1].includes("hash-object")) args[1] = [...args[1], "--invalid-hash-test"]
			return execute(...args)
		}) as typeof execute)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		await edit("one", "first")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
	})
	it("rechecks Git filters before falling back to a dry hash", async () => {
		baseline()
		git("config", "filter.unexpected.clean", "touch filter-ran; cat")
		const { execFile: execute } = await vi.importActual<typeof childProcess>("node:child_process")
		vi.spyOn(childProcess, "execFile").mockImplementation(((...args: Parameters<typeof execute>) => {
			if (Array.isArray(args[1]) && args[1].includes("hash-object") && args[1].includes("-w")) {
				writeFileSync(join(repo, ".gitattributes"), "*.txt filter=unexpected\n")
				args[1] = [...args[1], "--invalid-retention-test"]
			}
			return execute(...args)
		}) as typeof execute)
		await edit("one", "first")
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("first\ntwo\n")
		expect(existsSync(join(repo, "filter-ran"))).toBe(false)
		expect(rows().filter((row) => row.type === "file_transition")).toEqual([])
	})
	it("matches Git-normalized native hunks beside human CRLF edits", async () => {
		const original = "heading\nnative-before\ncontext\nseparator\nhuman-before\nfooter\n"
		writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=lf\n")
		writeFileSync(join(repo, "file.txt"), original)
		commit()
		writeFileSync(join(repo, "file.txt"), original.replaceAll("\n", "\r\n"))
		await edit("native-before", "native-after")
		writeFileSync(
			join(repo, "file.txt"),
			original.replace("native-before", "native-after").replace("human-before", "human-after").replaceAll("\n", "\r\n"),
		)
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "file-hunks" })] }),
		])
	})
	it("rechecks mixed edits skipped by the previous content matcher", async () => {
		const original = "heading\nnative-before\ncontext\nseparator\nhuman-before\nfooter\n"
		writeFileSync(join(repo, "file.txt"), original)
		commit()
		await edit("native-before", "native-after")
		writeFileSync(
			join(repo, "file.txt"),
			original.replace("native-before", "native-after").replace("human-before", "human-after"),
		)
		const sha = commit()
		await reconcileFileTransitions(context("initial"))
		// Rows are immutable; a stale matcher checkpoint must force a re-run without duplicating
		// the already-recorded contribution (the legacy fixture instead deleted commit rows).
		const checkpointPath = join(
			root,
			"agent",
			"work-attribution",
			"transitions",
			`${createHash("sha256")
				.update(JSON.stringify([realpathSync(join(repo, ".git")), realpathSync(repo)]))
				.digest("hex")}.jsonl.content-checkpoint`,
		)
		const saved = getNote(join(root, "agent"), checkpointPath, "content-checkpoint")
		if (!saved) throw new Error("Expected a completed content checkpoint")
		const progress = JSON.parse(saved)
		progress.evidence = progress.evidence.replace(/^content-v3:/, "content-v2:")
		setNote(join(root, "agent"), checkpointPath, "content-checkpoint", JSON.stringify(progress))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "file-hunks" })] }),
		])
		await reconcileFileTransitions(context("upgraded"))
		expect(contributions()).toHaveLength(1)
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "file-hunks" })] }),
		])
	})
	it("skips oversized committed files without blocking other native hunk matches", async () => {
		const original = "heading\nnative-before\ncontext\nseparator\nhuman-before\nfooter\n"
		writeFileSync(join(repo, "file.txt"), original)
		writeFileSync(join(repo, "small.txt"), original)
		commit()
		await createTrackedEditTool(context(), "small-edit").execute("small-edit", {
			path: "small.txt",
			edits: [{ oldText: "native-before", newText: "native-after" }],
		})
		writeFileSync(
			join(repo, "small.txt"),
			original.replace("native-before", "native-after").replace("human-before", "human-after"),
		)
		const smallCommit = commit()
		await edit("native-before", "native-after")
		writeFileSync(
			join(repo, "file.txt"),
			`${original.replace("native-before", "native-after")}${"x".repeat(9 * 1024 * 1024)}`,
		)
		commit()
		const repository = realpathSync(join(repo, ".git"))
		await reconcileRepositoryTransitions(repository)
		await reconcileRepositoryTransitions(repository)
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha: smallCommit,
				fileMatches: [expect.objectContaining({ path: "small.txt", method: "file-hunks" })],
			}),
		])
	})
	it.each([
		"overlap",
		"partial",
		"missing-blob",
		"mode",
		"binary",
		"interleaved",
		"deleted",
	])("leaves incomplete native hunks unresolved (%s)", async (kind) => {
		const original = `${kind === "binary" ? "\0" : ""}heading\nnative-before\ncontext\nseparator\nsecond-before\nsecond-context\ngap\nhuman-before\nfooter\n`
		writeFileSync(join(repo, "file.txt"), original)
		commit()
		await edit("native-before", "native-after")
		if (kind === "interleaved")
			writeFileSync(
				join(repo, "file.txt"),
				readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after"),
			)
		if (kind === "partial" || kind === "interleaved") await edit("second-before", "second-after")
		const transition = firstTransition()
		if (kind === "missing-blob")
			rmSync(join(snapshots(), transition.after.blob.slice(0, 2), transition.after.blob.slice(2)))
		let content = readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after")
		if (kind === "overlap") content = content.replace("native-after", "human-overlap")
		if (kind === "partial") content = content.replace("second-after", "second-before")
		writeFileSync(join(repo, "file.txt"), content)
		if (kind === "mode") chmodSync(join(repo, "file.txt"), 0o755)
		if (kind === "deleted") rmSync(join(repo, "file.txt"))
		commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([])
	})
	it("leaves repeated native hunk locations unresolved beside human edits", async () => {
		const original = "heading\nsame\nx\nsame\nseparator\nsame\nx\nsame\ngap\nhuman-before\nfooter\n"
		writeFileSync(join(repo, "file.txt"), original)
		commit()
		await write("file.txt", original.replace("x", "y"))
		writeFileSync(
			join(repo, "file.txt"),
			readFileSync(join(repo, "file.txt"), "utf8").replace("human-before", "human-after"),
		)
		commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([])
	})
	it.each([
		"after",
		"before",
		"edited",
		"committed empty",
	])("joins a native write into a new or empty file when its lines survive beside human lines (%s)", async (kind) => {
		baseline()
		if (kind === "committed empty") {
			writeFileSync(join(repo, "new.txt"), "")
			commit()
		}
		const ctx = context()
		const workId = getWorkId(ctx)
		await write("new.txt", "alpha\nbeta\n", ctx)
		if (kind === "edited") await edit("beta", "gamma", ctx, "new.txt")
		const written = readFileSync(join(repo, "new.txt"), "utf8")
		writeFileSync(join(repo, "new.txt"), kind === "before" ? `human\n${written}` : `${written}human\n`)
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		await reconcileFileTransitions(context("again"))
		expect(contributions()).toEqual([
			expect.objectContaining({
				sha,
				workId,
				sessionId: "original",
				fileMatches: [
					{
						path: "new.txt",
						method: "file-hunks",
						worktree: realpathSync(repo),
						transitionIds: rows()
							.filter((row) => row.type === "file_transition")
							.map((row) => row.transitionId),
					},
				],
			}),
		])
	})
	it("keeps whole-file evidence for a created file committed unchanged", async () => {
		baseline()
		await write("new.txt", "alpha\nbeta\n")
		git("stash", "push", "-qu")
		git("stash", "pop", "-q")
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toEqual([
			expect.objectContaining({ sha, fileMatches: [expect.objectContaining({ method: "path-blob" })] }),
		])
	})
	it("retains a created file's text in Kimchi's store unless Git ignores it", async () => {
		baseline()
		writeFileSync(join(repo, ".gitignore"), "*.log\n")
		await write("new.txt", "alpha\n")
		await write("debug.log", "secret\n")
		const written = (path: string) => {
			const row = rows().find(
				(candidate): candidate is FixtureTransitionRow =>
					candidate.type === "file_transition" && candidate.path === path,
			)
			if (!row) throw new Error("Expected a captured transition")
			return row.after.blob
		}
		const stored = (blob: string) => existsSync(join(snapshots(), blob.slice(0, 2), blob.slice(2)))
		expect(stored(written("new.txt"))).toBe(true)
		expect(() => git("cat-file", "-e", written("new.txt"))).toThrow()
		expect(stored(written("debug.log"))).toBe(false)
	})
	it.each([
		"renamed",
		"deleted",
	])("claims only the commit that adds a created file, not one where it is later %s", async (kind) => {
		baseline()
		await write("new.txt", "alpha\nbeta\n")
		writeFileSync(join(repo, "new.txt"), "alpha\nbeta\nhuman\n")
		const added = commit()
		if (kind === "renamed") git("mv", "new.txt", "renamed.txt")
		else git("rm", "-q", "new.txt")
		git("commit", "-qm", kind)
		await reconcileFileTransitions(context("reopened"))
		expect(contributions().map((row) => row.sha)).toEqual([added])
	})
	it("matches identical content that two works created to the file each work wrote", async () => {
		baseline()
		const first = getWorkId(context())
		await write("first.txt", "shared\ncontent\n")
		const second = setWorkId(context())
		await write("second.txt", "shared\ncontent\n")
		for (const path of ["first.txt", "second.txt"]) writeFileSync(join(repo, path), `shared\ncontent\n${path}\n`)
		const sha = commit()
		await reconcileFileTransitions(context("reopened"))
		expect(contributions()).toHaveLength(2)
		expect(contributions()).toEqual(
			expect.arrayContaining(
				[
					[first, "first.txt"],
					[second, "second.txt"],
				].map(([workId, path]) =>
					expect.objectContaining({
						sha,
						workId,
						paths: [path],
						fileMatches: [expect.objectContaining({ method: "file-hunks" })],
					}),
				),
			),
		)
	})
	it.each([
		"edited",
		"repeated",
		"empty",
		"blank",
		"mode",
		"oversized",
		"binary",
		"non-UTF-8",
		"renamed",
		"deleted",
		"ignored",
		"two works",
	])("leaves created-file evidence unresolved (%s)", async (kind) => {
		baseline()
		const path = kind === "ignored" ? "debug.log" : "new.txt"
		if (kind === "ignored") writeFileSync(join(repo, ".gitignore"), "*.log\n")
		const contents: Record<string, string> = {
			empty: "",
			blank: "\n\n",
			oversized: "line\n".repeat(64 * 1024),
			binary: "alpha\0\nbeta\n",
		}
		const content = contents[kind] ?? "alpha\nbeta\n"
		await write(path, content)
		if (kind === "two works") {
			rmSync(join(repo, path))
			setWorkId(context())
			await write(path, content)
		}
		let kept = content
		if (kind === "edited") kept = content.replace("beta", "human-beta")
		if (kind === "repeated") kept = `${content}${content}`
		writeFileSync(join(repo, path), `human\n${kept}more\n`)
		if (kind === "non-UTF-8") writeFileSync(join(repo, path), Buffer.from([0xe9, 0x0a]), { flag: "a" })
		if (kind === "mode") chmodSync(join(repo, path), 0o755)
		if (kind === "renamed") renameSync(join(repo, path), join(repo, "renamed.txt"))
		if (kind === "deleted") {
			rmSync(join(repo, path))
			writeFileSync(join(repo, "other.txt"), "other\n")
		}
		if (kind === "ignored") git("add", "-f", path)
		commit()
		await reconcileFileTransitions(context("reopened"))
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
		const putNote = ledger.setNote
		const blocked =
			format === "legacy"
				? vi.spyOn(ledger, "setNote").mockImplementation((dir, workId, name, body) => {
						if (workId === "ref-tips") throw new Error("History boundary unavailable")
						putNote(dir, workId, name, body)
					})
				: undefined
		await edit("one", "first")
		blocked?.mockRestore()
		if (format === "legacy") expect(firstTransition().historyBoundaryId).toBeUndefined()
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
		// A broken store is the opened-ledger failure; capture must degrade without losing the mutation.
		closeBackends()
		useBackendFactory(() => {
			throw Object.assign(new Error("ledger unavailable"), { code: "pr-cost-ledger/unavailable" })
		})
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		try {
			await tool.execute("pinned", { path: "file.txt", content: "changed" })
			expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("changed")
			expect(warn).toHaveBeenCalled()
		} finally {
			closeBackends()
			useBackendFactory(() => createMemoryRecords())
		}
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
		if (legacy) {
			const putNote = ledger.setNote
			const blocked = vi.spyOn(ledger, "setNote").mockImplementation((dir, workId, name, body) => {
				if (workId === "ref-tips") throw new Error("History boundary unavailable")
				putNote(dir, workId, name, body)
			})
			repo = second
			await edit("one", "same", context("second"))
			blocked.mockRestore()
			expect(firstTransition().historyBoundaryId).toBeUndefined()
			repo = first
			await edit("one", "same", context("first"))
		} else {
			repo = first
			await edit("one", "same", context("first"))
			repo = second
			await edit("one", "same", context("second"))
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
		if (!matched) throw new Error("Expected a contribution")
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
		closeBackends()
		useBackendFactory(() => {
			throw new Error("Ledger unavailable")
		})
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
