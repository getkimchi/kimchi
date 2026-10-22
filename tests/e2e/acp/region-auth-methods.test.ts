// ACP integration: region-pinned Agent Auth methods. The EU region is
// generally available, so `initialize` advertises `kimchi-agent-eu` without
// any experimental flag; `self-hosted` stays gated. Clients (kimchi-studio)
// show a region picker whenever at least two `kimchi-agent-*` methods are
// advertised, so this list is the rollout surface for EU region selection.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

describe("ACP integration — region auth methods", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "region-auth-methods",
			responses: [],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("advertises the EU companion method without the experimental flag; self-hosted stays gated", () => {
		const ids = fixture.initializeResponse.authMethods?.map((m) => m.id) ?? []
		expect(ids).toContain("kimchi-agent")
		expect(ids).toContain("kimchi-agent-us")
		expect(ids).toContain("kimchi-agent-eu")
		// Self-hosted remains behind --enable-experimental-features.
		expect(ids).not.toContain("kimchi-agent-self-hosted")
	})
})
