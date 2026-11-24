import { afterEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import reviewSubmitExtension from "./index.js"

describe("reviewSubmitExtension", () => {
	afterEach(() => vi.unstubAllEnvs())

	it("does not register review tools in an ordinary session", () => {
		vi.stubEnv("REVIEW_WRITER", "")
		const harness = createExtensionApi()
		reviewSubmitExtension(harness.api)
		expect(harness.getRegisteredTools()).toEqual([])
	})

	it("registers all three tools when comments.json is absent", () => {
		vi.stubEnv("REVIEW_WRITER", "final")
		vi.stubEnv("HOME", process.env.HOME)
		const harness = createExtensionApi()
		reviewSubmitExtension(harness.api)
		expect(harness.getActiveToolNames()).toEqual(["submit_finding", "submit_summary", "submit_reply"])
	})
})
