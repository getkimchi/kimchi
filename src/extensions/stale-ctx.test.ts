import { describe, expect, it } from "vitest"
// Contract test: the stale-listener auto-removal in todos/store.ts relies on
// recognizing pi-mono's stale-runtime error by message prefix. Construct the
// REAL error from the installed pi-mono so a wording change in the dependency
// fails CI here instead of silently degrading auto-removal (the try/catch
// isolation keeps working, but leaked listeners would spam console.error
// forever with no failing test). The package's exports map blocks deep
// imports, so import the file by relative path — deliberately, and pinned by
// this test's purpose.
import { createExtensionRuntime } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
import { isStaleCtxError } from "./stale-ctx.js"

describe("isStaleCtxError", () => {
	it("detects the actual error thrown by an invalidated pi-mono extension runtime", () => {
		const runtime = createExtensionRuntime()
		runtime.invalidate() // default message = pi-mono's current stale wording

		let thrown: unknown
		try {
			runtime.assertActive()
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect(isStaleCtxError(thrown)).toBe(true)
	})

	it("rejects non-stale errors and non-Error values", () => {
		expect(isStaleCtxError(new Error("boom"))).toBe(false)
		expect(isStaleCtxError(new Error("This file is stale"))).toBe(false)
		expect(isStaleCtxError("This extension ctx is stale …")).toBe(false)
		expect(isStaleCtxError(undefined)).toBe(false)
	})
})
