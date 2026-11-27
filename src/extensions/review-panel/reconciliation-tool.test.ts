import { describe, expect, it } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createReconciliationSubmissionExtension, REVIEW_RECONCILIATION_TOOL } from "./reconciliation-tool.js"
import { REVIEW_RECONCILIATION_VERSION, type SemanticReconciliation } from "./types.js"

describe("submit_reconciliation", () => {
	it("captures schema-shaped structured input without writing an artifact", async () => {
		const bridge: { value?: SemanticReconciliation } = {}
		const harness = createExtensionApi()
		createReconciliationSubmissionExtension(bridge)(harness.api)
		const tool = harness.getRegisteredTool(REVIEW_RECONCILIATION_TOOL)
		expect(tool.name).toBe(REVIEW_RECONCILIATION_TOOL)
		const value = {
			schema_version: REVIEW_RECONCILIATION_VERSION,
			findings: [],
			decisions: [],
			threads: [],
		}
		const controller = new AbortController()
		await tool.execute("call-1", value, controller.signal, undefined, createToolContext())
		expect(bridge.value).toEqual(value)
	})
})
