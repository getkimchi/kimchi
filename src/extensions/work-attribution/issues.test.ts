import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest"
import { createMemoryRecords } from "../pr-cost-reporting/ledger/memory-records.js"
import { closeBackends, getNote, useBackendFactory } from "../pr-cost-reporting/ledger/records.js"
import {
	changeWorkIssue,
	MAX_ISSUE_BYTES,
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
	useBackendFactory(() => createMemoryRecords())
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-work-issue-"))
	folders.push(agentDir)
	workId = randomUUID()
})
afterEach(() => {
	closeBackends()
	useBackendFactory(null)
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** The work's saved ledger selection. */
function saved() {
	const note = getNote(agentDir, workId, "issue")
	if (note === undefined) throw new Error("Expected a saved issue note")
	return JSON.parse(note)
}

/** Writes the work's issue file as another session or version would. */
function saveFile(text: string): string {
	const path = workIssuePath(agentDir, workId)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, text)
	return path
}

/** An issue file as another session saves it. */
function savedFile(revision: number, issueKey?: string, fields: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		version: 1,
		workId,
		revision,
		...(issueKey ? { issueKey } : {}),
		sessionId: "other",
		recordedAt: "2026-10-15T10:00:00.000Z",
		...fields,
	})}\n`
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

describe("a work's issue relation", () => {
	it("saves each selection and clear as the next revision beside the immutable scope", async () => {
		const scope = join(agentDir, "work", workId, "scope.json")
		mkdirSync(dirname(scope), { recursive: true })
		writeFileSync(scope, '{"version":1}\n')
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 0 })

		await changeWorkIssue(agentDir, workId, "first", "ABC-123")
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1, selected: { key: "ABC-123", revision: 1 } })
		// Selecting the selected issue again changes nothing.
		const repeated = await changeWorkIssue(agentDir, workId, "second", "ABC-123")
		expect(repeated.changed).toBe(false)
		expect(readWorkIssue(agentDir, workId)).toEqual(repeated.previous)
		await changeWorkIssue(agentDir, workId, "second", "ABC-124")
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 2, selected: { key: "ABC-124", revision: 2 } })
		await changeWorkIssue(agentDir, workId, "first", undefined)
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 3 })
		// So does clearing a work without an issue.
		await changeWorkIssue(agentDir, workId, "first", undefined)

		expect(saved()).toEqual({ version: 1, workId, revision: 3, sessionId: "first", recordedAt: expect.any(String) })
		expect(readFileSync(scope, "utf8")).toBe('{"version":1}\n')
	})

	// Each file is built in its test, once beforeEach has chosen the work's ID.
	it.each([
		["a damaged file", () => "not json\n"],
		["a file cut short", () => savedFile(1, "ABC-1").slice(0, 40)],
		["a file of a newer format", () => savedFile(1, "ABC-1", { version: 2 })],
		["another work's file", () => savedFile(1, "ABC-1", { workId: randomUUID() })],
		["a file naming no valid key", () => savedFile(1, "abc")],
		["a file larger than any selection", () => savedFile(1, "ABC-1", { padding: "x".repeat(MAX_ISSUE_BYTES) })],
	])("keeps the selection unknown with %s until the next change", async (_case, text) => {
		const path = saveFile(text())

		expect(readWorkIssue(agentDir, workId)).toMatchObject({ unreadable: path })
		expect((await changeWorkIssue(agentDir, workId, "first", undefined)).changed).toBe(true)
		expect(readWorkIssue(agentDir, workId)).not.toHaveProperty("unreadable")
	})

	it("gives sessions in separate processes consecutive revisions without losing a change", async () => {
		// Independent Bun processes share the production SQLite transaction, not a memory fixture.
		const script = join(agentDir, "selector.mts")
		writeFileSync(
			script,
			`import { changeWorkIssue, readWorkIssue } from ${JSON.stringify(new URL("./issues.ts", import.meta.url).pathname)};
if (process.argv[2] === "read") {
 console.log(JSON.stringify(readWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(workId)})));
} else {
 console.log("ready");
 for (let i = 1; i <= 4; i++) changeWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(workId)}, process.argv[2], process.argv[2] + "-" + i);
}`,
		)
		const children = ["ALPHA", "BETA", "GAMMA"].map((project) => {
			const child = spawn("bun", [script, project])
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
		// A timed-out run must not leave writers running after the test folder is removed.
		onTestFinished(() => {
			for (const { child } of children) child.kill()
		})
		await Promise.all(children.map((child) => child.ready))
		await Promise.all(children.map((child) => child.done))

		// Each of the 12 selections read the revision before it, so a lost change would leave fewer.
		const issue = JSON.parse(execFileSync("bun", [script, "read"], { encoding: "utf8" }))
		expect(issue.revision).toBe(12)
		expect(existsSync(workIssuePath(agentDir, workId))).toBe(false)
		// The last change is some writer's last selection.
		expect(issue.selected?.key.endsWith("-4")).toBe(true)
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
		expect(saved()).toMatchObject({ revision: 3 })
		expect(saved()).not.toHaveProperty("issueKey")
	})

	it("saves and shows a lowercase key in uppercase", async () => {
		expect((await command(agentDir, "abc-123")).lines[0].startsWith("Jira issue ABC-123 selected for this work.")).toBe(
			true,
		)
		expect(saved().issueKey).toBe("ABC-123")
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

	it("clears an unreadable selection", async () => {
		saveFile("not json\n")

		expect(await command(agentDir, "clear")).toEqual({
			lines: [
				"Jira issue cleared from this work. From the next prompt, requests have no issue; earlier requests are unchanged.",
			],
			changed: true,
		})
		expect(readWorkIssue(agentDir, workId)).toEqual({ revision: 1 })
	})
})

describe("the /work issue line", () => {
	it("names the selected issue or an unreadable selection, and nothing without one", () => {
		expect(workIssueLines({ revision: 0 })).toEqual([])
		expect(workIssueLines({ revision: 2 })).toEqual([])
		expect(workIssueLines({ revision: 1, selected: { key: "ABC-123", revision: 1 } })).toEqual(["Jira issue: ABC-123"])
		expect(workIssueLines({ revision: 0, unreadable: "/agent/work/issue.json" })).toEqual([
			"Jira issue: unknown; /agent/work/issue.json is unreadable. Choose with: /work issue <KEY> or /work issue clear",
		])
	})
})
