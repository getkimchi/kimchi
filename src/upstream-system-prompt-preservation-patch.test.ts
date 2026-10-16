/**
 * Regression tests for the prompt lifecycle Kimchi's
 * prompt-enrichment extensions rely on.
 *
 * History: on pi 0.85, `setActiveToolsByName()` and resource reloads reset
 * `agent.state.systemPrompt` to the rebuilt pi-mono default prompt, and
 * extension-triggered turns (`sendCustomMessage({ triggerTurn: true })`)
 * never fired `before_agent_start` — so an injected prompt/facts vanished
 * mid-run. Kimchi patched both.
 *
 * upstream pi made both behaviors native, and the patches were dropped during the
 * upgrade:
 *   1. Extension `systemPrompt` results become a `forceSystemPrompt`
 *      projection installed per request
 *      (`_installAgentForcedPromptProjection`); tool-set rebuilds only touch
 *      `_baseSystemPromptOptions` and never the projection.
 *   2. `_startRun` fires `before_agent_start` for `messageType: "custom"`
 *      triggers exactly like user prompts, injecting handler `message`s and
 *      applying handler prompt selections.
 *
 * These tests pin that the installed 1.3.0 dist still provides the behavior
 * (source assertions fail fast on an upstream regression), plus one
 * behavioral check on the forced-prompt projection.
 */

import { readFileSync } from "node:fs"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

type AnyFn = (...args: unknown[]) => unknown

const sessionProto = AgentSession.prototype as unknown as Record<string, AnyFn>

function runnerSource(): string {
	// The package exports no subpaths — locate the installed dist directly.
	return readFileSync(
		new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", import.meta.url),
		"utf8",
	)
}

describe("upstream before_agent_start on extension-triggered turns (native in 1.3.0)", () => {
	it("sendCustomMessage triggerTurn starts a run from a custom trigger", () => {
		expect(String(sessionProto.sendCustomMessage)).toContain('_startRun({ messageType: "custom"')
	})

	it("_prepareRun fires before_agent_start for custom triggers and injects handler messages", () => {
		const source = String(sessionProto._prepareRun)
		expect(source).toContain("emitBeforeAgentStart(trigger")
		expect(source).toContain('trigger.messageType === "custom"')
		expect(source).toContain("result.messages")
	})

	it("runner maps a handler's systemPrompt to forceSystemPrompt", () => {
		expect(runnerSource()).toContain("currentOptions.forceSystemPrompt = result.systemPrompt")
	})

	it("extension messages follow the starting message in the run", () => {
		// Ordering contract the old patch established: trigger message first,
		// then pending nextTurn messages, then handler-injected messages.
		const source = String(sessionProto._prepareRun)
		const triggerIdx = source.indexOf("messages.push(trigger.message)")
		const handlerIdx = source.indexOf("for (const msg of result.messages)")
		expect(triggerIdx).toBeGreaterThanOrEqual(0)
		expect(handlerIdx).toBeGreaterThan(triggerIdx)
	})
})

describe("upstream forced-prompt projection (replaces the _systemPromptOverride patch)", () => {
	it("setActiveToolsByName and resource reloads never write agent.state.systemPrompt", () => {
		for (const method of ["setActiveToolsByName", "_setActiveTools", "extendResourcesFromExtensions"]) {
			const source = String(sessionProto[method])
			expect(source).not.toContain("state.systemPrompt =")
		}
	})

	it("setActiveToolsByName preserves a forced prompt even when the tool set is emptied", () => {
		// Behavioral check for the ferment path: setActiveTools([]) used to
		// wipe an extension-installed prompt; at 1.3.0 it only rebuilds the
		// base prompt from the loadout and must not touch the projection
		// input (_runSystemPromptOptions.forceSystemPrompt).
		const fake = {
			_runSystemPromptOptions: { forceSystemPrompt: "KIMCHI FORCED PROMPT" },
			_pendingToolNames: new Set<string>(),
			getActiveToolNames: () => ["read", "bash"],
			_applyToolLoadout: (names: string[]) => names.map((name) => ({ name })),
			_rebuildSystemPrompt: (names: string[]) => {
				rebuiltWith.push(names)
			},
		}
		const rebuiltWith: string[][] = []
		// Exercise the real chain: setActiveToolsByName → _setActiveTools (both
		// from the dist), with only the loadout/prompt machinery stubbed.
		const fakeSession = { ...fake, _setActiveTools: sessionProto._setActiveTools }
		sessionProto.setActiveToolsByName.call(fakeSession, [])
		expect(rebuiltWith).toEqual([[]])
		expect((fake._runSystemPromptOptions as { forceSystemPrompt: string }).forceSystemPrompt).toBe(
			"KIMCHI FORCED PROMPT",
		)
	})

	it("installs a projection replacing the request's leading system message with the forced text", async () => {
		const session: Record<string, unknown> = {
			agent: { transformContext: undefined },
			_runSystemPromptOptions: { forceSystemPrompt: "KIMCHI FORCED PROMPT" },
		}
		sessionProto._installAgentForcedPromptProjection.call(session)

		const transform = (
			session.agent as { transformContext: (msgs: unknown[], signal?: AbortSignal) => Promise<unknown[]> }
		).transformContext
		const out = await transform([
			{ role: "system", content: "PI BASE PROMPT", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		])

		const messages = out as Array<{ role: string; content: string }>
		expect(messages[0]).toMatchObject({ role: "system", content: "KIMCHI FORCED PROMPT" })
		for (const m of messages.slice(1)) expect(m.role).not.toBe("system")
	})

	it("projection passes the context through unchanged when no prompt is forced", async () => {
		const session: Record<string, unknown> = {
			agent: { transformContext: undefined },
			_runSystemPromptOptions: undefined,
		}
		sessionProto._installAgentForcedPromptProjection.call(session)

		const transform = (
			session.agent as { transformContext: (msgs: unknown[], signal?: AbortSignal) => Promise<unknown[]> }
		).transformContext
		const input = [{ role: "system", content: "PI BASE PROMPT", timestamp: 1 }]
		expect(await transform(input)).toEqual(input)
	})
})
