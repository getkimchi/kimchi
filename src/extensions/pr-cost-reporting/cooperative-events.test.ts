import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import type { CommonEvents } from "./events.js"
import type { StoredRecord } from "./ledger/records.js"
import type { RepositoryIdentity } from "./snapshot.js"

const account = {
	apiUrl: "https://api.lumbrook.invalid",
	organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}
const repository = "/lumbrook/platform/.git"
const repositories = new Map<string, RepositoryIdentity>([
	[repository, { provider: "github", host: "github.com", id: "4242", name: "lumbrook/platform" }],
])
const works = ["22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"]
const producer = "33333333-3333-4333-8333-333333333333"
function history(seed: number): WorkRecord[] {
	let random = seed
	const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0)
	const rows: WorkRecord[] = []
	const count = 3 + (next() % 9)
	for (let index = 0; index < count; index++) {
		const requestId = `11111111-1111-4111-8111-${(seed * 32 + index).toString(16).padStart(12, "0")}`
		const workId = works[next() % works.length]
		const startedAt = new Date(Date.UTC(2026, 9, 24, 8, 0, index)).toISOString()
		const base = { version: 1 as const, workId, sessionId: `lumbrook-session-${workId}`, requestId }
		rows.push(
			{ ...base, type: "request", startedAt, recordedAt: startedAt, scope: { account, repository } },
			{ ...base, type: "request_dispatch", startedAt, dispatchedAt: startedAt, recordedAt: startedAt },
		)
	}
	return rows
}

function storedRecords(rows: readonly WorkRecord[]): StoredRecord[] {
	return rows.map((row, index) => {
		const body = JSON.stringify(row)
		return {
			recordHash: createHash("sha256").update(`${index}\0${body}`).digest("hex"),
			type: row.type,
			workId: row.workId,
			sessionId: row.sessionId,
			body,
			sourcePath: null,
			sourceGeneration: 0,
			sourceOffset: null,
			importedAt: 0,
		}
	})
}

it("keeps cooperative full and touched event bytes equal to randomized from-scratch histories", () => {
	const histories = Array.from({ length: 24 }, (_, index) => {
		const rows = history(index + 1)
		const changed = rows.at(-1)?.requestId
		if (typeof changed !== "string") throw new Error("Missing randomized request")
		return {
			rows,
			stored: storedRecords(rows),
			report: calculatePullRequestCosts(rows, []),
			repositories: [...repositories],
			producer,
			changed,
		}
	})
	const output = execFileSync(
		"bun",
		[
			"--eval",
			`
import { buildEvents, buildEventsSteps } from ${JSON.stringify(new URL("./events.ts", import.meta.url).href)};
import { runCooperatively } from ${JSON.stringify(new URL("../work-attribution/cooperative.ts", import.meta.url).href)};
const histories = await Bun.stdin.json();
const results = [];
for (const { rows, stored, report, repositories, producer, changed } of histories) {
  const check = () => {};
  const noClaim = () => undefined;
  const identities = new Map(repositories);
  const full = buildEvents(stored, report, identities, producer, check, noClaim);
  const cooperative = await runCooperatively(
    buildEventsSteps(stored, report, identities, producer, check, noClaim, undefined, rows), check, 0,
  );
  const touched = { requests: new Set([changed]), records: new Set(stored.slice(-2).map((row) => row.recordHash)) };
  const incremental = await runCooperatively(
    buildEventsSteps(stored, report, identities, producer, check, noClaim, touched, rows), check, 0,
  );
  results.push({ full: JSON.stringify(full), cooperative: JSON.stringify(cooperative),
    incremental: JSON.stringify(incremental), changed });
}
console.log(JSON.stringify(results));
`,
		],
		{ input: JSON.stringify(histories), encoding: "utf8", timeout: 30_000 },
	)
	const results = JSON.parse(output) as {
		full: string
		cooperative: string
		incremental: string
		changed: string
	}[]
	expect(results).toHaveLength(histories.length)
	for (const [index, result] of results.entries()) {
		expect(result.cooperative).toBe(result.full)
		const full = JSON.parse(result.full) as CommonEvents
		const incremental = JSON.parse(result.incremental) as CommonEvents
		expect(histories[index].report.requests).toHaveLength(histories[index].rows.length / 2)
		expect(full.unresolved).toEqual([])
		expect(full.units).toHaveLength(histories[index].rows.length / 2)
		expect(JSON.stringify(incremental.accounts)).toBe(JSON.stringify(full.accounts))
		expect(JSON.stringify(incremental.units)).toBe(
			JSON.stringify(full.units.filter((unit) => unit.requestId === result.changed)),
		)
		expect(JSON.stringify(incremental.unresolved)).toBe(
			JSON.stringify(full.unresolved.filter((unit) => unit.requestId === result.changed)),
		)
	}
})
