import { expect, it } from "vitest"
import { mapInChunks, runCooperatively, runSynchronously } from "./cooperative.js"

function* calculation(): Generator<void, number> {
	let result = 0
	for (let index = 0; index < 100; index++) {
		result += index
		yield
	}
	return result
}

it("yields to the event loop without changing the synchronous result", async () => {
	let turns = 0
	setImmediate(() => turns++)
	let checks = 0
	const result = await runCooperatively(calculation(), () => checks++, 0)
	expect(result).toBe(runSynchronously(calculation()))
	expect(turns).toBe(1)
	expect(checks).toBeGreaterThan(1)
})

it("maps ordered values in bounded chunks", () => {
	const steps = mapInChunks([1, 2, 3, 4, 5], 2, (value) => value * 3)
	expect(steps.next()).toEqual({ done: false, value: undefined })
	expect(steps.next()).toEqual({ done: false, value: undefined })
	expect(steps.next()).toEqual({ done: false, value: undefined })
	expect(steps.next()).toEqual({ done: true, value: [3, 6, 9, 12, 15] })
})

it("propagates cancellation before advancing the next calculation step", async () => {
	let advanced = 0
	function* steps(): Generator<void, void> {
		for (;;) {
			advanced++
			yield
		}
	}
	await expect(
		runCooperatively(
			steps(),
			() => {
				if (advanced === 2) throw new Error("lease lost")
			},
			0,
		),
	).rejects.toThrow("lease lost")
	expect(advanced).toBe(2)
})
