/**
 * E2E TUI test: image-bearing `auto` requests are admitted without an
 * automatic token budget.
 *
 * Incident (2026-10-06): an `auto` request moved from DeepSeek V4 Flash to
 * Kimi-K3 when an image entered the conversation, and the upstream-generated
 * alias budget (`max_completion_tokens: 512000` from the alias's advertised
 * metadata) was rejected by the serving destination
 * ("max_completion_tokens is too large: 512000. This model supports at most
 * 262144 completion tokens.").
 *
 * The alias-budget adapter must remove the automatically supplied token
 * fields at the provider stream boundary, so the request is admitted with
 * backend-default output sizing. Asserts on the actual outgoing body and the
 * user-visible completion.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// The alias advertises the incident metadata: a 512000-token output budget on
// a 1M window. Without prevention the wire carries ~512000; with prevention
// neither token field is sent.
const AUTO_MODEL: FakeModel = {
	slug: "auto",
	displayName: "Auto",
	provider: "ai-enabler",
	input: ["text", "image"],
	contextWindow: 1_048_576,
	maxTokens: 512_000,
}

function chatRequests(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => request.body as Record<string, unknown>)
}

test("image-bearing auto request is admitted without an automatic token budget", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "auto-budget-admission",
			providerId: "kimchi-dev",
			initialModel: "auto",
			models: [AUTO_MODEL],
			responses: [{ stream: ["I can see your typed image."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.write("cat.png what's this?")
			terminal.submit("")
			trace.step("submitted image prompt to auto")

			// User-visible completion: the image was attached and answered.
			await waitForText(terminal, "[Image #1]", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "I can see your typed image.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("auto answered the image prompt")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBeGreaterThanOrEqual(1)
			const imageRequest = bodies.find((body) => JSON.stringify(body).includes('"image_url"'))
			expect(imageRequest).toBeDefined()
			trace.step("image payload reached the backend")

			// The incident regression: no automatically supplied output budget
			// rides the routed-alias request. Backend defaults apply instead.
			expect(imageRequest?.max_completion_tokens).toBeUndefined()
			expect(imageRequest?.max_tokens).toBeUndefined()
			trace.step("no automatic token budget on the wire")
		},
	)
})
