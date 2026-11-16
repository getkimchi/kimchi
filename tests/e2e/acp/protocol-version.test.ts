// ACP integration: the negotiated protocolVersion on the wire must equal the
// SDK's PROTOCOL_VERSION constant. Protocol-version drift surfaces at real
// clients as "client out of date", not in CI (docs/acp-compat.md rule 8) —
// this pin gives an upstream bump a named failure instead.

import * as acp from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"

describe("ACP integration — protocol version pin", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "protocol-version",
			responses: [],
		})
	})

	afterEach(async () => {
		await fixture.stop()
	})

	it("negotiates exactly the SDK's PROTOCOL_VERSION", async () => {
		expect(
			fixture.initializeResponse.protocolVersion,
			"negotiated protocolVersion must equal the SDK constant — bump the pin deliberately when the SDK changes",
		).toBe(acp.PROTOCOL_VERSION)
	})
})
