import { afterEach, describe, expect, it } from "vitest"
import { resetRedactionConfigCache } from "../pii-redaction/config.js"
import { prepareRouterQuery } from "./router-query.js"

afterEach(() => {
	delete process.env.KIMCHI_REDACTION_ENABLED
	resetRedactionConfigCache()
})

describe("prepareRouterQuery", () => {
	it("rejects an empty text prompt", async () => {
		await expect(prepareRouterQuery(" \n ")).resolves.toEqual({ ok: false, reason: "empty_prompt" })
	})

	it("redacts the router copy without changing the original prompt", async () => {
		process.env.KIMCHI_REDACTION_ENABLED = "1"
		resetRedactionConfigCache()
		const original = "Contact john.doe@example.com about this task"

		const result = await prepareRouterQuery(original)

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.query).not.toContain("john.doe@example.com")
			expect(result.query).toContain("[REDACTED-EMAIL_ADDRESS]")
		}
		expect(original).toContain("john.doe@example.com")
	})

	it("keeps the full prompt when it exceeds the former router token budget", async () => {
		process.env.KIMCHI_REDACTION_ENABLED = "0"
		resetRedactionConfigCache()
		const original = `BEGIN-${"routertoken ".repeat(2_000)}-END`

		await expect(prepareRouterQuery(original)).resolves.toEqual({ ok: true, query: original })
	})
})
