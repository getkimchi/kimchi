// Reusable agent-user scenarios for the three capability-combination tests.
// Each scenario drives a fixed prompt sequence against a fake LLM backend
// and asserts the wire-level behavior the *client* observes.

import { setTimeout as delay } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk"
import { type AcpFixture, PROMPT_TIMEOUT_MS } from "./acp-fixture.js"

export interface ScenarioResult {
	sessionId: string
	chunks: string
	stopReason: acp.StopReason | "TIMEOUT" | "ERROR"
}

export async function newSession(fixture: AcpFixture, cwd: string): Promise<string> {
	const ns = await fixture.conn.newSession({ cwd, mcpServers: [] })
	process.stderr.write(`[acp-e2e] newSession=${ns.sessionId}\n`)
	return ns.sessionId
}

/** Shared poll interval default for the e2e waitFor helper. */
export const E2E_WAIT_MS = 20_000

/**
 * Poll `probe` every 100ms until `predicate` holds (or `timeoutMs` elapses).
 * The thrown error carries the last observed value so the failure log shows
 * what the condition was actually looking at.
 */
export async function waitFor<T>(probe: () => T, predicate: (v: T) => boolean, timeoutMs = E2E_WAIT_MS): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let last: T | undefined
	while (Date.now() < deadline) {
		const value = probe()
		if (predicate(value)) return value
		last = value
		await delay(100)
	}
	throw new Error(`condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last)}`)
}

/** Names from the most recent available_commands_update for a session. */
export function commandNames(fixture: AcpFixture, sessionId: string): string[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
	)
	const last = updates[updates.length - 1]
	if (last?.update.sessionUpdate !== "available_commands_update") return []
	return last.update.availableCommands.map((c) => c.name)
}

export async function prompt(fixture: AcpFixture, sessionId: string, text: string): Promise<ScenarioResult> {
	const promptPromise = fixture.conn
		.prompt({ sessionId, prompt: [{ type: "text", text }] })
		.catch((err) => ({ stopReason: "ERROR" as const, error: err }))

	const result = await Promise.race([
		promptPromise,
		delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
	])

	const chunks = fixture.client.agentTextBySession().get(sessionId) ?? ""
	const stopReason: ScenarioResult["stopReason"] =
		result.stopReason === "TIMEOUT"
			? "TIMEOUT"
			: result.stopReason === "ERROR"
				? "ERROR"
				: (result.stopReason as acp.StopReason)
	return { sessionId, chunks, stopReason }
}

/** Resolve after the recording client has received at least one session_update. */
export async function waitForSessionUpdate(
	fixture: AcpFixture,
	sessionId: string,
	predicate: (update: acp.SessionUpdate) => boolean,
	timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<acp.SessionUpdate> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const hit = fixture.client.sessionUpdates.find((u) => u.sessionId === sessionId && predicate(u.update))
		if (hit) return hit.update
		await delay(50)
	}
	throw new Error(`waitForSessionUpdate timed out after ${timeoutMs}ms`)
}
