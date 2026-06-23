import { afterEach, describe, expect, it, vi } from "vitest"
import { ExplorationGuard, type ExplorationGuardOptions, STEER_MESSAGE_TYPE } from "./exploration-guard.js"
import type { PromptVariant } from "./prompt-construction/variants/index.js"

const mockResolvePromptVariant = vi.fn((): PromptVariant => ({ name: "default" }))

vi.mock("./permissions/mode-controller.js", () => ({
	getPermissionMode: vi.fn(() => undefined),
}))

vi.mock("./prompt-construction/variants/index.js", () => ({
	resolvePromptVariant: () => mockResolvePromptVariant(),
}))

afterEach(() => {
	mockResolvePromptVariant.mockReturnValue({ name: "default" })
})

function createGuard(options?: ExplorationGuardOptions): ExplorationGuard {
	return new ExplorationGuard(options)
}

function simulateReadTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.recordToolCall("read")
	guard.turnEnd((text) => steers.push(text))
	return steers
}

function simulateWriteTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.recordToolCall("edit")
	guard.turnEnd((text) => steers.push(text))
	return steers
}

function simulateNoToolTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.turnEnd((text) => steers.push(text))
	return steers
}

function simulateMixedTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.recordToolCall("read")
	guard.recordToolCall("edit")
	guard.turnEnd((text) => steers.push(text))
	return steers
}

function simulateNeutralTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.recordToolCall("set_phase")
	guard.turnEnd((text) => steers.push(text))
	return steers
}

function simulateNeutralPlusReadTurn(guard: ExplorationGuard): string[] {
	const steers: string[] = []
	guard.turnStart()
	guard.recordToolCall("set_phase")
	guard.recordToolCall("read")
	guard.turnEnd((text) => steers.push(text))
	return steers
}

describe("ExplorationGuard.reset", () => {
	it("clears the streak", () => {
		const guard = createGuard()
		for (let i = 0; i < 4; i++) simulateReadTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(4)
		guard.reset()
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})
})

describe("Read-only turn counting", () => {
	it("increments streak on consecutive read-only turns", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(3)
	})

	it("resets streak on a write turn", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		simulateWriteTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("resets streak on a no-tool turn", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		simulateNoToolTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("resets streak on a mixed read+write turn", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		simulateMixedTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("does not increment on the first tool-less turn", () => {
		const guard = createGuard()
		simulateNoToolTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("resets streak on a neutral tool turn", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		simulateNeutralTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("counts a mixed neutral+read turn as read-only", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		simulateNeutralPlusReadTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(4)
	})
})

describe("Threshold triggers", () => {
	it("emits a reminder at the default hypothesis threshold (5)", () => {
		const guard = createGuard()
		const steers: string[] = []
		for (let i = 0; i < 4; i++) simulateReadTurn(guard)
		expect(steers).toHaveLength(0)

		// 5th read-only turn triggers reminder
		guard.turnStart()
		guard.recordToolCall("read")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)
		expect(steers[0]).toContain("Exploration guard")
		expect(steers[0]).toContain("5 consecutive read-only turns")
		expect(steers[0]).toContain("concrete action")
	})

	it("emits a mandatory steer at the default steer threshold (8)", () => {
		const guard = createGuard()
		const steers: string[] = []
		for (let i = 0; i < 7; i++) {
			guard.turnStart()
			guard.recordToolCall("grep")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers).toHaveLength(1) // only the reminder at 5

		// 8th read-only turn triggers mandatory steer
		guard.turnStart()
		guard.recordToolCall("find")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(2)
		expect(steers[1]).toContain("8 consecutive read-only turns")
		expect(steers[1]).toContain("concrete action")
	})

	it("uses custom thresholds", () => {
		const guard = createGuard({ hypothesisThreshold: 2, steerThreshold: 4 })
		const steers: string[] = []

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(0)

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)
		expect(steers[0]).toContain("2 consecutive read-only turns")

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(2)
		expect(steers[1]).toContain("4 consecutive read-only turns")
	})

	it("each threshold fires once per streak; mandatory steer resets the counter", () => {
		// 5 turns → hypothesis steer (no reset, counter stays at 5)
		// 8 turns → mandatory steer + reset (counter back to 0)
		// 5 more turns → hypothesis steer again in the new streak
		const guard = createGuard()
		const steers: string[] = []
		const readTurn = () => {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}

		for (let i = 0; i < 8; i++) readTurn()
		expect(steers).toHaveLength(2)
		expect(steers[0]).toContain("5 consecutive read-only turns")
		expect(steers[1]).toContain("8 consecutive read-only turns")
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)

		for (let i = 0; i < 5; i++) readTurn() // new streak after reset
		expect(steers).toHaveLength(3)
		expect(steers[2]).toContain("5 consecutive read-only turns")
	})

	it("resets counter after mandatory steer fires", () => {
		const guard = createGuard({ hypothesisThreshold: 99 }) // skip hypothesis steer
		const steers: string[] = []

		for (let i = 0; i < 8; i++) {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers).toHaveLength(1)
		expect(steers[0]).toContain("concrete action")
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)

		// Subsequent read turns start a fresh streak
		for (let i = 0; i < 4; i++) {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd(() => {})
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(4)
		expect(steers).toHaveLength(1)
	})

	it("does not trigger when isEnabled returns false", () => {
		const guard = createGuard({ isEnabled: () => false })
		for (let i = 0; i < 10; i++) {
			const steers = simulateReadTurn(guard)
			expect(steers).toHaveLength(0)
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("resumes triggering after isEnabled becomes true", () => {
		let enabled = false
		const guard = createGuard({ isEnabled: () => enabled })
		for (let i = 0; i < 5; i++) {
			simulateReadTurn(guard)
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)

		enabled = true
		for (let i = 0; i < 5; i++) {
			const steers = simulateReadTurn(guard)
			if (i === 4) {
				expect(steers).toHaveLength(1)
				expect(steers[0]).toContain("5 consecutive read-only turns")
			}
		}
	})

	it("resets streak while disabled so it does not fire immediately on re-enable", () => {
		// Simulates: 4 read turns → guard disabled (e.g. scoping starts) →
		// 3 more read turns while disabled → guard re-enabled → should need
		// a full 5 turns before firing, not just 1.
		let enabled = true
		const guard = createGuard({ isEnabled: () => enabled })

		for (let i = 0; i < 4; i++) simulateReadTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(4)

		enabled = false
		for (let i = 0; i < 3; i++) simulateReadTurn(guard)
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)

		enabled = true
		const steers: string[] = []
		for (let i = 0; i < 4; i++) {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers).toHaveLength(0) // streak only at 4, not yet at 5
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(4)
	})
})

describe("Custom tool classification", () => {
	it("treats custom read tools as read-only", () => {
		const guard = createGuard({ readTools: new Set(["custom_read"]), writeTools: new Set(["custom_write"]) })
		const steers: string[] = []
		for (let i = 0; i < 5; i++) {
			guard.turnStart()
			guard.recordToolCall("custom_read")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers).toHaveLength(1)
	})

	it("treats custom write tools as write operations", () => {
		const guard = createGuard({ readTools: new Set(["custom_read"]), writeTools: new Set(["custom_write"]) })
		for (let i = 0; i < 4; i++) {
			guard.turnStart()
			guard.recordToolCall("custom_read")
			guard.turnEnd(() => {})
		}
		guard.turnStart()
		guard.recordToolCall("custom_write")
		guard.turnEnd(() => {})
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})
})

describe("bash tool classification", () => {
	it("bash alone does not count as a read-only turn", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) {
			guard.turnStart()
			guard.recordToolCall("bash")
			guard.turnEnd(() => {})
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("bash resets a read-only streak", () => {
		const guard = createGuard()
		for (let i = 0; i < 3; i++) {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd(() => {})
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(3)
		guard.turnStart()
		guard.recordToolCall("bash")
		guard.turnEnd(() => {})
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0)
	})

	it("bash combined with a read tool still counts as read-only", () => {
		const guard = createGuard()
		guard.turnStart()
		guard.recordToolCall("bash")
		guard.recordToolCall("read")
		guard.turnEnd(() => {})
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(1)
	})
})

describe("STEER_MESSAGE_TYPE", () => {
	it("has a stable custom type string", () => {
		expect(STEER_MESSAGE_TYPE).toBe("exploration-guard-steer")
	})
})

describe("explorationGuardExtension - warn sendMessage delivery", () => {
	it("delivers warn message with deliverAs: steer", async () => {
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")

		type Handler = (event: unknown, ctx?: unknown) => unknown
		const handlers = new Map<string, Handler[]>()
		const sendMessage = vi.fn()
		const pi = {
			on: (event: string, handler: Handler) => {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			sendMessage,
		}

		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })

		// Provide a ctx with a sessionManager so isEnabled() returns true (non-plan session)
		const mockCtx = { sessionManager: { getSessionId: () => "test-session" } }
		for (const h of handlers.get("session_start") ?? []) h({}, mockCtx)

		// Drive 1 read-only turn to reach the hypothesis threshold
		for (const h of handlers.get("turn_start") ?? []) h({})
		for (const h of handlers.get("tool_call") ?? []) h({ toolName: "read" })
		for (const h of handlers.get("turn_end") ?? []) h({})

		expect(sendMessage).toHaveBeenCalledOnce()
		const [, options] = sendMessage.mock.calls[0]
		expect(options).toEqual({ deliverAs: "steer" })
	})
})

describe("explorationGuardExtension - variant suppression", () => {
	type Handler = (event: unknown, ctx?: unknown) => unknown

	function createPi() {
		const handlers = new Map<string, Handler[]>()
		const sendMessage = vi.fn()
		const pi = {
			on: (event: string, handler: Handler) => {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			sendMessage,
		}
		return { pi, handlers, sendMessage }
	}

	const mockCtx = { sessionManager: { getSessionId: () => "test-session" } }

	function driveReadTurn(handlers: Map<string, Handler[]>): void {
		for (const h of handlers.get("session_start") ?? []) h({}, mockCtx)
		for (const h of handlers.get("turn_start") ?? []) h({})
		for (const h of handlers.get("tool_call") ?? []) h({ toolName: "read" })
		for (const h of handlers.get("turn_end") ?? []) h({})
	}

	// The factory calls resolvePromptVariant() at invocation time, so updating the
	// mock before each call is sufficient - no vi.resetModules() needed.

	it("registers no handlers when variant is v2 (suppressExplorationGuard: true)", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "v2", suppressExplorationGuard: true })
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { pi, handlers } = createPi()
		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })
		expect(handlers.get("session_start")).toBeUndefined()
		expect(handlers.get("turn_start")).toBeUndefined()
		expect(handlers.get("tool_call")).toBeUndefined()
		expect(handlers.get("turn_end")).toBeUndefined()
	})

	it("does not steer on read-only turns when variant is v2", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "v2", suppressExplorationGuard: true })
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { pi, handlers, sendMessage } = createPi()
		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })
		driveReadTurn(handlers)
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("registers no handlers when variant is opinionated-v2 (inherits suppressExplorationGuard: true)", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "opinionated-v2", suppressExplorationGuard: true })
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { pi, handlers } = createPi()
		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })
		expect(handlers.get("session_start")).toBeUndefined()
		expect(handlers.get("turn_start")).toBeUndefined()
		expect(handlers.get("tool_call")).toBeUndefined()
		expect(handlers.get("turn_end")).toBeUndefined()
	})

	it("does not steer on read-only turns when variant is opinionated-v2", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "opinionated-v2", suppressExplorationGuard: true })
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { pi, handlers, sendMessage } = createPi()
		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })
		driveReadTurn(handlers)
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("still steers on read-only turns with the default variant", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "default" })
		const { default: explorationGuardExtension } = await import("./exploration-guard.js")
		const { pi, handlers, sendMessage } = createPi()
		explorationGuardExtension(pi as never, { hypothesisThreshold: 1 })
		driveReadTurn(handlers)
		expect(sendMessage).toHaveBeenCalledOnce()
	})
})
