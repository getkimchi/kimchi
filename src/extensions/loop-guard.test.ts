import { describe, expect, it } from "vitest"
import { LoopGuard, type ToolHistoryRecord, fingerprint } from "./loop-guard.js"

const FP_A = "fp_a"
const FP_B = "fp_b"
const FP_C = "fp_c"

function rec(overrides: Partial<ToolHistoryRecord> = {}): ToolHistoryRecord {
	return {
		toolName: "bash",
		toolArgs: '{"command":"ls"}',
		isError: false,
		outputFingerprint: FP_A,
		...overrides,
	}
}

function feed(guard: LoopGuard, records: ToolHistoryRecord[]): Array<ReturnType<LoopGuard["record"]>> {
	return records.map((r) => guard.record(r))
}

function repeat<T>(value: T, n: number): T[] {
	return Array.from({ length: n }, () => value)
}

describe("LoopGuard.reset", () => {
	it("clears history so n-gram detection restarts", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ toolArgs: '{"command":"a"}', isError: true, outputFingerprint: FP_A }), 6))
		guard.reset()
		const states = feed(guard, repeat(rec({ toolArgs: '{"command":"a"}', isError: true, outputFingerprint: FP_A }), 2))
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("clears warning fuse", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true }), 3))
		expect(guard.isWarned()).toBe(true)
		guard.reset()
		expect(guard.isWarned()).toBe(false)
	})

	it("clears triggered flag", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true }), 4))
		expect(guard.isTriggered()).toBe(true)
		guard.reset()
		expect(guard.isTriggered()).toBe(false)
	})
})

describe("LoopGuard window of 30 records", () => {
	it("evicts oldest entries beyond 30 so old patterns cannot trigger detectors", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ toolArgs: '{"command":"old"}', isError: true, outputFingerprint: FP_A }), 4))
		for (let i = 0; i < 30; i++) {
			guard.record(rec({ toolArgs: `{"command":"unique-${i}"}`, outputFingerprint: `u${i}` }))
		}
		const next = guard.record(rec({ toolArgs: '{"command":"old"}', isError: true, outputFingerprint: FP_A }))
		expect(next.state).toBe("ok")
	})

	it("n-gram detection only considers records inside the window", () => {
		const guard = new LoopGuard()
		// Vary fingerprints so detector 1 (consecutive identical) does not fire.
		for (let i = 0; i < 4; i++) {
			guard.record(rec({ toolArgs: '{"command":"x"}', outputFingerprint: `x-${i}` }))
		}
		for (let i = 0; i < 30; i++) {
			guard.record(rec({ toolArgs: `{"command":"f-${i}"}`, outputFingerprint: `f${i}` }))
		}
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 4; i < 8; i++) {
			states.push(guard.record(rec({ toolArgs: '{"command":"x"}', outputFingerprint: `x-${i}` })))
		}
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})
})

describe("fingerprint", () => {
	it("returns the same value for identical input", () => {
		const text = ["line1", "line2", "line3"].join("\n")
		expect(fingerprint(text)).toBe(fingerprint(text))
	})

	it("returns different values for different inputs", () => {
		expect(fingerprint("a")).not.toBe(fingerprint("b"))
	})

	it("only depends on the last 20 lines", () => {
		const tail = Array.from({ length: 20 }, (_, i) => `tail${i}`).join("\n")
		const headA = Array.from({ length: 50 }, (_, i) => `headA${i}`).join("\n")
		const headB = Array.from({ length: 80 }, (_, i) => `headB${i}`).join("\n")
		expect(fingerprint(`${headA}\n${tail}`)).toBe(fingerprint(`${headB}\n${tail}`))
	})

	it("differs when the last 20 lines differ", () => {
		const head = Array.from({ length: 100 }, (_, i) => `same${i}`).join("\n")
		const tailA = Array.from({ length: 20 }, (_, i) => `a${i}`).join("\n")
		const tailB = Array.from({ length: 20 }, (_, i) => `b${i}`).join("\n")
		expect(fingerprint(`${head}\n${tailA}`)).not.toBe(fingerprint(`${head}\n${tailB}`))
	})
})

describe("Consecutive identical errors detector", () => {
	it("warns on the 3rd consecutive identical failing call", () => {
		const guard = new LoopGuard()
		const r = rec({ isError: true, outputFingerprint: FP_A })
		expect(guard.record(r).state).toBe("ok")
		expect(guard.record(r).state).toBe("ok")
		expect(guard.record(r).state).toBe("warn")
	})

	it("terminates on the 4th consecutive identical failing call", () => {
		const guard = new LoopGuard()
		const r = rec({ isError: true, outputFingerprint: FP_A })
		feed(guard, repeat(r, 3))
		expect(guard.record(r).state).toBe("terminate")
		expect(guard.isTriggered()).toBe(true)
	})

	it("breaks the streak on a successful call", () => {
		const guard = new LoopGuard()
		const fail = rec({ isError: true, outputFingerprint: FP_A })
		feed(guard, [fail, fail, rec({ isError: false, outputFingerprint: FP_A }), fail, fail])
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("breaks the streak when output fingerprint differs", () => {
		const guard = new LoopGuard()
		const states = feed(guard, [
			rec({ isError: true, outputFingerprint: FP_A }),
			rec({ isError: true, outputFingerprint: FP_B }),
			rec({ isError: true, outputFingerprint: FP_A }),
		])
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("breaks the streak when toolArgs differ", () => {
		const guard = new LoopGuard()
		const states = feed(guard, [
			rec({ isError: true, toolArgs: '{"command":"a"}' }),
			rec({ isError: true, toolArgs: '{"command":"b"}' }),
			rec({ isError: true, toolArgs: '{"command":"a"}' }),
		])
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})
})

describe("Fuzzy ngram detector (toolName + toolArgs only)", () => {
	it("does not fire at exactly 6 reps of a 2-gram (12 records)", () => {
		const guard = new LoopGuard()
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 0; i < 6; i++) {
			states.push(guard.record(rec({ toolArgs: '{"command":"a"}', outputFingerprint: `a-${i}` })))
			states.push(guard.record(rec({ toolArgs: '{"command":"b"}', outputFingerprint: `b-${i}` })))
		}
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("fires above 6 reps of a 2-gram", () => {
		const guard = new LoopGuard()
		for (let i = 0; i < 7; i++) {
			guard.record(rec({ toolArgs: '{"command":"a"}', outputFingerprint: `a-${i}` }))
			guard.record(rec({ toolArgs: '{"command":"b"}', outputFingerprint: `b-${i}` }))
		}
		expect(guard.isWarned()).toBe(true)
	})

	it("does not fire at exactly 4 reps of a 3-gram (12 records)", () => {
		const guard = new LoopGuard()
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 0; i < 4; i++) {
			states.push(guard.record(rec({ toolArgs: '{"command":"a"}', outputFingerprint: `a-${i}` })))
			states.push(guard.record(rec({ toolArgs: '{"command":"b"}', outputFingerprint: `b-${i}` })))
			states.push(guard.record(rec({ toolArgs: '{"command":"c"}', outputFingerprint: `c-${i}` })))
		}
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("fires above 4 reps of a 3-gram", () => {
		const guard = new LoopGuard()
		for (let i = 0; i < 5; i++) {
			guard.record(rec({ toolArgs: '{"command":"a"}', outputFingerprint: `a-${i}` }))
			guard.record(rec({ toolArgs: '{"command":"b"}', outputFingerprint: `b-${i}` }))
			guard.record(rec({ toolArgs: '{"command":"c"}', outputFingerprint: `c-${i}` }))
		}
		expect(guard.isWarned()).toBe(true)
	})

	it("ignores isError and outputFingerprint differences", () => {
		const guard = new LoopGuard()
		for (let i = 0; i < 7; i++) {
			guard.record(
				rec({
					toolArgs: '{"command":"a"}',
					isError: i % 2 === 1,
					outputFingerprint: `out-${i}`,
				}),
			)
			guard.record(
				rec({
					toolArgs: '{"command":"b"}',
					isError: (i + 1) % 2 === 1,
					outputFingerprint: `outb-${i}`,
				}),
			)
		}
		expect(guard.isWarned()).toBe(true)
	})

	it("does not fire when the alternation breaks before threshold", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}' })
		const b = rec({ toolArgs: '{"command":"b"}' })
		const c = rec({ toolArgs: '{"command":"c"}' })
		for (let i = 0; i < 4; i++) {
			guard.record(a)
			guard.record(b)
		}
		guard.record(c)
		guard.record(b)
		expect(guard.isWarned()).toBe(false)
	})
})

describe("Exact ngram detector (all 4 fields)", () => {
	it("does not fire at exactly 5 reps of an exact 2-gram (10 records)", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', isError: true, outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', isError: true, outputFingerprint: FP_B })
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 0; i < 5; i++) {
			states.push(guard.record(a))
			states.push(guard.record(b))
		}
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("fires above 5 reps of an exact 2-gram", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', isError: true, outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', isError: true, outputFingerprint: FP_B })
		for (let i = 0; i < 5; i++) {
			guard.record(a)
			guard.record(b)
		}
		guard.record(a)
		const last = guard.record(b)
		expect(last.state === "warn" || last.state === "terminate").toBe(true)
	})

	it("does not fire at exactly 3 reps of an exact 3-gram (9 records)", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', outputFingerprint: FP_B })
		const c = rec({ toolArgs: '{"command":"c"}', outputFingerprint: FP_C })
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 0; i < 3; i++) {
			states.push(guard.record(a))
			states.push(guard.record(b))
			states.push(guard.record(c))
		}
		expect(states.every((s) => s.state === "ok")).toBe(true)
	})

	it("fires above 3 reps of an exact 3-gram", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', outputFingerprint: FP_B })
		const c = rec({ toolArgs: '{"command":"c"}', outputFingerprint: FP_C })
		for (let i = 0; i < 3; i++) {
			guard.record(a)
			guard.record(b)
			guard.record(c)
		}
		guard.record(a)
		guard.record(b)
		const last = guard.record(c)
		expect(last.state === "warn" || last.state === "terminate").toBe(true)
	})

	it("requires isError and outputFingerprint to match (not just toolArgs)", () => {
		const guard = new LoopGuard()
		for (let i = 0; i < 6; i++) {
			guard.record(rec({ toolArgs: '{"command":"a"}', isError: i % 2 === 1, outputFingerprint: `fp-${i}` }))
		}
		expect(guard.isWarned()).toBe(false)
	})
})

describe("Shared warning fuse", () => {
	it("warn from one detector + fire from another → terminate", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.isWarned()).toBe(true)
		expect(guard.isTriggered()).toBe(false)

		const a = rec({ toolArgs: '{"command":"x"}', outputFingerprint: "x1" })
		const b = rec({ toolArgs: '{"command":"y"}', outputFingerprint: "y1" })
		let last: ReturnType<LoopGuard["record"]> = { state: "ok" }
		for (let i = 0; i < 5; i++) {
			last = guard.record(a)
			last = guard.record(b)
		}
		last = guard.record(a)
		last = guard.record(b)
		expect(last.state).toBe("terminate")
		expect(guard.isTriggered()).toBe(true)
	})

	it("two near-misses below threshold stay ok", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', isError: true, outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', isError: true, outputFingerprint: FP_B })
		for (let i = 0; i < 4; i++) {
			guard.record(a)
			guard.record(b)
		}
		guard.record(rec({ toolArgs: '{"command":"reset"}', outputFingerprint: "r1" }))
		const c = rec({ toolArgs: '{"command":"c"}', isError: true, outputFingerprint: FP_C })
		const d = rec({ toolArgs: '{"command":"d"}', isError: true, outputFingerprint: "fp_d" })
		for (let i = 0; i < 4; i++) {
			guard.record(c)
			guard.record(d)
		}
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("warn → next ok call → next detector fire still terminates (fuse does not reset)", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.isWarned()).toBe(true)
		guard.record(rec({ toolArgs: '{"command":"recover"}', outputFingerprint: "r1" }))
		const r = rec({ isError: true, outputFingerprint: "fp_r" })
		feed(guard, repeat(r, 2))
		const last = guard.record(r)
		expect(last.state).toBe("terminate")
	})
})

describe("LoopGuard.blockIfLoop (pre-execution prediction)", () => {
	it("returns false before any warning", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 2))
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"ls"}' })).toBe(false)
	})

	it("fires and sets triggered when next call would complete a consecutive-identical loop", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"ls"}' })).toBe(true)
		expect(guard.isTriggered()).toBe(true)
	})

	it("returns false for a clearly different next call", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"different"}' })).toBe(false)
	})

	it("does not mutate history on a non-firing prediction", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"different"}' })
		expect(guard.record(rec({ isError: true, outputFingerprint: FP_A })).state).toBe("terminate")
	})

	it("returns true when next call would extend an alternating 2-gram", () => {
		const guard = new LoopGuard()
		const a = rec({ toolArgs: '{"command":"a"}', outputFingerprint: FP_A })
		const b = rec({ toolArgs: '{"command":"b"}', outputFingerprint: FP_B })
		for (let i = 0; i < 5; i++) {
			guard.record(a)
			guard.record(b)
		}
		guard.record(a)
		guard.record(b)
		expect(guard.isWarned()).toBe(true)
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"a"}' })).toBe(true)
	})
})

describe("Edit-then-rerun cycle must NOT fire", () => {
	it("edit (changing) + bash (same args, changing fingerprint) for 5 iterations", () => {
		const guard = new LoopGuard()
		const bashArgs = '{"command":"run-tests"}'
		for (let i = 0; i < 5; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"file_path":"a.py","new_string":"v${i}"}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: bashArgs,
				isError: true,
				outputFingerprint: `out-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("multi-step build/run/check cycle with changing outputs", () => {
		const guard = new LoopGuard()
		const build = '{"command":"build"}'
		const run = '{"command":"run"}'
		const check = '{"command":"check"}'
		for (let i = 0; i < 4; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"file_path":"src.c","new_string":"v${i}"}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({ toolName: "bash", toolArgs: build, isError: false, outputFingerprint: `build-${i}` })
			guard.record({ toolName: "bash", toolArgs: run, isError: false, outputFingerprint: `run-${i}` })
			guard.record({ toolName: "bash", toolArgs: check, isError: true, outputFingerprint: `check-${i}` })
		}
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})
})
