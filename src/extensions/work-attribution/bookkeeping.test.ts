import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

const WORK = "11111111-1111-4111-8111-111111111111"
const ORG = "22222222-2222-4222-8222-222222222222"
const USER = "33333333-3333-4333-8333-333333333333"
const folders: string[] = []
const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href)

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kimchi-bookkeeping-"))
	folders.push(root)
	const cwd = join(root, "repo")
	mkdirSync(cwd)
	execFileSync("git", ["init", "-q", cwd])
	return { root, cwd, agentDir: join(root, "agent") }
}

function run(agentDir: string, script: string) {
	return JSON.parse(
		execFileSync("bun", ["--eval", script], {
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			timeout: 30_000,
		}).trim(),
	)
}

function files(directory: string, prefix = ""): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const name = join(prefix, entry.name)
		return entry.isDirectory() ? files(join(directory, entry.name), name) : [name]
	})
}

afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

it("reopens tracked edits, immutable scope and issue notes without automatic JSON tracker files", () => {
	const { cwd, agentDir } = fixture()
	const scope = {
		repository: join(cwd, ".git"),
		account: { apiUrl: "https://example.invalid/api", organizationId: ORG, userId: USER },
	}
	const result = run(
		agentDir,
		`
import { createTrackedWriteTool } from ${moduleUrl("./file-transitions.ts")};
import { setWorkId } from ${moduleUrl("../work-attribution.ts")};
import { saveNewWorkScope, readWorkScope } from ${moduleUrl("./scope.ts")};
import { changeWorkIssue } from ${moduleUrl("./issues.ts")};
import { readWorkRecords } from ${moduleUrl("./summary.ts")};
const ctx = { cwd: ${JSON.stringify(cwd)}, sessionManager: { getSessionId: () => "bookkeeping" } };
setWorkId(ctx, ${JSON.stringify(WORK)});
saveNewWorkScope(${JSON.stringify(WORK)}, ${JSON.stringify(scope)});
saveNewWorkScope(${JSON.stringify(WORK)}, { ...${JSON.stringify(scope)}, repository: "must-not-replace" });
changeWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(WORK)}, "bookkeeping", "ABC-123");
await createTrackedWriteTool(ctx, "write").execute("write", { path: "native.txt", content: "native evidence" });
console.log(JSON.stringify({ scope: readWorkScope(${JSON.stringify(WORK)}), transitions: readWorkRecords(${JSON.stringify(agentDir)}).filter(row => row.type === "file_transition").length }));
`,
	)
	expect(result).toEqual({ scope, transitions: 1 })
	const reopened = run(
		agentDir,
		`
import { readWorkScope } from ${moduleUrl("./scope.ts")};
import { readWorkIssue } from ${moduleUrl("./issues.ts")};
import { readWorkRecords } from ${moduleUrl("./summary.ts")};
console.log(JSON.stringify({ scope: readWorkScope(${JSON.stringify(WORK)}), issue: readWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(WORK)}), transitions: readWorkRecords(${JSON.stringify(agentDir)}).filter(row => row.type === "file_transition").length }));
`,
	)
	expect(reopened).toEqual({ scope, issue: { revision: 1, selected: { key: "ABC-123", revision: 1 } }, transitions: 1 })
	expect(files(agentDir).filter((path) => /\.jsonl?$/.test(path))).toEqual([])
	expect(files(agentDir)).toContain(join("pr-cost-reporting", "ledger.db"))
})

it("keeps legacy scope and issue inputs byte-identical while new selections move to notes", () => {
	const { cwd, agentDir } = fixture()
	const directory = join(agentDir, "work", WORK)
	mkdirSync(directory, { recursive: true })
	const scope = JSON.stringify({
		version: 1,
		workId: WORK,
		account: { apiUrl: "https://example.invalid/api", organizationId: ORG, userId: USER },
		repository: join(cwd, ".git"),
	})
	const issue = JSON.stringify({
		version: 1,
		workId: WORK,
		revision: 7,
		issueKey: "ABC-7",
		sessionId: "legacy",
		recordedAt: "2026-10-01T00:00:00Z",
	})
	writeFileSync(join(directory, "scope.json"), scope)
	writeFileSync(join(directory, "issue.json"), issue)
	const result = run(
		agentDir,
		`
import { readWorkScope, saveNewWorkScope } from ${moduleUrl("./scope.ts")};
import { readWorkIssue, changeWorkIssue } from ${moduleUrl("./issues.ts")};
const before = readWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(WORK)});
saveNewWorkScope(${JSON.stringify(WORK)}, { account: { apiUrl: "https://other.invalid", organizationId: ${JSON.stringify(ORG)}, userId: ${JSON.stringify(USER)} }, repository: "must-not-replace" });
changeWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(WORK)}, "new", "ABC-8");
console.log(JSON.stringify({ before, after: readWorkIssue(${JSON.stringify(agentDir)}, ${JSON.stringify(WORK)}), scope: readWorkScope(${JSON.stringify(WORK)}) }));
`,
	)
	expect(result.before).toEqual({ revision: 7, selected: { key: "ABC-7", revision: 7 } })
	expect(result.after).toEqual({ revision: 8, selected: { key: "ABC-8", revision: 8 } })
	expect(result.scope.repository).toBe(join(cwd, ".git"))
	expect(readFileSync(join(directory, "scope.json"), "utf8")).toBe(scope)
	expect(readFileSync(join(directory, "issue.json"), "utf8")).toBe(issue)
})

it.each([false, true])("opens the advertised full report from DB authority (stale legacy report: %s)", (legacy) => {
	const { root, agentDir } = fixture()
	const reference = join(root, "reference.json")
	writeFileSync(reference, "[]")
	const stalePath = join(agentDir, "work", WORK, "costs.json")
	if (legacy) {
		mkdirSync(join(agentDir, "work", WORK), { recursive: true })
		writeFileSync(stalePath, "stale legacy report")
	}
	const result = run(
		agentDir,
		`
import { setNote, capture } from ${moduleUrl("../pr-cost-reporting/ledger/records.ts")};
import { workCostDetails, workCostTotals } from ${moduleUrl("./cost-details.ts")};
import { readWorkBrowser } from ${moduleUrl("./browser.ts")};
import { runCli } from ${moduleUrl("./accuracy-cli.ts")};
const agentDir = ${JSON.stringify(agentDir)};
const workId = ${JSON.stringify(WORK)};
const report = { workId, requests: [], pullRequests: [] };
setNote(agentDir, workId, "costs", JSON.stringify(report));
setNote(agentDir, workId, "cost-totals", JSON.stringify(workCostTotals(report)));
capture(agentDir, { version: 1, type: "work", sessionId: "report", workId }, "fixture");
const source = workCostDetails(agentDir, workId).find(line => line.startsWith("Cost details: ")).slice("Cost details: ".length);
const browser = await readWorkBrowser(agentDir, { workId, lines: [] });
console.log(JSON.stringify({ source, outcome: runCli([source, ${JSON.stringify(reference)}]), browser: browser.rows[0].details }));
`,
	)
	expect(result.source).toBe(`ledger:${WORK}`)
	expect(result.outcome.code).toBe(2)
	expect(result.outcome.stderr).toEqual([])
	expect(result.outcome.stdout).toContain("Incomplete — no requests to compare")
	expect(result.browser).toContain(`Cost details: ${result.source}`)
	if (legacy) expect(readFileSync(stalePath, "utf8")).toBe("stale legacy report")
	else expect(files(agentDir).some((path) => path.endsWith("costs.json"))).toBe(false)
})
