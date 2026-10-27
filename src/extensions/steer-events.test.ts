import { readFile } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import {
	emitSteerFired,
	emitSteerOutcome,
	isSteerDisabled,
	resetSteerAbortTracker,
	STEER_EVENTS,
	type SteerFiredPayload,
	type SteerKind,
	type SteerOutcomePayload,
	sendSteer,
	steerAbortTrackerExtension,
	steerDisableFlagName,
} from "./steer-events.js"

const ALL_KINDS: SteerKind[] = [
	"todo_early_nudge",
	"todo_staleness",
	"loop_guard",
	"bash_tool_guard",
	"bash_timeout_guidance",
	"bash_control_checkin",
	"exploration_guard",
	"review_write_guard",
	"continuation_nudge",
	"planning_stop_nudge",
]

const MANAGED_ENV_FLAGS = ALL_KINDS.map(steerDisableFlagName)

function makePi(): { pi: ExtensionAPI; emitted: { channel: string; payload: unknown }[] } {
	const emitted: { channel: string; payload: unknown }[] = []
	const pi = {
		events: {
			emit: (channel: string, payload: unknown) => {
				emitted.push({ channel, payload })
			},
		},
	} as unknown as ExtensionAPI
	return { pi, emitted }
}

/** Shared-mock pi with the steerAbortTrackerExtension wired, for tests that
 *  drive pi handlers (turn_end / input / session_shutdown) with a session
 *  context and assert on emitted steer payloads. */
function makeTrackingPi(sessionId = "session") {
	const mock = createExtensionApi()
	const emitted: { channel: string; payload: unknown }[] = []
	const busEmit = mock.api.events.emit as unknown as (channel: string, payload: unknown) => void
	mock.api.events = {
		...mock.api.events,
		emit: (channel: string, payload: unknown) => {
			emitted.push({ channel, payload })
			busEmit(channel, payload)
		},
	}
	steerAbortTrackerExtension(mock.api)
	return {
		pi: mock.api,
		emitted,
		fire: async (event: string, payload: unknown, sid = sessionId) => {
			const ctx = { sessionManager: { getSessionId: () => sid } } as unknown as ExtensionContext
			await mock.emit(event, payload, ctx)
		},
	}
}

describe("steer-events", () => {
	beforeEach(() => {
		for (const flag of MANAGED_ENV_FLAGS) delete process.env[flag]
	})

	afterEach(() => {
		for (const flag of MANAGED_ENV_FLAGS) delete process.env[flag]
		vi.unstubAllEnvs()
	})

	it("every steer kind has a kill-switch flag following the NUDGE_/GUARD_ naming scheme", () => {
		for (const kind of ALL_KINDS) {
			const flag = steerDisableFlagName(kind)
			expect(flag).toMatch(/^KIMCHI_DISABLE_(NUDGE|GUARD)_/)
			// Guard kinds mirror the existing feature names.
			if (kind === "bash_tool_guard") expect(flag).toBe("KIMCHI_DISABLE_GUARD_BASH_TOOL")
			if (kind === "loop_guard") expect(flag).toBe("KIMCHI_DISABLE_GUARD_LOOP")
		}
	})

	it("kill switch: flag set → event suppressed; unset → event emitted", () => {
		const { pi, emitted } = makePi()
		emitSteerFired(pi, "todo_early_nudge", "early_nudge")
		expect(emitted).toHaveLength(1)

		process.env[steerDisableFlagName("todo_early_nudge")] = "1"
		emitSteerFired(pi, "todo_early_nudge", "early_nudge")
		emitSteerOutcome(pi, "todo_early_nudge", "complied")
		expect(emitted).toHaveLength(1)
	})

	it("fired payload shape: semantic kind, short reason, session-shape flags", () => {
		const { pi, emitted } = makePi()
		emitSteerFired(pi, "bash_timeout_guidance", "timeout", { interactive: true })
		expect(emitted).toHaveLength(1)
		expect(emitted[0].channel).toBe(STEER_EVENTS.FIRED)
		const payload = emitted[0].payload as SteerFiredPayload
		expect(payload.kind).toBe("bash_timeout_guidance")
		expect(payload.reason).toBe("timeout")
		expect(payload.interactive).toBe(true)
		expect(typeof payload.is_subagent).toBe("boolean")
		// Privacy: no free-text fields beyond the short reason code.
		expect(Object.keys(payload).sort()).toEqual(["interactive", "is_subagent", "kind", "reason", "steer_id"])
	})

	it("emitSteerFired returns a per-fire steer_id stamped on the payload; undefined when kill-switched", () => {
		const { pi, emitted } = makePi()
		const id = emitSteerFired(pi, "todo_early_nudge", "early_nudge")
		expect(id).toMatch(/^[0-9a-f-]{36}$/)
		expect((emitted[0].payload as SteerFiredPayload).steer_id).toBe(id)
		// Each fire gets a distinct id.
		expect(emitSteerFired(pi, "todo_early_nudge", "early_nudge")).not.toBe(id)

		process.env[steerDisableFlagName("todo_early_nudge")] = "1"
		expect(emitSteerFired(pi, "todo_early_nudge", "early_nudge")).toBeUndefined()
	})

	it("emitSteerOutcome threads caller-supplied steer_id and turns_to_outcome", () => {
		const { pi, emitted } = makePi()
		emitSteerOutcome(pi, "todo_early_nudge", "complied", { interactive: true, steerId: "fire-1", turnsToOutcome: 2 })
		const payload = emitted[0].payload as SteerOutcomePayload
		expect(payload.steer_id).toBe("fire-1")
		expect(payload.turns_to_outcome).toBe(2)
	})

	it("outcome payload shape: semantic kind, complied|repeated outcome, session-shape flags", () => {
		const { pi, emitted } = makePi()
		emitSteerOutcome(pi, "loop_guard", "repeated", { interactive: false })
		expect(emitted).toHaveLength(1)
		expect(emitted[0].channel).toBe(STEER_EVENTS.OUTCOME)
		const payload = emitted[0].payload as SteerOutcomePayload
		expect(payload.kind).toBe("loop_guard")
		expect(payload.outcome).toBe("repeated")
		expect(payload.interactive).toBe(false)
		expect(Object.keys(payload).sort()).toEqual(["interactive", "is_subagent", "kind", "outcome"])
	})

	describe("outcome self-attribution", () => {
		beforeEach(() => {
			resetSteerAbortTracker()
		})

		const outcomes = (emitted: { channel: string; payload: unknown }[]) =>
			emitted.filter((e) => e.channel === STEER_EVENTS.OUTCOME).map((e) => e.payload as SteerOutcomePayload)

		it("id-less outcome attributes to the most recent same-kind fire in the session", () => {
			const { pi, emitted } = makeTrackingPi()
			const id = emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "complied", { interactive: false, sessionId: "session" })

			expect(outcomes(emitted)).toHaveLength(1)
			expect(outcomes(emitted)[0]).toMatchObject({ kind: "bash_tool_guard", steer_id: id })
		})

		it("turns_to_outcome counts turn_ends since the fire (matching the watcher's turnsElapsed)", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "loop_guard", "warn", { sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })
			emitSteerOutcome(pi, "loop_guard", "repeated", { sessionId: "session" })

			expect(outcomes(emitted)[0]?.turns_to_outcome).toBe(2)
		})

		it("outcome in the fire's own turn (no turn_end between) reports 0 turns", () => {
			const { pi, emitted } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "complied", { sessionId: "session" })

			expect(outcomes(emitted)[0]?.turns_to_outcome).toBe(0)
		})

		it("explicit steerId wins over the fallback", () => {
			const { pi, emitted } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "complied", { steerId: "explicit", sessionId: "session" })

			expect(outcomes(emitted)[0]?.steer_id).toBe("explicit")
		})

		it("explicit turnsToOutcome is preserved while steer_id still falls back", () => {
			const { pi, emitted } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "complied", { turnsToOutcome: 7, sessionId: "session" })

			const payload = outcomes(emitted)[0]
			expect(payload?.turns_to_outcome).toBe(7)
			expect(typeof payload?.steer_id).toBe("string")
		})

		it("explicit steerId matching the registry fire also gets turns_to_outcome stamped", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			const id = emitSteerFired(pi, "todo_checkin", "checkin", { sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })
			emitSteerOutcome(pi, "todo_checkin", "complied", { steerId: id, sessionId: "session" })

			expect(outcomes(emitted)[0]).toMatchObject({ steer_id: id, turns_to_outcome: 1 })
		})

		it("explicit steerId from an older fire does not get the registry's turns stamped", () => {
			const { pi, emitted } = makeTrackingPi()
			const older = emitSteerFired(pi, "todo_checkin", "checkin", { sessionId: "session" })
			emitSteerFired(pi, "todo_checkin", "checkin", { sessionId: "session" })
			emitSteerOutcome(pi, "todo_checkin", "complied", { steerId: older, sessionId: "session" })

			const payload = outcomes(emitted)[0]
			expect(payload?.steer_id).toBe(older)
			expect(payload?.turns_to_outcome).toBeUndefined()
		})

		it("cli.ts registers the abort tracker before the outcome watcher (turn-count parity)", async () => {
			// The fallback's turns_to_outcome assumes the turn counter increments
			// before the watcher classifies the same turn_end — which holds only
			// while cli.ts lists steerAbortTrackerExtension first. An upstream
			// reorder would silently shift every fallback turn count by one.
			const src = await readFile(new URL("../cli.ts", import.meta.url), "utf8")
			const tracker = src.lastIndexOf("steerAbortTrackerExtension")
			const watcher = src.lastIndexOf("steerOutcomeWatcherExtension")
			expect(tracker).toBeGreaterThan(-1)
			expect(watcher).toBeGreaterThan(tracker)
		})

		it("per-kind isolation: an outcome only joins its own kind's fire", () => {
			const { pi, emitted } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerFired(pi, "loop_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "repeated", { sessionId: "session" })

			const fires = emitted.filter((e) => e.channel === STEER_EVENTS.FIRED)
			const bashFireId = (fires[0].payload as SteerFiredPayload).steer_id
			expect(outcomes(emitted)[0]?.steer_id).toBe(bashFireId)
		})

		it("per-session isolation: sessions do not cross-attribute; the ctx-less key stays empty", () => {
			const { pi, emitted } = makeTrackingPi()
			const s1 = emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "s1" })
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "s2" })

			emitSteerOutcome(pi, "bash_tool_guard", "complied", { sessionId: "s1" })
			expect(outcomes(emitted)[0]?.steer_id).toBe(s1)

			// No fire ever recorded for the ctx-less key → unattributed.
			emitSteerOutcome(pi, "bash_tool_guard", "complied")
			expect(outcomes(emitted)[1]?.steer_id).toBeUndefined()
		})

		it("user input does NOT clear the fire registry (unlike the abort tracker)", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			const id = emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			await fire("input", { source: "interactive", text: "carry on" })
			emitSteerOutcome(pi, "bash_tool_guard", "complied", { sessionId: "session" })

			expect(outcomes(emitted)[0]?.steer_id).toBe(id)
		})

		it("a newer fire of the same kind replaces the attributed one", () => {
			const { pi, emitted } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			const newer = emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			emitSteerOutcome(pi, "bash_tool_guard", "repeated", { sessionId: "session" })

			expect(outcomes(emitted)[0]?.steer_id).toBe(newer)
		})

		it("session_shutdown clears the session's fires and turn counter", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "bash_tool_guard", "warn", { sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })
			await fire("session_shutdown", {})

			emitSteerOutcome(pi, "bash_tool_guard", "complied", { sessionId: "session" })
			expect(outcomes(emitted)[0]?.steer_id).toBeUndefined()
			expect(outcomes(emitted)[0]?.turns_to_outcome).toBeUndefined()
		})
	})

	it("emission no-ops when pi.events is unavailable (lightweight test mocks / older hosts)", () => {
		const pi = {} as unknown as ExtensionAPI
		expect(() => emitSteerFired(pi, "exploration_guard", "turn_end")).not.toThrow()
		expect(() => emitSteerOutcome(pi, "todo_early_nudge", "repeated")).not.toThrow()
	})

	it("isSteerDisabled defaults to false", () => {
		for (const kind of ALL_KINDS) {
			expect(isSteerDisabled(kind)).toBe(false)
		}
	})

	describe("steer:aborted tracker", () => {
		beforeEach(() => {
			resetSteerAbortTracker()
		})

		it("user Esc-abort of the turn following a steer → steer:aborted with the steer's kind", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "exploration_guard", "turn_end", { interactive: true, sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			const aborted = emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)
			expect(aborted).toHaveLength(1)
			expect(aborted[0].payload).toMatchObject({ kind: "exploration_guard", reason: "turn_end", interactive: true })
		})

		it("no abort for a normal (non-aborted) turn finish", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "continuation_nudge", "empty_turn")
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })

			expect(emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)).toHaveLength(0)
		})

		it("real user input clears the tracker — a later abort is not attributed to the steer", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "bash_timeout_guidance", "timeout")
			await fire("input", { source: "interactive", text: "what now?" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			expect(emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)).toHaveLength(0)
		})

		it("extension-source input does NOT clear the tracker (steers flow through input too)", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "todo_early_nudge", "early_nudge", { sessionId: "session" })
			await fire("input", { source: "extension", text: "steer text" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			expect(emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)).toHaveLength(1)
		})

		it("only the most recent steer is attributed when multiple fire back-to-back", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "exploration_guard", "turn_end", { sessionId: "session" })
			emitSteerFired(pi, "bash_timeout_guidance", "timeout", { sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			const aborted = emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)
			expect(aborted).toHaveLength(1)
			expect(aborted[0].payload).toMatchObject({ kind: "bash_timeout_guidance" })
		})

		it("kill switch on that kind suppresses the abort event too", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			emitSteerFired(pi, "loop_guard", "warn", { sessionId: "session" })
			process.env[steerDisableFlagName("loop_guard")] = "1"
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			expect(emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)).toHaveLength(0)
		})

		it("steer:aborted carries the same steer_id as its fire", async () => {
			const { pi, emitted, fire } = makeTrackingPi()
			const id = emitSteerFired(pi, "exploration_guard", "turn_end", { interactive: true, sessionId: "session" })
			await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } })

			const aborted = emitted.filter((e) => e.channel === STEER_EVENTS.ABORTED)
			expect(aborted).toHaveLength(1)
			expect(aborted[0].payload).toMatchObject({ steer_id: id })
		})
	})
})

describe("sendSteer", () => {
	function makePiWithSend(): {
		pi: ExtensionAPI
		emitted: { channel: string; payload: unknown }[]
		sent: { message: unknown; options: unknown }[]
	} {
		const emitted: { channel: string; payload: unknown }[] = []
		const sent: { message: unknown; options: unknown }[] = []
		const pi = {
			sendMessage: (message: unknown, options: unknown) => {
				sent.push({ message, options })
			},
			events: {
				emit: (channel: string, payload: unknown) => {
					emitted.push({ channel, payload })
				},
			},
		} as unknown as ExtensionAPI
		return { pi, emitted, sent }
	}

	function makeCtx(hasUI = true): ExtensionContext {
		return {
			hasUI,
			sessionManager: { getSessionId: () => "test-session" },
		} as unknown as ExtensionContext
	}

	beforeEach(() => {
		resetSteerAbortTracker()
	})

	it("sends a marked hidden message, emits the fired event, returns the fire id", () => {
		const { pi, emitted, sent } = makePiWithSend()
		const ok = sendSteer(pi, makeCtx(), {
			kind: "review_write_guard",
			reason: "steer",
			customType: "review-write-guard-steer",
			text: "stop editing",
		})

		// Truthy = a steer was sent (previously boolean true); the value is the
		// emitted fire's steer_id for outcome attribution.
		expect(typeof ok).toBe("string")
		expect((emitted[0]?.payload as SteerFiredPayload | undefined)?.steer_id).toBe(ok)
		expect(sent).toHaveLength(1)
		const message = sent[0].message as {
			customType: string
			content: { type: string; text: string }[]
			display: boolean
		}
		expect(message.customType).toBe("review-write-guard-steer")
		expect(message.display).toBe(false)
		// Raw text is wrapped in the harness marker.
		expect(message.content[0].text).toContain("<system-reminder>")
		expect(message.content[0].text).toContain("stop editing")
		expect(sent[0].options).toEqual({ deliverAs: "steer" })

		expect(emitted).toHaveLength(1)
		expect(emitted[0].channel).toBe(STEER_EVENTS.FIRED)
		expect(emitted[0].payload).toMatchObject({ kind: "review_write_guard", reason: "steer" })
	})

	it("kill switch: returns undefined, sends nothing, emits nothing", () => {
		const { pi, emitted, sent } = makePiWithSend()
		process.env[steerDisableFlagName("exploration_guard")] = "1"
		const ok = sendSteer(pi, makeCtx(), {
			kind: "exploration_guard",
			reason: "turn_end",
			customType: "exploration-guard-steer",
			text: "stop exploring",
		})

		expect(ok).toBeUndefined()
		expect(sent).toHaveLength(0)
		expect(emitted).toHaveLength(0)
	})

	it("derives session shape from ctx (interactive flag + sessionId for abort attribution)", () => {
		const { pi, emitted } = makePiWithSend()
		sendSteer(pi, makeCtx(false), {
			kind: "bash_timeout_guidance",
			reason: "timeout",
			customType: "bash-timeout-guidance",
			text: "guidance",
		})

		const payload = emitted[0].payload as SteerFiredPayload
		expect(payload.interactive).toBe(false)
	})
})
