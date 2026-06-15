import { describe, expect, it, vi } from "vitest"
import { ExplorationGuard, type ExplorationGuardOptions, STEER_MESSAGE_TYPE } from "./exploration-guard.js"

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
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers).toHaveLength(1) // only the reminder at 5

		// 8th read-only turn triggers mandatory steer
		guard.turnStart()
		guard.recordToolCall("web_search")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(2)
		expect(steers[1]).toContain("8 consecutive read-only turns")
		expect(steers[1]).toContain("concrete action")
	})

	it("uses custom thresholds", () => {
		const guard = createGuard({ hypothesisThreshold: 2, steerThreshold: 4 })
		const steers: string[] = []

		guard.turnStart()
		guard.recordToolCall("read")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(0)

		guard.turnStart()
		guard.recordToolCall("read")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)
		expect(steers[0]).toContain("2 consecutive read-only turns")

		guard.turnStart()
		guard.recordToolCall("read")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)

		guard.turnStart()
		guard.recordToolCall("read")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(2)
		expect(steers[1]).toContain("4 consecutive read-only turns")
	})

	it("each threshold fires once per streak; mandatory steer resets the counter to hypothesisThreshold", () => {
		// 5 turns → hypothesis steer (no reset, counter stays at 5)
		// 8 turns → mandatory steer + reset (counter back to hypothesisThreshold=5)
		// 3 more turns → mandatory steer again (counter hits steerThreshold=8 again)
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
		// Counter resets to hypothesisThreshold (5), not 0
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(5)

		// Only 3 more read-only turns needed to reach steerThreshold (8) again
		for (let i = 0; i < 3; i++) readTurn()
		expect(steers).toHaveLength(3)
		expect(steers[2]).toContain("8 consecutive read-only turns")
	})

	it("resets counter to hypothesisThreshold after mandatory steer fires", () => {
		// Custom thresholds: hypothesis at 2, mandatory steer at 4.
		// After the mandatory steer at turn 4, counter resets to 2 (hypothesisThreshold).
		// The next 2 read-only turns (turns 5 and 6) increment it to 4 again,
		// firing the mandatory steer a second time.
		const guard = createGuard({ hypothesisThreshold: 2, steerThreshold: 4 })
		const steers: string[] = []
		const readTurn = () => {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}

		// Turns 1-4: hypothesis at 2, mandatory at 4
		for (let i = 0; i < 4; i++) readTurn()
		expect(steers).toHaveLength(2)
		expect(steers[0]).toContain("2 consecutive read-only turns")
		expect(steers[1]).toContain("4 consecutive read-only turns")
		// Counter resets to hypothesisThreshold (2), not 0
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(2)

		// Only 2 more turns needed to reach steerThreshold (4) again
		readTurn() // counter = 3, no steer
		expect(steers).toHaveLength(2)
		readTurn() // counter = 4, mandatory steer fires again
		expect(steers).toHaveLength(3)
		expect(steers[2]).toContain("4 consecutive read-only turns")
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
