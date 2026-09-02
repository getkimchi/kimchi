import { afterEach, describe, expect, it, vi } from "vitest"
import { resetRedactionConfigCache } from "../pii-redaction/config.js"
import * as redactor from "../pii-redaction/redactor.js"
import { prepareRouterQuery, ROUTER_IMAGE_METADATA } from "./router-query.js"

afterEach(() => {
	delete process.env.KIMCHI_REDACTION_ENABLED
	resetRedactionConfigCache()
	vi.restoreAllMocks()
})

describe("prepareRouterQuery", () => {
	it("rejects an empty text prompt", async () => {
		await expect(prepareRouterQuery(" \n ")).resolves.toEqual({ ok: false, reason: "empty_prompt" })
	})

	it("appends image metadata to the router copy of a text prompt", async () => {
		await expect(prepareRouterQuery("Explain this screenshot", { containsImages: true })).resolves.toEqual({
			ok: true,
			query: `Explain this screenshot\n\n${ROUTER_IMAGE_METADATA}`,
		})
	})

	it("uses image metadata as the router query for an image-only prompt", async () => {
		await expect(prepareRouterQuery("", { containsImages: true })).resolves.toEqual({
			ok: true,
			query: ROUTER_IMAGE_METADATA,
		})
	})

	it("refuses to route when the router copy cannot be redacted", async () => {
		process.env.KIMCHI_REDACTION_ENABLED = "1"
		resetRedactionConfigCache()
		vi.spyOn(redactor, "redactTextOrThrow").mockRejectedValue(new Error("redaction engine unavailable"))

		// Routing must stop rather than fall back to the unredacted prompt.
		await expect(prepareRouterQuery("Contact john.doe@example.com", { containsImages: true })).resolves.toEqual({
			ok: false,
			reason: "redaction_failed",
		})
	})

	it("redacts the router copy without changing the original prompt", async () => {
		process.env.KIMCHI_REDACTION_ENABLED = "1"
		resetRedactionConfigCache()
		const original = "Contact john.doe@example.com about this task"

		const result = await prepareRouterQuery(original, { containsImages: true })

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.query).not.toContain("john.doe@example.com")
			expect(result.query).toContain("[REDACTED-EMAIL_ADDRESS]")
			expect(result.query.endsWith(ROUTER_IMAGE_METADATA)).toBe(true)
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
