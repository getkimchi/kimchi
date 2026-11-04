// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ loads: 0 }))

// An unrelated suite must not need the ledger's SDK dependency graph merely to run.
vi.mock("@earendil-works/pi-coding-agent", () => {
	sdk.loads++
	throw new Error("This suite does not use the SDK or ledger")
})

it.each([1, 2])("does not import the ledger dependencies in an unrelated test (%i)", () => {
	expect(sdk.loads).toBe(0)
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
