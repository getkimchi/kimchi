// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import config from "../vitest.config.js"

describe("Vitest configuration", () => {
	it("excludes generated TUI test caches at every depth", () => {
		expect(config).toMatchObject({
			test: { exclude: expect.arrayContaining(["**/.tui-test/**"]) },
		})
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
