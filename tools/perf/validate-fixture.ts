// Validate the generated aged fixture with the product's own validators.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import type { WireSnapshot } from "../../src/extensions/pr-cost-reporting/snapshot.js"
import { validateSnapshot } from "../../src/extensions/pr-cost-reporting/snapshot.js"

interface FixtureAccount {
	apiUrl: string
	organizationId: string
	userId: string
}

interface FixtureRepository {
	provider: string
	host: string
	id: string
}

interface FixtureEntry {
	// revision is a string in the product's state-entry shape (queue.ts)
	revision: string
	account: FixtureAccount
	repository: FixtureRepository
	pending: WireSnapshot
}

interface FixtureState {
	entries: Record<string, FixtureEntry>
}

interface FrozenNote {
	id: string
	key: string
	body: string
	entry: {
		account: FixtureAccount
		repository: FixtureRepository
		pending?: WireSnapshot
	}
}

const pc = process.argv[2]
const state = JSON.parse(readFileSync(`${pc}/state.json`, "utf8")) as FixtureState
let bad = 0

for (const [key, entry] of Object.entries(state.entries)) {
	// accountKey/repositoryKey serialize the field arrays, not the objects
	const expected = `${JSON.stringify([entry.account.apiUrl, entry.account.organizationId, entry.account.userId])}:${JSON.stringify([entry.repository.provider, entry.repository.host, entry.repository.id])}`
	if (key !== expected) {
		console.log(`entry key mismatch: ${key} != ${expected}`)
		bad++
	}
	try {
		validateSnapshot(entry.pending)
	} catch (error) {
		console.log(`validateSnapshot threw: ${(error as Error).message}`)
		bad++
	}
	if (entry.pending.revision !== entry.revision) {
		console.log("revision mismatch")
		bad++
	}
}
console.log(`state.json: ${Object.keys(state.entries).length} entries, ${bad} problems`)

const db = new DatabaseSync(`${pc}/ledger.db`, { readOnly: true })
const rows = db.prepare(`select name, body from bookkeeping where work_id = 'legacy-pr-cost-snapshots'`).all() as {
	name: string
	body: string
}[]
let frozenBad = 0
const account = Object.values(state.entries)[0].account
const accountKey = JSON.stringify([account.apiUrl, account.organizationId, account.userId])
for (const row of rows) {
	const value = JSON.parse(String(row.body)) as FrozenNote
	if (value.id !== row.name) {
		console.log("frozen id != note name")
		frozenBad++
	}
	const id = createHash("sha256").update(`${accountKey}\0${value.body}`).digest("hex")
	if (id !== value.id) {
		console.log("frozen id derivation mismatch")
		frozenBad++
	}
	try {
		validateSnapshot(JSON.parse(value.body) as WireSnapshot)
	} catch (error) {
		console.log(`frozen body failed validateSnapshot: ${(error as Error).message}`)
		frozenBad++
	}
	// The wrapper itself must satisfy decodeFrozen's contract (queue.ts):
	// its key is a full state-entry key, the entry carries no pending field,
	// and the body round-trips byte-identically through JSON.stringify.
	const expectedKey = `${JSON.stringify([value.entry.account.apiUrl, value.entry.account.organizationId, value.entry.account.userId])}:${JSON.stringify([value.entry.repository.provider, value.entry.repository.host, value.entry.repository.id])}`
	if (value.key !== expectedKey) {
		console.log("frozen wrapper key is not the state-entry key (decodeFrozen would throw)")
		frozenBad++
	}
	if (value.entry.pending !== undefined) {
		console.log("frozen entry still carries a pending field")
		frozenBad++
	}
	if (JSON.stringify(JSON.parse(value.body)) !== value.body) {
		console.log("frozen body does not round-trip through JSON.stringify")
		frozenBad++
	}
}
console.log(`frozen notes: ${rows.length} rows, ${frozenBad} problems`)
process.exit(bad + frozenBad > 0 ? 1 : 0)
