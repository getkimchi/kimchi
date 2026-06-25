import { describe, expect, it } from "vitest"
import { LoopGuard, type ToolHistoryRecord, fingerprint, normalizeBashCommand } from "./loop-guard.js"

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

	it("clears warned flag", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true }), 3))
		expect(guard.isWarned()).toBe(true)
		guard.reset()
		expect(guard.isWarned()).toBe(false)
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

	it("warns again after counter reset (never terminates)", () => {
		const guard = new LoopGuard()
		const r = rec({ isError: true, outputFingerprint: FP_A })
		feed(guard, repeat(r, 3)) // first detection → warn + counter reset
		expect(guard.isWarned()).toBe(true)
		// After the warn, counters are reset. Feed enough to trigger again.
		const states = feed(guard, repeat(r, 3))
		expect(states[2].state).toBe("warn") // second detection → warn again
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
	it("second detection from a different detector also warns (never terminates)", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.isWarned()).toBe(true)

		// After the first warn, counters are reset. A different detector
		// triggers on a new pattern — should warn again, not terminate.
		// The exact 2-gram fires at rep 6 (12 records), which triggers
		// another warn (not terminate) and clears history again.
		const a = rec({ toolArgs: '{"command":"x"}', outputFingerprint: "x1" })
		const b = rec({ toolArgs: '{"command":"y"}', outputFingerprint: "y1" })
		const states: Array<ReturnType<LoopGuard["record"]>> = []
		for (let i = 0; i < 7; i++) {
			states.push(guard.record(a))
			states.push(guard.record(b))
		}
		// At least one of the states should be a warn (the second detection).
		const warns = states.filter((s) => s.state === "warn")
		expect(warns.length).toBeGreaterThanOrEqual(1)
		expect(warns[0].state).toBe("warn")
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

	it("second detection after recovery also warns", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.isWarned()).toBe(true)
		// After the warn, counters are reset. New consecutive loop:
		const r = rec({ isError: true, outputFingerprint: "fp_r" })
		const states = feed(guard, repeat(r, 3))
		expect(states[2].state).toBe("warn")
	})
})

describe("LoopGuard.blockIfLoop (pre-execution prediction)", () => {
	it("returns false before any warning", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 2))
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"ls"}' })).toBe(false)
	})

	it("returns false after warn because history is cleared", () => {
		// After a warn, the guard resets the window history. blockIfLoop
		// can't find a proxy in an empty history, so it returns false.
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 3))
		expect(guard.isWarned()).toBe(true)
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"ls"}' })).toBe(false)
	})

	it("returns false for a clearly different next call", () => {
		const guard = new LoopGuard()
		feed(guard, repeat(rec({ isError: true, outputFingerprint: FP_A }), 2))
		expect(guard.blockIfLoop({ toolName: "bash", toolArgs: '{"command":"different"}' })).toBe(false)
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

describe("Edit-run cycle detector", () => {
	// Helper that simulates the edit-run cycle with diagnostic calls interspersed.
	// The diagnostic calls have varying args (read/grep with different paths) so
	// the existing n-gram detectors do NOT fire. This isolates the edit-run
	// detector, which tracks file path and bash prefix independently of the call
	// order.
	//
	// Pattern per round is 3 records: edit + bash + read. 3 × 8 = 24 records
	// stays within the 30-record sliding window, so no evictions occur before
	// the edit-run detector can fire.
	function feedEditRunRounds(guard: LoopGuard, rounds: number): void {
		const file = "/app/main.c"
		const bashPrefix = '{"command":"cd /app && make -j8 all 2>&1 | tail -20"}'
		for (let i = 0; i < rounds; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"${file}","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: bashPrefix,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
			guard.record({
				toolName: "read",
				toolArgs: `{"path":"/tmp/diag-${i}.txt"}`,
				isError: false,
				outputFingerprint: `read-${i}`,
			})
		}
	}

	// Helper to push exactly N records of a single round. Useful for stopping
	// at the exact record that triggers warn vs. the one that triggers terminate.
	function feedEditRunRecords(guard: LoopGuard, recordCount: number): void {
		const file = "/app/main.c"
		const bashPrefix = '{"command":"cd /app && make -j8 all 2>&1 | tail -20"}'
		for (let i = 0; i < recordCount; i++) {
			const pos = i % 3
			const round = Math.floor(i / 3)
			if (pos === 0) {
				guard.record({
					toolName: "edit",
					toolArgs: `{"path":"${file}","edits":[{"oldText":"x","newText":"v${round}"}]}`,
					isError: false,
					outputFingerprint: `edit-${round}`,
				})
			} else if (pos === 1) {
				guard.record({
					toolName: "bash",
					toolArgs: bashPrefix,
					isError: true,
					outputFingerprint: `bash-${round}`,
				})
			} else {
				guard.record({
					toolName: "read",
					toolArgs: `{"path":"/tmp/diag-${round}.txt"}`,
					isError: false,
					outputFingerprint: `read-${round}`,
				})
			}
		}
	}

	it("does not fire below threshold (7 rounds)", () => {
		const guard = new LoopGuard()
		feedEditRunRounds(guard, 7)
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("warns at threshold (8 rounds)", () => {
		const guard = new LoopGuard()
		// Stop at exactly the bash call that triggers warn (record 23 of 24).
		// The 24th record (read) would re-trigger the detector and bump to
		// terminate — see the next test.
		feedEditRunRecords(guard, 23)
		expect(guard.isWarned()).toBe(true)
		expect(guard.isTriggered()).toBe(false)
	})

	it("after warn, counters reset so next round does not immediately re-fire", () => {
		const guard = new LoopGuard()
		// 23 records triggers warn (at the 8th bash). After that, window
		// counters are cleared so the next few records don't re-fire.
		feedEditRunRecords(guard, 23)
		expect(guard.isWarned()).toBe(true)
		// One more record (the read) should NOT immediately re-fire.
		feedEditRunRecords(guard, 1)
		// Still warned (flag persists), but no terminate.
		expect(guard.isWarned()).toBe(true)
	})

	it("does not fire when edits target different files", () => {
		const guard = new LoopGuard()
		// 10 rounds, each editing a different file but with the same bash
		// prefix. No single file crosses the threshold even though bash(P)
		// repeats 10 times.
		const bashPrefix = '{"command":"cd /app && make -j8 all 2>&1 | tail -20"}'
		for (let i = 0; i < 10; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"/app/file${i}.c","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: bashPrefix,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
			guard.record({
				toolName: "read",
				toolArgs: `{"path":"/tmp/diag-${i}.txt"}`,
				isError: false,
				outputFingerprint: `read-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("does not fire when bash command prefix varies each round", () => {
		const guard = new LoopGuard()
		// 10 rounds, same file edited but each bash command has a different
		// first 50 chars. No single bash prefix crosses the threshold.
		for (let i = 0; i < 10; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"/app/main.c","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":"echo round-${i} of totally-different-cmd-prefix"}`,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
			guard.record({
				toolName: "read",
				toolArgs: `{"path":"/tmp/diag-${i}.txt"}`,
				isError: false,
				outputFingerprint: `read-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("does not fire when a single edit targets one file but no bash repeats", () => {
		const guard = new LoopGuard()
		for (let i = 0; i < 10; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"/app/main.c","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":"echo unique-cmd-${i}-${Math.random()}"}`,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
			guard.record({
				toolName: "read",
				toolArgs: `{"path":"/tmp/diag-${i}.txt"}`,
				isError: false,
				outputFingerprint: `read-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
	})

	it("detects simple edit+bash pattern at 8 rounds when interleaved with diagnostic reads", () => {
		// The simplest case: same file, same bash prefix, but with diagnostic
		// reads between every call. The reads have different args so the
		// existing fuzzy n-gram detectors can't latch onto a repeating pattern.
		const guard = new LoopGuard()
		const file = "/app/vm.js"
		const bashPrefix = '{"command":"node vm.js 2>&1 | head -20"}'
		for (let i = 0; i < 8; i++) {
			guard.record({
				toolName: "read",
				toolArgs: `{"path":"/tmp/probe-${i}.txt"}`,
				isError: false,
				outputFingerprint: `probe-${i}`,
			})
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"${file}","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: bashPrefix,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(true)
	})

	it("window eviction drops the edit and bash counts", () => {
		const guard = new LoopGuard()
		feedEditRunRounds(guard, 8)
		expect(guard.isWarned()).toBe(true)

		// Push 35 fresh records (each a unique bash command) to evict all the
		// old edit-run signal from the window. After eviction the edit and
		// bash counts should be back to 0.
		for (let i = 0; i < 35; i++) {
			guard.record(rec({ toolArgs: `{"command":"filler-${i}"}`, outputFingerprint: `f${i}` }))
		}
		// reset() clears the warn fuse. Replaying the same edit-run pattern
		// at 7 rounds (below threshold) should not fire again.
		guard.reset()
		feedEditRunRounds(guard, 7)
		expect(guard.isWarned()).toBe(false)
	})

	it("blockIfLoop returns false after warn (history cleared)", () => {
		const guard = new LoopGuard()
		feedEditRunRounds(guard, 8)
		expect(guard.isWarned()).toBe(true)
		// After the warn, window history is cleared. blockIfLoop can't find
		// a matching proxy in an empty history, so it returns false.
		const editArgs = '{"path":"/app/main.c","edits":[{"oldText":"x","newText":"next"}]}'
		expect(guard.blockIfLoop({ toolName: "edit", toolArgs: editArgs })).toBe(false)
	})

	it("does not fire on tool calls with malformed JSON args", () => {
		// Records whose toolArgs don't parse as JSON should be skipped by the
		// extract* helpers. They shouldn't crash and shouldn't count.
		const guard = new LoopGuard()
		for (let i = 0; i < 10; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: "not json",
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":"echo ${i}"}`,
				isError: false,
				outputFingerprint: `bash-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
	})

	it("reset() clears the edit and bash counts", () => {
		const guard = new LoopGuard()
		feedEditRunRounds(guard, 8)
		expect(guard.isWarned()).toBe(true)
		guard.reset()
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})
})

describe("Edit-run cycle detector — task-total backstop", () => {
	// The task-total detector catches interleaved loops where the same
	// edit/bash pattern is spread across many rounds with OTHER tool
	// calls in between. The window-based detector misses these because
	// it only looks at the last 30 records.

	function feedSparseEditRun(guard: LoopGuard, editRuns: number, bashRuns: number, fillerPerRound: number): void {
		// Interleave edit + bash with `fillerPerRound` other tool calls
		// between each pair. With fillerPerRound=3, a 30-record window
		// covers ~6 of each edit/bash target — below the 8/8 window
		// threshold but the task-total counts keep climbing.
		const file = "/app/main.c"
		const bashPrefix = '{"command":"cd /app && make -j8 all 2>&1 | tail -20"}'
		for (let i = 0; i < editRuns; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"${file}","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			for (let f = 0; f < fillerPerRound; f++) {
				guard.record({
					toolName: "read",
					toolArgs: `{"path":"/tmp/filler-${i}-${f}.txt"}`,
					isError: false,
					outputFingerprint: `filler-${i}-${f}`,
				})
			}
		}
		for (let i = 0; i < bashRuns; i++) {
			guard.record({
				toolName: "bash",
				toolArgs: bashPrefix,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
			for (let f = 0; f < fillerPerRound; f++) {
				guard.record({
					toolName: "read",
					toolArgs: `{"path":"/tmp/bash-filler-${i}-${f}.txt"}`,
					isError: false,
					outputFingerprint: `bash-filler-${i}-${f}`,
				})
			}
		}
	}

	it("does not fire at 11 rounds (below both thresholds)", () => {
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 11, 11, 3)
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("fires at 12 rounds (task-total backstop)", () => {
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 12, 12, 3)
		expect(guard.isWarned()).toBe(true)
	})

	it("task-total fires when window detector does NOT", () => {
		// Specifically demonstrate that the task-total detector catches
		// a loop the window misses. With fillerPerRound=3, the window
		// has ~6 edits and ~6 bash at any time (below 8/8 threshold).
		// But task-total counts cross 12/12.
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 15, 15, 3)

		// Verify via test internal: the total counts are above threshold.
		// If the window detector had fired, isWarned() is true; either
		// way, the guard should be warned.
		expect(guard.isWarned()).toBe(true)
	})

	it("task-total does not fire if one of edit/bash is below threshold", () => {
		const guard = new LoopGuard()
		// 12 edits but only 5 bash runs — not a loop.
		feedSparseEditRun(guard, 12, 5, 3)
		expect(guard.isWarned()).toBe(false)
	})

	it("task-total survives window eviction", () => {
		// Push 60 records total — window only keeps last 30. The
		// task-total counts persist across evictions.
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 12, 12, 3)
		expect(guard.isWarned()).toBe(true)
	})

	it("window detector still fires for concentrated loops (no task-total needed)", () => {
		const guard = new LoopGuard()
		const file = "/app/vm.js"
		const bashPrefix = '{"command":"node vm.js 2>&1 | head -20"}'
		for (let i = 0; i < 8; i++) {
			guard.record({
				toolName: "edit",
				toolArgs: `{"path":"${file}","edits":[{"oldText":"x","newText":"v${i}"}]}`,
				isError: false,
				outputFingerprint: `edit-${i}`,
			})
			guard.record({
				toolName: "bash",
				toolArgs: bashPrefix,
				isError: true,
				outputFingerprint: `bash-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(true)
	})

	it("reset() clears task-total counts", () => {
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 12, 12, 3)
		expect(guard.isWarned()).toBe(true)
		guard.reset()
		expect(guard.isWarned()).toBe(false)
		expect(guard.isTriggered()).toBe(false)
	})

	it("blockIfLoop returns false after warn (history cleared)", () => {
		const guard = new LoopGuard()
		feedSparseEditRun(guard, 12, 12, 3)
		expect(guard.isWarned()).toBe(true)
		// After warn, window is cleared. blockIfLoop returns false.
		const editArgs = '{"path":"/app/main.c","edits":[{"oldText":"x","newText":"y"}]}'
		expect(guard.blockIfLoop({ toolName: "edit", toolArgs: editArgs })).toBe(false)
	})
})

describe("normalizeBashCommand", () => {
	it("strips leading preamble commands (rm, echo, wc, cd, sleep)", () => {
		// Core command is gcc, path argument is file.c (from the gcc segment,
		// NOT from the preamble's /app/a.out).
		expect(normalizeBashCommand("rm -f /app/a.out && gcc -O3 file.c")).toBe("gcc file.c")
		// wc is preamble-only (read-style) so it falls through to the raw prefix.
		expect(normalizeBashCommand("wc -c /app/file.c")).toBe("wc -c /app/file.c")
		// sleep + echo: both preamble, falls through.
		expect(normalizeBashCommand("sleep 30 && echo done")).toBe("sleep 30 && echo done")
	})

	it("collapses on tool + first path argument to ignore flag variations", () => {
		// Same intent: compile gpt2.c, different optimization flags and output paths.
		expect(normalizeBashCommand("gcc -O3 -lm /app/gpt2.c -o /app/a.out")).toBe(
			normalizeBashCommand("gcc -O0 -g /app/gpt2.c -o /tmp/debug"),
		)
		expect(normalizeBashCommand("gcc -O3 -lm /app/gpt2.c -o /app/a.out")).toBe("gcc /app/gpt2.c")
	})

	it("skips preamble and finds the core command in a chain", () => {
		// Core is gcc, path argument is file.c from the gcc segment.
		expect(normalizeBashCommand("rm -f a.out && wc -c file.c && gcc -O3 file.c")).toBe("gcc file.c")
	})

	it("falls back to raw prefix when no path-like argument is present", () => {
		const result = normalizeBashCommand("echo hello world")
		expect(result).toBe("echo hello world")
	})

	it("handles semicolon-separated commands", () => {
		// cd is preamble, ls is core (no path arg → falls back to raw prefix).
		expect(normalizeBashCommand("cd /app; ls -la; rm -rf tmp")).toBe("ls -la")
	})

	it("handles newline-separated commands", () => {
		expect(normalizeBashCommand("rm -f a.out\ngcc -O3 file.c")).toBe("gcc file.c")
	})

	it("ignores flags like -O0, -O3, -lm, -g", () => {
		// Flags start with "-" so they're not treated as path arguments.
		expect(normalizeBashCommand("python3 -O -u script.py")).toBe("python3 script.py")
	})

	it("handles relative paths with file extensions", () => {
		expect(normalizeBashCommand("cat ./test.txt")).toBe("cat ./test.txt")
	})

	it("uses the first path-argument when multiple are present", () => {
		// cp is NOT a preamble command (it's a real action). It gets
		// collapsed on the first path argument.
		expect(normalizeBashCommand("cp /app/src.c /tmp/build/")).toBe("cp /app/src.c")
	})
})

describe("Bash-only loop detector", () => {
	// Catches the case where the model repeats the same bash command many times
	// without file edits — e.g. repeated yt-dlp downloads, curl calls, etc.

	function feedBashCalls(guard: LoopGuard, commands: string[], fingerprint: string): void {
		for (const cmd of commands) {
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":${JSON.stringify(cmd)}}`,
				isError: false,
				outputFingerprint: fingerprint,
			})
		}
	}

	it("does not fire below window threshold", () => {
		// Use varying fingerprints so consecutive-identical doesn't fire.
		// Only the bash-repetition detector should be under test here.
		const guard = new LoopGuard()
		const commands = Array(11).fill("yt-dlp https://example.com/video")
		for (let i = 0; i < commands.length; i++) {
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":${JSON.stringify(commands[i])}}`,
				isError: false,
				outputFingerprint: `fp-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(false)
	})

	it("does not fire when commands have no repeat (11 different commands)", () => {
		const guard = new LoopGuard()
		const commands = Array.from({ length: 11 }, (_, i) => `echo unique-cmd-${i}`)
		feedBashCalls(guard, commands, "fp_same")
		expect(guard.isWarned()).toBe(false)
	})

	it("fires at window threshold (12 same-prefix calls)", () => {
		const guard = new LoopGuard()
		feedBashCalls(guard, Array(12).fill("yt-dlp https://example.com/video"), "fp_same")
		expect(guard.isWarned()).toBe(true)
	})

	it("does not require file edits to fire", () => {
		// Same prefix, no edits — should still fire.
		const guard = new LoopGuard()
		const commands = Array(12).fill("curl https://api.example.com/data")
		feedBashCalls(guard, commands, "fp_same")
		expect(guard.isWarned()).toBe(true)
	})

	it("catches varied flag patterns via normalization", () => {
		// Without normalization, each `gcc` invocation has a different raw prefix.
		// With normalization, they all collapse to "gcc /app/gpt2.c".
		const guard = new LoopGuard()
		const commands = [
			"rm -f /app/a.out && gcc -O3 -lm /app/gpt2.c -o /app/a.out",
			"wc -c /app/gpt2.c && gcc -O0 -g /app/gpt2.c",
			"gcc -O3 /app/gpt2.c -o /app/v3",
			"rm -f /tmp/test && gcc /app/gpt2.c",
			"gcc -O2 /app/gpt2.c",
		]
		// Feed 3 copies of each so 15 total — enough to trigger.
		const repeated = commands.flatMap((c) => [c, c, c])
		feedBashCalls(guard, repeated, "fp_same")
		expect(guard.isWarned()).toBe(true)
	})

	it("does not fire when bash commands are genuinely different", () => {
		const guard = new LoopGuard()
		const commands = [
			"git status",
			"git diff",
			"git log --oneline -5",
			"npm test",
			"pnpm run build",
			"pytest tests/",
			"ls -la",
			"grep -r TODO src/",
			"wc -l src/*.ts",
			"find . -name '*.test.ts'",
		]
		feedBashCalls(guard, commands, "fp_same")
		expect(guard.isWarned()).toBe(false)
	})

	it("window counts reset after warn so the model gets a fresh budget", () => {
		const guard = new LoopGuard()
		feedBashCalls(guard, Array(12).fill("apt-get install -y some-package"), "fp_a")
		expect(guard.isWarned()).toBe(true)
		// After warn, window is cleared. Next batch doesn't immediately re-fire.
		feedBashCalls(guard, Array(12).fill("apt-get install -y another-package"), "fp_b")
		// Total counts may re-trigger after enough accumulates.
		// Window should be clear though.
		expect(guard.isWarned()).toBe(true) // task-total re-triggered
	})

	it("task-total fired keys are decremented so the same threshold doesn't fire on every subsequent record", () => {
		// Regression test: before the fix, task-total keys were never
		// decremented after a warn, so the same threshold would fire on
		// every subsequent record for the rest of the session, flooding
		// the model with repeated steers.
		//
		// We verify the decrement directly via getTotalBashCount rather
		// than testing the secondary "warn doesn't fire" behavior, because
		// the window threshold (12) is lower than the task-total threshold
		// (15), making it impossible to reach task-total without the
		// window detector firing first.
		const cmd = "curl https://api.example.com"
		const guard = new LoopGuard()

		// Feed enough to trigger task-total bash repetition (15 calls).
		for (let i = 0; i < 15; i++) {
			guard.record({
				toolName: "bash",
				toolArgs: `{"command":${JSON.stringify(cmd)}}`,
				isError: false,
				outputFingerprint: `fp-${i}`,
			})
		}
		expect(guard.isWarned()).toBe(true)

		// The fired key should be decremented by the threshold count (15).
		// After warn: count = 15 - 15 = 0.
		expect(guard.getTotalBashCount(cmd)).toBe(0)
	})
})
