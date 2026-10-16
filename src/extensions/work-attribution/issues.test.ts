import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { lockSync } from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest"
import {
	branchIssueKeys,
	changeWorkIssue,
	parseIssueKey,
	readWorkIssue,
	workIssueCommand,
	workIssueLines,
	workIssuePath,
} from "./issues.js"

let agentDir: string
let workId: string
const folders: string[] = []
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-work-issue-"))
	folders.push(agentDir)
	workId = randomUUID()
})
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** The work's saved revisions, one parsed object per line. */
function savedRevisions() {
	return readFileSync(workIssuePath(agentDir, workId), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
}

/** A revision line as another session saves it. */
function revisionLine(revision: number, issueKey?: string, fields: Record<string, unknown> = {}): string {
	const status = issueKey ? { status: "selected", issueKey } : { status: "cleared" }
	return `${JSON.stringify({
		version: 1,
		workId,
		revision,
		...status,
		source: "work-command",
		sessionId: "other",
		recordedAt: "2026-10-15T10:00:00.000Z",
		...fields,
	})}\n`
}

function saveLines(text: string): string {
	const path = workIssuePath(agentDir, workId)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, text)
	return path
}

function git(cwd: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=Kimchi Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args],
		{ cwd, stdio: "ignore" },
	)
}

/** A repository whose HEAD names `branch`. */
function repository(branch: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "kimchi-work-issue-repo-"))
	folders.push(cwd)
	git(cwd, "init", "-q")
	git(cwd, "symbolic-ref", "HEAD", `refs/heads/${branch}`)
	return cwd
}

function command(cwd: string, args: string) {
	return workIssueCommand({ agentDir, workId, sessionId: "session", cwd }, args)
}

describe("Jira issue keys", () => {
	it.each([
		["ABC-123", "ABC-123"],
		["MY_PROJ2-10", "MY_PROJ2-10"],
		// Lowercase letters are uppercased; the saved and shown key is the uppercase one.
		["abc-123", "ABC-123"],
		["Abc-123", "ABC-123"],
		[`${"A".repeat(255)}-1`, `${"A".repeat(255)}-1`],
		[`ABC-${"9".repeat(16)}`, `ABC-${"9".repeat(16)}`],
	])("accepts %s as %s", (input, key) => {
		expect(parseIssueKey(input)).toBe(key)
	})

	it.each([
		"",
		// Jira project keys have at least two characters.
		"A-1",
		"ABC",
		"ABC-",
		"-1",
		"ABC-0",
		"ABC-01",
		"1ABC-1",
		"_ABC-1",
		"ABC_123",
		"ABC 123",
		"ABC-123x",
		"ABC-123-2",
		"https://example.atlassian.net/browse/ABC-123",
		"ÄBC-1",
		// Only ASCII letters change case: a dotless ı must not become I.
		"lım-1",
		`${"A".repeat(256)}-1`,
		`ABC-${"9".repeat(17)}`,
	])("rejects %j", (input) => {
		expect(parseIssueKey(input)).toBeUndefined()
	})
})

describe("Jira keys in a branch name", () => {
	it.each([
		["main", []],
		["feature/add-jira", []],
		// Jira keys are uppercase; a lowercase or mixed-case token is not one.
		["abc-123-add-jira", []],
		// A key that runs into a letter, digit or underscore is part of a longer word.
		["xABC-123", []],
		["ABC-123x", []],
		["ABC-123_fix", []],
		["ABC-123-add-jira", ["ABC-123"]],
		["feature/ABC-123", ["ABC-123"]],
		["ABC-123/ABC-123-follow-up", ["ABC-123"]],
		["ABC-1-ABC-2", ["ABC-1", "ABC-2"]],
		["release/ABC-12/DEF-3", ["ABC-12", "DEF-3"]],
	])("finds the keys in %s", (branch, keys) => {
		expect(branchIssueKeys(branch)).toEqual(keys)
	})
})

describe("a work's issue relation", () => {
	it("saves selections and clears as new revisions beside the immutable scope", async () => {
		const scope = join(agentDir, "work", workId, "scope.json")
		mkdirSync(dirname(scope), { recursive: true })
		writeFileSync(scope, '{"version":1}\n')
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 0 })

		await changeWorkIssue(agentDir, workId, "first", "ABC-123")
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1, selected: { key: "ABC-123", revision: 1 } })
		// Selecting the selected issue again changes nothing.
		const repeated = await changeWorkIssue(agentDir, workId, "second", "ABC-123")
		expect(repeated).toMatchObject({ changed: false, current: repeated.previous })
		await changeWorkIssue(agentDir, workId, "second", "ABC-124")
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, selected: { key: "ABC-124", revision: 2 } })
		await changeWorkIssue(agentDir, workId, "first", undefined)
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 3 })
		// So does clearing a work without an issue.
		await changeWorkIssue(agentDir, workId, "first", undefined)

		const saved = savedRevisions()
		expect(saved).toEqual([
			{
				version: 1,
				workId,
				revision: 1,
				status: "selected",
				issueKey: "ABC-123",
				source: "work-command",
				sessionId: "first",
				recordedAt: expect.any(String),
			},
			expect.objectContaining({ revision: 2, status: "selected", issueKey: "ABC-124", sessionId: "second" }),
			expect.objectContaining({ revision: 3, status: "cleared", sessionId: "first" }),
		])
		expect(saved[2]).not.toHaveProperty("issueKey")
		expect(readFileSync(scope, "utf8")).toBe('{"version":1}\n')
	})

	it("skips an append cut short and starts the next revision on a new line", async () => {
		await changeWorkIssue(agentDir, workId, "first", "ABC-1")
		const path = workIssuePath(agentDir, workId)
		// Another session crashed in the middle of its append.
		appendFileSync(path, revisionLine(2, "ABC-2").slice(0, 60))
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1, selected: { key: "ABC-1", revision: 1 } })

		await changeWorkIssue(agentDir, workId, "first", "ABC-3")

		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, selected: { key: "ABC-3", revision: 2 } })
		const lines = readFileSync(path, "utf8").split("\n")
		expect(lines).toHaveLength(4)
		expect(lines[1]).toBe(revisionLine(2, "ABC-2").slice(0, 60))
		expect(JSON.parse(lines[2])).toMatchObject({ revision: 2, issueKey: "ABC-3" })
	})

	it("reads a complete last revision that is missing only its line break", () => {
		saveLines(revisionLine(1, "ABC-1") + revisionLine(2, "ABC-2").trimEnd())
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, selected: { key: "ABC-2", revision: 2 } })
	})

	it.each([
		["a damaged line", "not json\n"],
		["a cut-off record nothing followed", `${revisionLine(2, "ABC-2").slice(0, 60)}\n`],
		["a record of a newer format", revisionLine(2, "ABC-2", { version: 2 })],
		["another work's record", revisionLine(2, "ABC-2", { workId: randomUUID() })],
	])("keeps the selection unknown after %s until a new revision", async (_case, tail) => {
		const path = saveLines(revisionLine(1, "ABC-1") + tail)

		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1, unreadable: `${path}:2` })
		expect((await changeWorkIssue(agentDir, workId, "first", undefined)).current).toEqual({ revision: 2 })
	})

	it("ignores damage that a later revision followed", () => {
		saveLines(`${revisionLine(1, "ABC-1")}not json\n${revisionLine(2, "ABC-2")}`)
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, selected: { key: "ABC-2", revision: 2 } })
	})

	it("shows disagreeing revisions of one number as unsettled until the next change", async () => {
		// Two writers that each missed the other's revision 2, for example after a stale lock was taken over.
		saveLines(revisionLine(1, "ABC-1") + revisionLine(2, "ABC-2") + revisionLine(2) + revisionLine(2, "ABC-2"))
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, conflicting: ["ABC-2", null] })

		// Choosing one of them still saves a revision, which settles it.
		await changeWorkIssue(agentDir, workId, "first", "ABC-2")

		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 3, selected: { key: "ABC-2", revision: 3 } })
	})

	it("treats agreeing revisions of one number as one", () => {
		saveLines(revisionLine(1, "ABC-1") + revisionLine(1, "ABC-1", { sessionId: "replayed" }))
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1, selected: { key: "ABC-1", revision: 1 } })
	})

	it("gives sessions in separate processes consecutive revisions without losing a change", async () => {
		const path = workIssuePath(agentDir, workId)
		mkdirSync(dirname(path), { recursive: true })
		// Every writer starts while another one holds the lock, kept fresh as a writer keeps its own.
		let release: (() => void) | undefined = lockSync(path, {
			realpath: false,
			stale: 5000,
			update: 1000,
			onCompromised: () => {},
		})
		const script = join(agentDir, "selector.mts")
		writeFileSync(
			script,
			`import { changeWorkIssue } from ${JSON.stringify(new URL("./issues.ts", import.meta.url).pathname)};
console.log("ready");
for (let i = 1; i <= 4; i++) await changeWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(workId)}, process.argv[2], process.argv[2] + "-" + i);`,
		)
		const children = ["ALPHA", "BETA", "GAMMA"].map((project) => {
			const child = spawn(process.execPath, ["--import", "tsx", script, project])
			let stderr = ""
			child.stderr.on("data", (chunk) => {
				stderr += chunk
			})
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.on("data", (chunk) => {
					if (String(chunk).includes("ready")) resolve()
				})
				child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)))
			})
			const done = new Promise<void>((resolve, reject) =>
				child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr)))),
			)
			void done.catch(() => {})
			return { child, ready, done }
		})
		// A timed-out run must not leave the lock held or writers running after the test folder is removed.
		onTestFinished(() => {
			release?.()
			for (const { child } of children) child.kill()
		})
		await Promise.all(children.map((child) => child.ready))
		release()
		release = undefined
		await Promise.all(children.map((child) => child.done))

		const saved = savedRevisions()
		expect(saved.map((row) => row.revision)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
		expect(new Set(saved.map((row) => row.issueKey)).size).toBe(12)
		expect(readWorkIssue(agentDir, workId)).toEqual({
			revision: 12,
			selected: { key: saved[11].issueKey, revision: 12 },
		})
	}, 60_000)
})

describe("/work issue", () => {
	it("suggests the one key in the branch name without selecting it", async () => {
		const cwd = repository("feature/ABC-123-add-jira")

		expect(await command(cwd, "")).toEqual({
			lines: ["Jira issue: none", "Branch feature/ABC-123-add-jira names ABC-123. Select it with: /work issue ABC-123"],
			changed: false,
		})
		expect(existsSync(workIssuePath(agentDir, workId))).toBe(false)
	})

	it("lists every key of a branch that names several and selects none", async () => {
		const cwd = repository("ABC-1-and-ABC-2")

		expect(await command(cwd, "")).toEqual({
			lines: [
				"Jira issue: none",
				"Branch ABC-1-and-ABC-2 names several issues: ABC-1, ABC-2. Select one with: /work issue <KEY>",
			],
			changed: false,
		})
		expect(existsSync(workIssuePath(agentDir, workId))).toBe(false)
	})

	it("suggests nothing for a branch without a key, a detached HEAD or a folder outside Git", async () => {
		const detached = repository("ABC-123-add-jira")
		git(detached, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Start")
		git(detached, "checkout", "-q", "--detach")
		const outside = mkdtempSync(join(tmpdir(), "kimchi-work-issue-plain-"))
		folders.push(outside)

		for (const cwd of [repository("main"), detached, outside])
			expect(await command(cwd, "")).toEqual({
				lines: ["Jira issue: none. Select one with: /work issue <KEY>"],
				changed: false,
			})
	})

	it("selects, replaces and clears the work's issue", async () => {
		const cwd = repository("feature/ABC-123-add-jira")

		expect(await command(cwd, "ABC-123")).toEqual({
			lines: [
				"Jira issue ABC-123 selected for this work. It applies from the next prompt; earlier requests are unchanged.",
			],
			changed: true,
		})
		// The work's details name the selected issue, and the branch names no other one.
		expect(await command(cwd, "")).toEqual({ lines: [], changed: false })
		expect(await command(cwd, "ABC-123")).toEqual({
			lines: ["Jira issue ABC-123 is already selected for this work."],
			changed: false,
		})
		expect(await command(cwd, "ABC-124")).toEqual({
			lines: [
				"Jira issue ABC-124 selected for this work, replacing ABC-123. It applies from the next prompt; earlier requests are unchanged.",
			],
			changed: true,
		})
		expect(await command(cwd, "")).toEqual({
			lines: ["Branch feature/ABC-123-add-jira names ABC-123. Select it with: /work issue ABC-123"],
			changed: false,
		})
		expect(await command(cwd, " clear ")).toEqual({
			lines: [
				"Jira issue ABC-124 cleared from this work. From the next prompt, requests have no issue; earlier requests are unchanged.",
			],
			changed: true,
		})
		expect(await command(cwd, "clear")).toEqual({ lines: ["No Jira issue is selected for this work."], changed: false })
		expect(savedRevisions().map((row) => [row.revision, row.status, row.issueKey])).toEqual([
			[1, "selected", "ABC-123"],
			[2, "selected", "ABC-124"],
			[3, "cleared", undefined],
		])
	})

	it("saves and shows a lowercase key in uppercase", async () => {
		expect((await command(agentDir, "abc-123")).lines[0]).toMatch(/^Jira issue ABC-123 selected for this work\./)
		expect(savedRevisions()[0].issueKey).toBe("ABC-123")
	})

	it.each([
		"ABC",
		"ABC-123 ABC-124",
		"clear ABC-123",
		"https://example.atlassian.net/browse/ABC-123",
	])("rejects %j without saving anything", async (args) => {
		expect(await command(agentDir, args)).toEqual({
			lines: [
				`Not a Jira issue key: ${JSON.stringify(args)}. Use /work issue <KEY>, such as /work issue ABC-123, or /work issue clear.`,
			],
			changed: false,
			warning: true,
		})
		expect(existsSync(workIssuePath(agentDir, workId))).toBe(false)
	})

	it("clears an unsettled selection", async () => {
		saveLines(revisionLine(1, "ABC-1") + revisionLine(1, "ABC-2"))

		expect(await command(agentDir, "clear")).toEqual({
			lines: [
				"Jira issue cleared from this work. From the next prompt, requests have no issue; earlier requests are unchanged.",
			],
			changed: true,
		})
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2 })
	})
})

describe("the /work issue line", () => {
	it("names the selected issue, an unsettled or unreadable selection, and nothing without one", () => {
		expect(workIssueLines({ revision: 0 })).toEqual([])
		expect(workIssueLines({ revision: 2 })).toEqual([])
		expect(workIssueLines({ revision: 1, selected: { key: "ABC-123", revision: 1 } })).toEqual(["Jira issue: ABC-123"])
		expect(workIssueLines({ revision: 2, conflicting: ["ABC-1", "ABC-2", null] })).toEqual([
			"Jira issue: unsettled; simultaneous changes chose ABC-1, ABC-2 and no issue. Choose with: /work issue <KEY> or /work issue clear",
		])
		expect(workIssueLines({ revision: 1, unreadable: "/agent/work/issue.jsonl:2" })).toEqual([
			"Jira issue: unknown; /agent/work/issue.jsonl:2 is unreadable. Choose with: /work issue <KEY> or /work issue clear",
		])
	})
})
