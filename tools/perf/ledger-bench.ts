// Standalone ledger-operation benchmark. Runs under bun against the tree it
// lives in, importing that tree's own unmodified ledger modules: the same
// product-representative paths a reconcile pass takes, at the gate's ledger
// scale. This file never reads counters itself — the parent process
// (ledger-bench-run.py) attaches the hardware instruction counter externally
// and reads it at the BENCH_OP markers printed here. Feature detection picks
// each tree's own path: a tree without the batched/projection APIs is
// measured through its per-entity/full-decode path, exactly as its product
// code calls them.
//
// Usage: bun tools/perf/ledger-bench.ts <agentDir>
// Scale: KIMCHI_BENCH_RECORDS (100000), KIMCHI_BENCH_ENTITIES (5000),
//        KIMCHI_BENCH_REPOS (20), KIMCHI_BENCH_REPS (3).

import { createHash, randomUUID } from "node:crypto"
import { writeSync } from "node:fs"
import * as ledgerOutbox from "../../src/extensions/pr-cost-reporting/ledger/outbox.js"
import * as ledgerRecords from "../../src/extensions/pr-cost-reporting/ledger/records.js"
import type { Event } from "../../src/extensions/pr-cost-reporting/protocol.js"
import { encodeEvent, eventKind } from "../../src/extensions/pr-cost-reporting/protocol.js"
import golden from "../../src/extensions/pr-cost-reporting/protocol-golden.json" with { type: "json" }

const agentDir = process.argv[2]
if (!agentDir) {
	console.error("usage: bun tools/perf/ledger-bench.ts <agentDir>")
	process.exit(2)
}
const RECORDS = Number(process.env.KIMCHI_BENCH_RECORDS ?? 100_000)
const ENTITIES = Number(process.env.KIMCHI_BENCH_ENTITIES ?? 5_000)
const REPOS = Number(process.env.KIMCHI_BENCH_REPOS ?? 20)
const REPS = Number(process.env.KIMCHI_BENCH_REPS ?? 3)

// Tree-native capability: the fix branch exports the batched claim read and
// the distinct-repository projection; an unfixed tree runs its own per-entity
// and full-decode paths. Both are the paths the product actually calls.
const distinctRepositories = (
	ledgerRecords as {
		readTransitionRepositories?: (agentDir: string) => string[]
	}
).readTransitionRepositories
const batchedClaims = (
	ledgerOutbox as {
		effectiveClaims?: (
			backend: ledgerRecords.RecordBackend,
			accountKey: string,
			entityIds: readonly string[],
		) => ReadonlyMap<string, Event | undefined>
	}
).effectiveClaims

const mark = (line: string): void => {
	writeSync(1, `${line}\n`)
}
const fail = (reason: string): never => {
	mark(`BENCH_ERROR ${reason}`)
	process.exit(1)
}

/** Repository discovery: this tree's own discovery path over the same data. */
function discoverRepositories(): string[] {
	if (distinctRepositories) return distinctRepositories(agentDir)
	const repositories = new Set<string>()
	for (const row of ledgerRecords.readRecords(agentDir, { type: "file_transition" })) {
		if (typeof row.repository === "string") repositories.add(row.repository)
	}
	return [...repositories].sort()
}

/** Claim resolution for every entity: this tree's own calling convention. */
function resolveClaims(entities: readonly string[]): number {
	const backend = ledgerRecords.backendFor(agentDir)
	if (batchedClaims) {
		let resolved = 0
		for (const claim of batchedClaims(backend, "account", entities).values()) {
			if (claim !== undefined) resolved++
		}
		return resolved
	}
	let resolved = 0
	for (const entity of entities) {
		if (ledgerOutbox.effectiveClaim(backend, "account", entity) !== undefined) resolved++
	}
	return resolved
}

const entities = Array.from({ length: ENTITIES }, () => randomUUID())
const seed = {
	...structuredClone((golden as { events: { input: Event }[] }).events[0].input),
	deviceId: randomUUID(),
}

mark(
	`BENCH_INFO mode repositories=${distinctRepositories ? "distinct-projection" : "typed-full-decode"} ` +
		`claims=${batchedClaims ? "batch-per-account" : "one-query-per-entity"}`,
)
mark(`BENCH_INFO scale records=${RECORDS} entities=${ENTITIES} repositories=${REPOS} reps=${REPS}`)
mark("BENCH_SEED begin")
const backend = ledgerRecords.backendFor(agentDir)
backend.tx(() => {
	for (let index = 0; index < RECORDS; index++) {
		backend.insertRecord({
			recordHash: `bench-${index}`,
			type: "file_transition",
			workId: "bench-work",
			sessionId: "bench-session",
			body: JSON.stringify({
				version: 1,
				repository: `/repo-${index % REPOS}`,
				path: `file-${index}.ts`,
				recordedAt: index,
			}),
			sourcePath: "bench",
			sourceGeneration: 0,
			sourceOffset: null,
			importedAt: index,
		})
	}
	for (let index = 0; index < ENTITIES; index++) {
		const event = { ...seed, id: randomUUID(), entityId: entities[index] } as Event
		const body = Buffer.from(encodeEvent(event))
		backend.insertOutboxEvent({
			id: event.id,
			accountKey: "account",
			entityId: entities[index],
			kind: eventKind(event),
			body,
			hash: createHash("sha256").update(body).digest("hex"),
			createdAt: index,
			ackedAt: null,
			blocked: "",
		})
	}
})
mark("BENCH_SEED end")

// One unmarked warmup rep, then measured reps the harness brackets.
discoverRepositories()
resolveClaims(entities)
for (let rep = 0; rep < REPS; rep++) {
	mark(`BENCH_OP repositories ${rep} begin`)
	const repositories = discoverRepositories()
	mark(`BENCH_OP repositories ${rep} end`)
	if (repositories.length !== REPOS) fail(`repositories: expected ${REPOS}, got ${repositories.length}`)
	mark(`BENCH_OP claims ${rep} begin`)
	const resolved = resolveClaims(entities)
	mark(`BENCH_OP claims ${rep} end`)
	if (resolved !== ENTITIES) fail(`claims: expected ${ENTITIES}, got ${resolved}`)
}
ledgerRecords.closeBackends()
mark("BENCH_DONE")
