import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	emitSteerFired,
	emitSteerOutcome,
	isSteerDisabled,
	STEER_EVENTS,
	type SteerFiredPayload,
	type SteerKind,
	type SteerOutcomePayload,
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
})
