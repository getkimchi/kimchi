/**
 * E2E TUI test: corrective recovery for a rejected completion budget.
 *
 * A session whose request carries an oversized output budget (here: model
 * metadata the serving destination does not honor) is rejected by the backend
 * with the incident wording. The alias-budget adapter must lower the budget to
 * the stated ceiling and ride upstream's existing retry loop exactly once:
 *
 *   rejection → corrected outgoing retry → user-visible success
 *
 * without an intermediate terminal failure. A second, different cap rejection
 * after the corrected attempt must surface terminally instead of retrying
 * forever, and cancelling during the retry backoff must prevent further
 * attempts.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Metadata the serving destination does not honor: the request goes out with
// max_completion_tokens 512000 and the backend caps at 262144.
const INFLATED_MODEL: FakeModel = {
	slug: "kimi-k3",
	displayName: "Kimi K3",
	provider: "ai-enabler",
	input: ["text"],
	contextWindow: 1_048_576,
	maxTokens: 512_000,
}

const REJECTION_BODY = (cap: number, requested: number) => ({
	error: {
		message: `max_completion_tokens is too large: ${requested}.This model supports at most ${cap} completion tokens.`,
		type: "invalid_request_error",
		code: 400,
	},
})

function chatRequests(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => request.body as Record<string, unknown>)
}

/** Seeded retry settings for scenarios that need specific retry availability. */
function seedRetrySettings(retry: Record<string, unknown>) {
	return (homeDir: string) => {
		const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
		settings.retry = retry
		writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"))
		return {}
	}
}

test("oversized budget rejection is corrected once and the retried request succeeds", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-recovery",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [
				// First attempt: rejected with the incident wording.
				{ status: 400, body: REJECTION_BODY(262_144, 512_000) },
				// Corrective retry: admitted.
				{ stream: ["Recovered with the corrected budget."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt against the inflated-metadata model")

			// The corrected attempt succeeds and the user sees its completion —
			// no terminal failure ever renders for the corrected rejection.
			await waitForText(terminal, "Recovered with the corrected budget.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("corrected retry completed")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(2)
			// The first attempt carried the oversized metadata budget.
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			// The corrective retry carried the stated ceiling — never a raise.
			expect(bodies[1]?.max_completion_tokens).toBe(262_144)
			trace.step("outgoing budgets: 512000 rejected, 262144 corrected")

			// The raw provider rejection never reaches the terminal.
			expect(viewText(terminal)).not.toContain("max_completion_tokens is too large")
			expect(viewText(terminal)).not.toContain("262144 completion tokens")
			trace.step("raw rejection sanitized")
		},
	)
})

test("a second cap rejection after the corrected attempt surfaces terminally", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-second-rejection",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [
				// First attempt: rejected at 262144.
				{ status: 400, body: REJECTION_BODY(262_144, 512_000) },
				// Corrective retry: rejected again at a smaller ceiling.
				{ status: 400, body: REJECTION_BODY(131_072, 262_144) },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt; both attempts will be rejected")

			// Wait for BOTH attempts to leave (the corrective retry rides a 2s
			// backoff, so the terminal text alone can precede the second request).
			const attemptsDeadline = Date.now() + STREAM_TIMEOUT_MS
			while (chatRequests(fixture).length < 2 && Date.now() < attemptsDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 100))
			}
			trace.step("both attempts recorded")

			// The turn ends with the sanitized terminal error — no third attempt.
			await waitForText(terminal, "The request could not be completed", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("terminal error surfaced")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(2)
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			expect(bodies[1]?.max_completion_tokens).toBe(262_144)
			trace.step("exactly one corrective attempt was made")

			expect(viewText(terminal)).not.toContain("max_completion_tokens is too large")
			expect(viewText(terminal)).not.toContain("131072 completion tokens")
			trace.step("raw rejections sanitized")
		},
	)
})

test("cancelling during the corrective-retry backoff prevents further attempts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-cancel",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [{ status: 400, body: REJECTION_BODY(262_144, 512_000) }],
			// Long backoff makes the cancel window deterministic.
			seedHome: seedRetrySettings({ enabled: true, maxRetries: 3, baseDelayMs: 15_000 }),
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt; rejection lands, corrective retry is scheduled")

			// The retry placeholder proves the rejection was classified as a
			// corrective-retry in flight.
			await waitForText(terminal, "Retrying", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("corrective retry feedback visible")

			// Cancel during the backoff window.
			terminal.keyEscape()
			trace.step("pressed Escape during backoff")

			// The turn ends without a second request: the correction was
			// scheduled but never sent.
			await waitForTurnToSettle(fixture.fake.requests)
			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(1)
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			trace.step("no corrected attempt went out after cancellation")
		},
	)
})

test("a budget rejection surfaces terminally when retries are disabled", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-retries-disabled",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [{ status: 400, body: REJECTION_BODY(262_144, 512_000) }],
			// Retries off: no corrective attempt can run, so the rejection must
			// surface as the terminal sanitized error — not a retry placeholder.
			seedHome: seedRetrySettings({ enabled: false }),
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt; the rejection cannot be corrected")

			// The terminal sanitized error is the presentation — no "Retrying…"
			// placeholder, no retry spinner, no second request.
			await waitForText(terminal, "The request could not be completed", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(viewText(terminal)).not.toContain("Retrying")
			trace.step("terminal error visible, no retry presentation")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(1)
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			trace.step("exactly one request; no correction scheduled or sent")
		},
	)
})

test("a budget rejection surfaces terminally with zero retry attempts configured", async ({ terminal }) => {
	// {enabled: true, maxRetries: 0}: upstream's willRetry guard short-circuits
	// before the retry classifier runs, so no session verdict exists — the
	// availability-aware presentation alone decides. The rejection must render
	// as the terminal sanitized error, never as a "Retrying…" placeholder with
	// no retry and no notification behind it.
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-zero-retries",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [{ status: 400, body: REJECTION_BODY(262_144, 512_000) }],
			seedHome: seedRetrySettings({ enabled: true, maxRetries: 0 }),
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt; zero retry attempts configured")

			await waitForText(terminal, "The request could not be completed", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(viewText(terminal)).not.toContain("Retrying")
			trace.step("terminal error visible, no retry presentation")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(1)
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			trace.step("exactly one request; no correction scheduled or sent")
		},
	)
})

test("a transient failure on the corrected attempt keeps the corrected budget", async ({ terminal }) => {
	// The corrected attempt (262144) hits a retryable 500. Upstream retries the
	// same logical request — the reconstructed oversized budget must be lowered
	// again, so the wire shows 512000, 262144, 262144 and the turn completes.
	await runKimchiSession(
		terminal,
		{
			artifactName: "budget-cap-transient-after-correction",
			providerId: "kimchi-dev",
			initialModel: "kimi-k3",
			models: [INFLATED_MODEL],
			responses: [
				// First attempt: rejected with the incident wording.
				{ status: 400, body: REJECTION_BODY(262_144, 512_000) },
				// Corrective attempt: transient server failure.
				{ status: 500, body: { error: { message: "500 status code (internal server error)", code: 500 } } },
				// Upstream retry of the corrected request: admitted.
				{ stream: ["Recovered after the transient failure."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("Do the thing")
			trace.step("submitted prompt; rejection, then transient, then success")

			await waitForText(terminal, "Recovered after the transient failure.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn completed after the corrected retry")

			const bodies = chatRequests(fixture)
			expect(bodies.length).toBe(3)
			expect(bodies[0]?.max_completion_tokens).toBe(512_000)
			expect(bodies[1]?.max_completion_tokens).toBe(262_144)
			// The retry of the corrected attempt is lowered again — the original
			// oversized budget never returns to the wire.
			expect(bodies[2]?.max_completion_tokens).toBe(262_144)
			trace.step("outgoing budgets: 512000 rejected, 262144, 262144")

			expect(viewText(terminal)).not.toContain("max_completion_tokens is too large")
			trace.step("raw rejection sanitized")
		},
	)
})
