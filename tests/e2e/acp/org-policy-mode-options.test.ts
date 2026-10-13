/**
 * E2E ACP test: the org policy shapes the permissions-mode session config
 * option on the ACP surface.
 *
 * The fake platform serves a policy allowing only default + plan. The
 * advertised `permissions-mode` select carries exactly those options (auto and
 * yolo are not offered to the client), selecting an allowed mode works, and
 * selecting a disallowed mode is rejected with the policy message. The initial
 * mode resolves to the config default (default), which is policy-allowed.
 */

import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

describe("org-policy permissions-mode config option", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it("advertises only the policy-allowed modes and rejects a disallowed set", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-org-policy-mode-options",
			policy: { modes: { plan: true, default: true, auto: false, yolo: false } },
			responses: [{ stream: ["ACP policy works."] }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		const result = await prompt(fixture, session.sessionId, "Check the policy surface")
		expect(result.stopReason).toBe("end_turn")

		// The advertised select carries exactly the allowed modes.
		const updates = fixture.client.sessionUpdates.filter(
			({ update }) => update.sessionUpdate === "config_option_update",
		)
		const modeOptions = updates.flatMap(({ update }) => {
			const option = (update as { configOptions: acp.SessionConfigOption[] }).configOptions.find(
				(opt) => opt.id === "permissions-mode",
			)
			if (option?.type !== "select") return []
			return option.options.map((o) => ("value" in o ? o.value : undefined))
		})
		expect(modeOptions).toContain("default")
		expect(modeOptions).toContain("plan")
		expect(modeOptions).not.toContain("auto")
		expect(modeOptions).not.toContain("yolo")

		// Selecting an allowed mode succeeds.
		await fixture.conn.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "permissions-mode",
			value: "plan",
		})

		// Selecting a disallowed mode is rejected with the policy message.
		await expect(
			fixture.conn.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "permissions-mode",
				value: "yolo",
			}),
		).rejects.toThrow(/organization's policy/)
	})
})
