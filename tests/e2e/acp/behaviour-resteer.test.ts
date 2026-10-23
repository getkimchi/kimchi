// ACP integration — behaviour re-steer after mid-turn compaction.
//
// Dual-surface parity for the behaviours extension's steer + re-steer
// delivery. The TUI-side wiring has unit/integration coverage
// (src/extensions/behaviours/resteer-delivery.integration.test.ts), but the
// ACP server's session lifecycle must be exercised end-to-end against the
// real harness process: a tool-triggered behaviour load, an inline compaction
// during the active turn, and the retried turn that follows it.
//
// Scenario: the fake model writes a .py file (the python-edit nudge loads and
// its body is steered), then reports usage that crosses the compaction
// threshold mid-turn. The harness compacts (summarization call), the
// session_compact handler re-steers the body, and the turn is retried on the
// rewritten context. The fake provider records every request body, so the
// test asserts — at the provider boundary, not on mocks:
//   1. first delivery: the request after the write tool result carries the
//      nudge body wrapped in a <system-reminder> steer;
//   2. the compaction runs mid-turn (agent_activity compaction_start/end
//      arrive before the turn's final response);
//   3. the retried request — built from the rewritten, summarized context —
//      carries the nudge body again: the re-steer survived the compaction
//      rewrite with no user prompt in between;
//   4. the session JSONL contains the persisted re-steer entry
//      (customType "behaviour", details.reason "compaction") positioned after
//      the compaction entry — decisive evidence the re-steer fired in the ACP
//      session rather than the original steer merely surviving keep-recent.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FakeResponseRequest } from "../tui/support/fake-openai-server.js"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { E2E_WAIT_MS, newSession } from "./support/scenarios.js"

const COMPACT_ACTIVITY = "_kimchi.dev/agent_activity"
/** Distinctive fragment of the bundled python-edit body (bodies/python-edit.md). */
const BODY_MARKER = "ast.parse(open(sys.argv[1]).read())"
/** Marker streamed by the scripted summarization response — its text becomes
 *  the compaction summary that the retried request is built around. */
const SUMMARY_MARKER = "PRE-COMPACT-CONTEXT: earlier work summarized."
const FINAL_MARKER = "RESTEER_E2E_FINAL: finished."
const FINAL_MARKER_OVERFLOW = "RESTEER_OVERFLOW_FINAL: finished after overflow recovery."
/** Provider overflow error — matches the SDK's OVERFLOW_PATTERNS
 *  (/exceeds the context window/i) and no non-overflow pattern. */
const OVERFLOW_ERROR = "Your input exceeds the context window of this model"

type ActivityParams = { sessionId: string; kind: string; reason?: string; aborted?: boolean }

async function waitForActivity(
	fixture: AcpFixture,
	kind: string,
	timeoutMs = E2E_WAIT_MS,
): Promise<{ method: string; params: unknown }> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const hit = fixture.client.extNotifications.find(
			(n) => n.method === COMPACT_ACTIVITY && (n.params as ActivityParams).kind === kind,
		)
		if (hit) return hit
		await delay(50)
	}
	throw new Error(`waitForActivity(${kind}) timed out after ${timeoutMs}ms`)
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(PROMPT_TIMEOUT_MS).then(() => {
			throw new Error(`${label} timed out after ${PROMPT_TIMEOUT_MS}ms`)
		}),
	])
}

interface SessionEntryLine {
	type: string
	customType?: string
	details?: unknown
}

function readJsonl(path: string): SessionEntryLine[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as SessionEntryLine)
}

/** Session-log evidence that the re-steer fired in the ACP session: persisted
 *  behaviour custom entries (type "custom_message") with a re-steer
 *  (details.reason "compaction") positioned after the compaction entry, and
 *  the first delivery before it. The ACP server stores sessions under its
 *  agentDir (~/.config/kimchi/harness/sessions/<encoded-cwd>/), keyed by the
 *  session workDir. */
function expectResteerPersisted(fixture: AcpFixture): void {
	const encodedWorkDir = `--${fixture.workDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
	const sessionSubdir = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions", encodedWorkDir)
	const sessionFiles = readdirSync(sessionSubdir).filter((f) => f.endsWith(".jsonl"))
	expect(sessionFiles, "session JSONL under the ACP agent dir").toHaveLength(1)
	const entries = readJsonl(join(sessionSubdir, sessionFiles[0]))
	const compactionIdx = entries.findLastIndex((e) => e.type === "compaction")
	expect(compactionIdx, "session was compacted").toBeGreaterThan(-1)
	const isBehaviourEntry = (e: SessionEntryLine) => e.type === "custom_message" && e.customType === "behaviour"
	const resteerIdx = entries.findIndex(
		(e, i) => i > compactionIdx && isBehaviourEntry(e) && JSON.stringify(e.details ?? {}).includes("compaction"),
	)
	expect(resteerIdx, "re-steer entry persisted after the compaction entry").toBeGreaterThan(-1)
	const firstSteerIdx = entries.findIndex(
		(e) => isBehaviourEntry(e) && !JSON.stringify(e.details ?? {}).includes("compaction"),
	)
	expect(firstSteerIdx, "first delivery entry persisted before the compaction").toBeGreaterThan(-1)
	expect(firstSteerIdx).toBeLessThan(compactionIdx)
}

describe("ACP integration — behaviour re-steer after mid-turn compaction", () => {
	let fixture: AcpFixture

	// Split-turn compaction (the in-flight turn is too large to keep whole)
	// makes TWO summarization calls — one for prior history, one for the turn
	// prefix — plus the retried turn, so the response scripts are keyed on
	// request content (match predicates) instead of queue order.
	const bodyText = (r: FakeResponseRequest) => JSON.stringify(r.body ?? {})
	const isSummarization = (r: FakeResponseRequest) => bodyText(r).includes("conversation to summarize")
	const isTurnPrefixSummarization = (r: FakeResponseRequest) =>
		bodyText(r).includes("PREFIX of a turn that was too large")
	// The history summary text only exists in context after compaction commits.
	const isPostCompaction = (r: FakeResponseRequest) => bodyText(r).includes(SUMMARY_MARKER)
	const hasToolResult = (r: FakeResponseRequest) => bodyText(r).includes('"role":"tool"')

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-behaviour-resteer",
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [
				// Turn: write a .py file → python-edit nudge loads via tool trigger,
				// body steered after the tool result (first delivery). Usage below
				// the compaction threshold.
				{
					match: (r) =>
						!isSummarization(r) && !isTurnPrefixSummarization(r) && !hasToolResult(r) && !isPostCompaction(r),
					stream: ["Writing ", "app.py."],
					toolCalls: [
						{ function: { name: "write", arguments: JSON.stringify({ path: "app.py", content: "print('hi')\n" }) } },
					],
					usage: { prompt_tokens: 30_000, completion_tokens: 500 },
				},
				// Same turn, after the tool result: usage crosses
				// contextWindow − 16,384 → the mid-turn guard fires a split-turn
				// compaction. The body text is huge so the first steer falls
				// outside the keep-recent window and cannot masquerade as
				// the re-steer.
				{
					match: (r) =>
						!isSummarization(r) && !isTurnPrefixSummarization(r) && hasToolResult(r) && !isPostCompaction(r),
					stream: [`recent notes ${"kept note ".repeat(12_000)}`],
					usage: { prompt_tokens: 250_000, completion_tokens: 700 },
				},
				// History summarization call: its text becomes the compaction
				// summary the retried request is built around. Slow, so the test can
				// deterministically observe compaction_start mid-turn.
				{
					match: (r) => isSummarization(r) && !isTurnPrefixSummarization(r),
					stream: [`${SUMMARY_MARKER} `],
					delayMs: 1_500,
					usage: { prompt_tokens: 5_000, completion_tokens: 100 },
				},
				// Turn-prefix summarization call (split turns summarize the
				// discarded turn prefix separately). Slow for the same reason.
				{
					match: (r) => isTurnPrefixSummarization(r),
					stream: ["TURN-PREFIX-CONTEXT: mid-turn notes. "],
					delayMs: 1_500,
					usage: { prompt_tokens: 5_000, completion_tokens: 100 },
				},
				// Retried turn on the rewritten context — the re-steer must be in
				// this request. Usage back below threshold, so the turn finishes.
				{
					match: (r) => isPostCompaction(r),
					stream: [FINAL_MARKER],
					usage: { prompt_tokens: 20_000, completion_tokens: 100 },
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("re-delivers the python-edit body to the provider after an inline mid-turn compaction", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "write app.py with a hello, then finish" }],
		})

		// The compaction announces itself while the turn is still live — before
		// the retried turn's final response.
		await waitForActivity(fixture, "compaction_start")
		const textSoFar = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(textSoFar).not.toContain(FINAL_MARKER)

		const result = (await withTimeout(promptPromise, "prompt")) as { stopReason: string }
		expect(result.stopReason).toBe("end_turn")

		const endActivity = await waitForActivity(fixture, "compaction_end")
		expect((endActivity.params as ActivityParams).aborted).toBe(false)
		const chunks = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(chunks).toContain(FINAL_MARKER)

		// Provider-boundary assertions over the recorded chat request bodies.
		const chatBodies = fixture.fake.requests
			.filter((r) => r.method === "POST" && r.url?.includes("/chat/completions"))
			.map((r) => JSON.stringify(r.body))

		// 1. First delivery: the nudge body reached the provider as a steer
		// right after the write tool result, before any compaction.
		const firstDelivery = chatBodies.find((b) => b.includes(BODY_MARKER))
		expect(firstDelivery, "first steer delivery reached the provider").toBeTruthy()
		expect(firstDelivery).toContain("<system-reminder>")

		// 2. Exactly one request is built around the compaction summary: the
		// retried turn. It must carry the nudge body again — the re-steer —
		// even though the compaction rewrite dropped the original steer.
		const retried = chatBodies.filter((b) => b.includes(SUMMARY_MARKER))
		expect(retried, "exactly one post-compaction (retried) request").toHaveLength(1)
		expect(retried[0]).toContain(BODY_MARKER)
		expect(retried[0]).toContain("<system-reminder>")

		// 3. Session-log evidence that the re-steer fired in the ACP session.
		expectResteerPersisted(fixture)
	})
})

describe("ACP integration — behaviour re-steer after provider overflow recovery", () => {
	let fixture: AcpFixture

	// Overflow recovery (a provider context-overflow error → compact with
	// willRetry: true → retry the turn) needs the first steer OUTSIDE the
	// compaction keep-recent window, so the bulk sits between the steer and
	// the failing response: the second scripted response streams a large
	// analysis text alongside the second write tool call. The failing response
	// is then a real provider overflow error (finish_reason "error" with a
	// message matching the SDK's OVERFLOW_PATTERNS).
	const bodyText = (r: FakeResponseRequest) => JSON.stringify(r.body ?? {})
	const isSummarization = (r: FakeResponseRequest) => bodyText(r).includes("conversation to summarize")
	const isTurnPrefixSummarization = (r: FakeResponseRequest) =>
		bodyText(r).includes("PREFIX of a turn that was too large")
	const isPostCompaction = (r: FakeResponseRequest) => bodyText(r).includes(SUMMARY_MARKER)
	const toolResultCount = (r: FakeResponseRequest) => (bodyText(r).match(/"role":"tool"/g) ?? []).length

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-behaviour-resteer-overflow",
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [
				// Turn: write a .py file → python-edit nudge loads, body steered
				// after the tool result (first delivery).
				{
					match: (r) => !isSummarization(r) && !isTurnPrefixSummarization(r) && toolResultCount(r) === 0,
					stream: ["Writing ", "app.py."],
					toolCalls: [
						{ function: { name: "write", arguments: JSON.stringify({ path: "app.py", content: "print('hi')\n" }) } },
					],
					usage: { prompt_tokens: 30_000, completion_tokens: 500 },
				},
				// Same turn, one tool result in: large analysis text plus a second
				// write. The large assistant message lands BETWEEN the first steer
				// and the failing response, so the compaction keep-recent walk stops
				// before reaching the steer.
				{
					match: (r) => !isSummarization(r) && !isTurnPrefixSummarization(r) && toolResultCount(r) === 1,
					stream: [`analysis notes ${"kept note ".repeat(12_000)}`],
					toolCalls: [
						{ function: { name: "write", arguments: JSON.stringify({ path: "app.py", content: "print('bye')\n" }) } },
					],
					usage: { prompt_tokens: 40_000, completion_tokens: 30_000 },
				},
				// Two tool results in, no summary yet: a real provider overflow
				// error — an HTTP 400 whose body carries an OpenAI-style overflow
				// message. The SDK's isContextOverflow classifies it, removes the
				// failed message, and compacts with willRetry: true. (A
				// finish_reason-error chunk would NOT work here: the openai
				// provider discards the streamed error text, so the surfaced
				// errorMessage never matches the overflow patterns.)
				{
					match: (r) =>
						!isSummarization(r) && !isTurnPrefixSummarization(r) && toolResultCount(r) >= 2 && !isPostCompaction(r),
					status: 400,
					body: {
						error: { message: OVERFLOW_ERROR, type: "invalid_request_error", code: "context_length_exceeded" },
					},
				},
				// Compaction summarization call(s) — slow so the test can
				// deterministically observe compaction_start mid-turn.
				{
					match: (r) => isSummarization(r) && !isTurnPrefixSummarization(r),
					stream: [`${SUMMARY_MARKER} `],
					delayMs: 1_500,
					usage: { prompt_tokens: 5_000, completion_tokens: 100 },
				},
				{
					match: (r) => isTurnPrefixSummarization(r),
					stream: ["TURN-PREFIX-CONTEXT: mid-turn notes. "],
					delayMs: 1_500,
					usage: { prompt_tokens: 5_000, completion_tokens: 100 },
				},
				// Retried turn on the rewritten context — the re-steer must be in
				// this request.
				{
					match: (r) => isPostCompaction(r),
					stream: [FINAL_MARKER_OVERFLOW],
					usage: { prompt_tokens: 20_000, completion_tokens: 100 },
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("recovers from a provider overflow error and re-delivers the body in the retried request", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "write app.py twice with analysis notes, then finish" }],
		})

		// The overflow-driven compaction announces itself mid-turn — with the
		// overflow reason, distinguishing it from threshold compaction.
		const startActivity = await waitForActivity(fixture, "compaction_start")
		expect((startActivity.params as ActivityParams).reason).toBe("overflow")
		const textSoFar = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(textSoFar).not.toContain(FINAL_MARKER_OVERFLOW)

		const result = (await withTimeout(promptPromise, "prompt")) as { stopReason: string }
		expect(result.stopReason).toBe("end_turn")

		const endActivity = await waitForActivity(fixture, "compaction_end")
		expect((endActivity.params as ActivityParams).aborted).toBe(false)
		expect((endActivity.params as ActivityParams).reason).toBe("overflow")
		const chunks = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(chunks).toContain(FINAL_MARKER_OVERFLOW)

		// Provider-boundary assertions over the recorded chat request bodies.
		const chatBodies = fixture.fake.requests
			.filter((r) => r.method === "POST" && r.url?.includes("/chat/completions"))
			.map((r) => JSON.stringify(r.body))

		// First delivery reached the provider as a marked steer before any
		// compaction.
		const firstDelivery = chatBodies.find((b) => b.includes(BODY_MARKER))
		expect(firstDelivery, "first steer delivery reached the provider").toBeTruthy()
		expect(firstDelivery).toContain("<system-reminder>")

		// The retried request — built around the compaction summary — carries
		// the nudge body again (the re-steer), while the failed overflow turn is
		// gone from the context the SDK actually sent.
		const retried = chatBodies.filter((b) => b.includes(SUMMARY_MARKER))
		expect(retried, "exactly one post-compaction (retried) request").toHaveLength(1)
		expect(retried[0]).toContain(BODY_MARKER)
		expect(retried[0]).toContain("<system-reminder>")
		expect(retried[0], "failed overflow turn dropped from the retried context").not.toContain(OVERFLOW_ERROR)

		// Session-log evidence through the real extension runner.
		expectResteerPersisted(fixture)
	})
})
