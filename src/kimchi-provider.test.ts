// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { isKimchiProvider } from "./kimchi-provider.js"

describe("isKimchiProvider", () => {
	it.each(["kimchi-dev", "kimchi-dev/openai", "kimchi-experimental"])("recognizes %s as Kimchi-managed", (provider) => {
		expect(isKimchiProvider(provider)).toBe(true)
	})

	it.each(["kimchi", "kimchi-development", "openai"])("does not match unrelated provider %s", (provider) => {
		expect(isKimchiProvider(provider)).toBe(false)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
