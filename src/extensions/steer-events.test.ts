import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
		expect(Object.keys(payload).sort()).toEqual(["interactive", "is_subagent", "kind", "reason"])
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
		type Handler = (...args: unknown[]) => Promise<unknown> | unknown

		beforeEach(() => {
			resetSteerAbortTracker()
		})

		function makeTrackingPi() {
			const handlers = new Map<string, Handler[]>()
			const emitted: { channel: string; payload: unknown }[] = []
			const pi = {
				on: vi.fn((event: string, handler: Handler) => {
					const list = handlers.get(event) ?? []
					list.push(handler)
					handlers.set(event, list)
				}),
				events: {
					emit: (channel: string, payload: unknown) => {
						emitted.push({ channel, payload })
					},
				},
			} as unknown as ExtensionAPI
			steerAbortTrackerExtension(pi)
			return {
				pi,
				emitted,
				fire: async (event: string, payload: unknown) => {
					const ctx = { sessionManager: { getSessionId: () => "session" } }
					for (const handler of handlers.get(event) ?? []) await handler(payload, ctx)
				},
			}
		}

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

	it("sends a marked hidden message and emits the fired event", () => {
		const { pi, emitted, sent } = makePiWithSend()
		const ok = sendSteer(pi, makeCtx(), {
			kind: "review_write_guard",
			reason: "steer",
			customType: "review-write-guard-steer",
			text: "stop editing",
		})

		expect(ok).toBe(true)
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

	it("kill switch: returns false, sends nothing, emits nothing", () => {
		const { pi, emitted, sent } = makePiWithSend()
		process.env[steerDisableFlagName("exploration_guard")] = "1"
		const ok = sendSteer(pi, makeCtx(), {
			kind: "exploration_guard",
			reason: "turn_end",
			customType: "exploration-guard-steer",
			text: "stop exploring",
		})

		expect(ok).toBe(false)
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
