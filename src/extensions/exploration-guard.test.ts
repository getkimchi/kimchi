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
		expect(steers[0]).toContain("5 consecutive turns")
		expect(steers[0]).toContain("hypothesis")
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
		expect(steers[1]).toContain("8 consecutive turns")
		expect(steers[1]).toContain("MUST")
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
		expect(steers[0]).toContain("2 consecutive turns")

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(1)

		guard.turnStart()
		guard.recordToolCall("ls")
		guard.turnEnd((text) => steers.push(text))
		expect(steers).toHaveLength(2)
		expect(steers[1]).toContain("4 consecutive turns")
	})

	it("does not trigger twice on the same threshold", () => {
		const guard = createGuard()
		const steers: string[] = []
		for (let i = 0; i < 10; i++) {
			guard.turnStart()
			guard.recordToolCall("read")
			guard.turnEnd((text) => steers.push(text))
		}
		expect(steers.filter((s) => s.includes("5 consecutive turns"))).toHaveLength(1)
		expect(steers.filter((s) => s.includes("8 consecutive turns"))).toHaveLength(1)
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
				expect(steers[0]).toContain("5 consecutive turns")
			}
		}
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

describe("STEER_MESSAGE_TYPE", () => {
	it("has a stable custom type string", () => {
		expect(STEER_MESSAGE_TYPE).toBe("exploration-guard-steer")
	})
})
