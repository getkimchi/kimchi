// ACP integration — steering queue reconciliation.
//
// Kimchi's ACP server tracks pi-mono's steering queue via queue_update
// events: enqueued steers stay invisible to the client until pi actually
// injects them (detected by the FIFO diff in reconcileQueue), at which point
// the server echoes them as `user_message_chunk` session updates so the
// client's transcript matches the agent's session history. Steers that are
// still queued when the turn is cancelled never entered history — those go
// out on the `_kimchi.dev/queue_dropped` extension notification
// instead of as user messages.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ContentChunk } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitForSessionUpdate } from "./support/scenarios.js"

const STEER_METHOD = "_kimchi.dev/steering"
const DROPPED_NOTIFICATION = "_kimchi.dev/queue_dropped"

function userMessageTexts(fixture: AcpFixture, sessionId: string): string[] {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "user_message_chunk")
		.map((u) => ((u.update as ContentChunk).content as { type: "text"; text: string }).text)
}

async function waitForExtNotification(
	fixture: AcpFixture,
	method: string,
	timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<{ method: string; params: unknown }> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const hit = fixture.client.extNotifications.find((n) => n.method === method)
		if (hit) return hit
		await delay(50)
	}
	throw new Error(`waitForExtNotification(${method}) timed out after ${timeoutMs}ms`)
}

describe("ACP integration — injected steer echo", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// First response: a slow text preamble plus an allowed tool call. The
		// per-chunk delay keeps the turn streaming long enough for the steer to
		// be enqueued *while the turn is live*, and the tool call guarantees a
		// turn boundary where pi injects the queued steer. `echo` is in the
		// read-only bash allowlist, so no permission round-trip is needed.
		fixture = await startAcpFixture({
			artifactName: "steering-injected",
			responses: [
				{
					stream: ["Working ", "on ", "it. "],
					delayMs: 150,
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
				},
				{ stream: ["Done."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("echoes an injected steer to the client as a user_message_chunk", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run echo" }],
		})

		// Turn is live: first text chunk has arrived.
		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")

		// Enqueue a steer mid-turn via the extension method, then wait for pi to
		// inject it (queue shrinks → user_message_chunk echo appears).
		const steerResult = (await fixture.conn.extMethod(STEER_METHOD, {
			sessionId,
			prompt: "Actually, skip the rest and wrap up.",
		})) as { status: string }
		expect(steerResult.status).toBe("injected")

		await waitForSessionUpdate(
			fixture,
			sessionId,
			(u) =>
				u.sessionUpdate === "user_message_chunk" &&
				u.content.type === "text" &&
				u.content.text === "Actually, skip the rest and wrap up.",
		)

		const result = await Promise.race([
			promptPromise,
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason, "turn stop reason").toBe("end_turn")
		expect(userMessageTexts(fixture, sessionId)).toContain("Actually, skip the rest and wrap up.")
		// The steer reached the model: the continuation request(s) after the
		// tool result include it in the transcript the fake backend saw.
		expect(fixture.fake.requests.length, "continuation request after injection").toBeGreaterThanOrEqual(2)
	})
})

describe("ACP integration — /skill: steer echo", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "steering-skill-echo",
			pretrustWorkDir: true,
			responses: [
				{
					stream: ["Working ", "on ", "it. "],
					delayMs: 150,
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
				},
				{ stream: ["Done."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("echoes the client's original text while the model sees the expanded skill", async () => {
		const projectSkills = join(fixture.workDir, ".kimchi", "skills", "e2e-steer-skill")
		mkdirSync(projectSkills, { recursive: true })
		writeFileSync(
			join(projectSkills, "SKILL.md"),
			"---\nname: e2e-steer-skill\ndescription: E2E steer skill\n---\nSkill body marker.\n",
		)

		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run echo" }],
		})
		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")

		const steerResult = (await fixture.conn.extMethod(STEER_METHOD, {
			sessionId,
			prompt: "/skill:e2e-steer-skill wrap up now",
		})) as { status: string }
		expect(steerResult.status).toBe("injected")

		// Pending-steer acknowledgement matches the submitted text exactly, so
		// the server must echo the ORIGINAL submission, not the expanded skill
		// prompt that pi-mono would otherwise queue and echo back.
		await waitForSessionUpdate(
			fixture,
			sessionId,
			(u) =>
				u.sessionUpdate === "user_message_chunk" &&
				u.content.type === "text" &&
				u.content.text === "/skill:e2e-steer-skill wrap up now",
		)

		const result = await Promise.race([
			promptPromise,
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		// The model side of the turn, though, must carry the expanded skill
		// content — the steer informed the agent, not just the transcript.
		// Scan every request rather than just the last: pipelined requests
		// can out-of-order which one is at(-1) at assertion time.
		const transcripts = fixture.fake.requests.map((r) =>
			JSON.stringify((r.body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? []),
		)
		const sawExpandedSkill = transcripts.some(
			(t) => t.includes("Skill body marker.") && t.includes("Invoking skill: e2e-steer-skill"),
		)
		expect(sawExpandedSkill, "model transcript must contain the expanded skill content").toBe(true)

		// The echoed user message must be the original text only — no expanded
		// skill block leaking into the client transcript.
		expect(userMessageTexts(fixture, sessionId).some((t) => t.includes("Skill body marker."))).toBe(false)
	})
})

describe("ACP integration — cancel drops queued steers", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// Single slow response with NO tool call: no turn boundary, so the
		// steer stays queued when cancel arrives and must be reported as
		// dropped rather than echoed as a user message.
		fixture = await startAcpFixture({
			artifactName: "steering-cancel-drop",
			responses: [{ stream: ["Slow ", "stream ", "in ", "progress. "], delayMs: 500 }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("notifies queue_dropped and emits no phantom user message chunks", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "go" }],
		})

		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")

		await fixture.conn.extMethod(STEER_METHOD, { sessionId, prompt: "never injected" })
		// Give the queue_update a beat to be processed server-side.
		await delay(100)

		await fixture.conn.cancel({ sessionId })

		const result = await Promise.race([
			promptPromise,
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason, "stop reason after cancel").toBe("cancelled")

		const dropped = await waitForExtNotification(fixture, DROPPED_NOTIFICATION)
		expect(dropped.params).toMatchObject({
			sessionId,
			reason: "cancelled",
			steering: ["never injected"],
		})

		// The dropped steer must never have surfaced as a user message.
		expect(userMessageTexts(fixture, sessionId)).not.toContain("never injected")
	})
})
