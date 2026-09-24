import { afterEach, describe, expect, it } from "vitest"
import { readE2eSeam } from "./e2e-seam.js"

const SEAM = "KIMCHI_E2E_TEST_SEAM"

describe("readE2eSeam", () => {
	afterEach(() => {
		delete process.env[SEAM]
	})

	it("returns the seam value under a test harness (vitest sets VITEST)", () => {
		process.env[SEAM] = "1"
		expect(readE2eSeam(SEAM)).toBe("1")
	})

	it("returns undefined for an unset seam", () => {
		expect(readE2eSeam(SEAM)).toBeUndefined()
	})

	it("KIMCHI_TEST_HARNESS=1 (tui-test runner) also unlocks the seam", () => {
		process.env[SEAM] = "approve"
		const saved = process.env.KIMCHI_TEST_HARNESS
		process.env.KIMCHI_TEST_HARNESS = "1"
		try {
			expect(readE2eSeam(SEAM)).toBe("approve")
		} finally {
			if (saved === undefined) delete process.env.KIMCHI_TEST_HARNESS
			else process.env.KIMCHI_TEST_HARNESS = saved
		}
	})

	it("is dead outside a test harness — a stray seam var never reaches production", () => {
		process.env[SEAM] = "1"
		const savedVitest = process.env.VITEST
		const savedWorkerId = process.env.VITEST_WORKER_ID
		delete process.env.VITEST
		delete process.env.VITEST_WORKER_ID
		try {
			expect(readE2eSeam(SEAM)).toBeUndefined()
		} finally {
			if (savedVitest !== undefined) process.env.VITEST = savedVitest
			if (savedWorkerId !== undefined) process.env.VITEST_WORKER_ID = savedWorkerId
		}
	})
})
