import { describe, expect, it } from "vitest"
import { startReviewServer } from "./review-server.js"

async function post(url: string, body: unknown): Promise<Response> {
	return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

describe("startReviewServer", () => {
	it("serves the html on the token path only and 404s everything else", async () => {
		const server = await startReviewServer({ html: "<html>a review</html>" })
		try {
			const page = await fetch(server.url)
			expect(page.status).toBe(200)
			expect(await page.text()).toBe("<html>a review</html>")

			const origin = new URL(server.url).origin
			const wrongPath = await fetch(`${origin}/not-the-token/`)
			expect(wrongPath.status).toBe(404)
			const decisionWithoutToken = await post(`${origin}/decision`, {})
			expect(decisionWithoutToken.status).toBe(404)
		} finally {
			await server.close()
		}
	})

	it("resolve with an approve decision on POST, then shuts down (one-shot)", async () => {
		const server = await startReviewServer({ html: "<html>x</html>" })
		const res = await post(`${server.url}decision`, { action: "approve" })
		expect(res.status).toBe(200)
		expect(await server.decision).toEqual({ kind: "approve" })
		// Second decision is rejected — first decision wins.
		const dup = await post(`${server.url}decision`, { action: "closed" })
		expect(dup.status).toBe(409)
	})

	it("parses request-changes payloads, keeping only well-formed comments", async () => {
		const server = await startReviewServer({ html: "<html>x</html>" })
		await post(`${server.url}decision`, {
			action: "request-changes",
			summary: "nope",
			comments: [
				{ file: "a.ts", line: 3, side: "new", code: "x", text: "fix this" },
				{ file: "b.ts" }, // no text → dropped
				"garbage",
			],
		})
		expect(await server.decision).toEqual({
			kind: "request-changes",
			summary: "nope",
			comments: [{ file: "a.ts", line: 3, side: "new", code: "x", text: "fix this" }],
		})
	})

	it("malformed/unknown bodies resolve as the closed (back-to-menu) decision", async () => {
		const server = await startReviewServer({ html: "<html>x</html>" })
		await fetch(`${server.url}decision`, { method: "POST", body: "not-json{{" })
		expect(await server.decision).toEqual({ kind: "closed" })
	})
})
