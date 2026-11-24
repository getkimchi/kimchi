import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { startAcpFixture } from "./support/acp-fixture.js"

describe("ACP startup OAuth catalog discovery", () => {
	it("refreshes and persists stored OAuth before initializing with the replacement catalog bearer", async () => {
		const fixture = await startAcpFixture({
			artifactName: "oauth-catalog-discovery",
			responses: [],
			oauth: { refreshedAccessToken: "replacement-fake-access" },
		})

		try {
			const discoveryRequests = fixture.fake.requests.filter(
				(request) => request.url === "/oauth/token" || request.url.startsWith("/v1/models/metadata"),
			)
			expect(discoveryRequests.map((request) => request.url)).toEqual([
				"/oauth/token",
				"/v1/models/metadata?include_in_cli=true",
			])
			expect(discoveryRequests[1]?.headers.authorization).toBe("Bearer replacement-fake-access")
			expect(discoveryRequests[1]?.headers["x-castai-organization-id"]).toBe("fake-org")

			const authPath = join(fixture.homeDir, ".config", "kimchi", "harness", "auth.json")
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>
			expect(auth["kimchi-dev"]).toMatchObject({
				type: "oauth",
				access: "replacement-fake-access",
				refresh: "fake-refresh",
				orgId: "fake-org",
			})
		} finally {
			await fixture.stop()
		}
	})
})
