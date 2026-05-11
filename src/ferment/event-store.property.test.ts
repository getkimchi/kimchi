/**
 * Property-style fold-equivalence test.
 *
 * Generates random valid command sequences (respecting state-machine guards),
 * applies them via the production mutation path (commandToEvents +
 * writeWithEvents), and after each command asserts that the snapshot path
 * (FermentStorage.get) and the fold path (FermentEventStore.get with events
 * newer than the snapshot) produce identical state hashes.
 *
 * This is the contract the four state-bearing layers — state machine,
 * command-mapper, event fold, snapshot store — must collectively satisfy.
 * It is the Tier-0 #4 item from docs/ferment-review.md and would have caught
 * the parallel-group fold bug (§4.2) and the verified-step hash chain
 * mismatch (§4.3) the day they were written.
 */

import { mkdtempSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commandToEvents } from "./event-mapper.js"
import { FermentEventStore, stateHash } from "./event-store.js"
import { type Command, applyCommand } from "./state-machine.js"
import { FermentStorage, clearFermentCache } from "./store.js"
import type { Ferment } from "./types.js"

function tempDir() {
	return mkdtempSync(join(tmpdir(), "ferment-property-"))
}

interface Rng {
	int(maxExclusive: number): number
	pick<T>(arr: readonly T[]): T
	bool(p?: number): boolean
}

function makeRng(seed: number): Rng {
	// xorshift32 — deterministic for reproducibility from a seed.
	let s = seed | 0
	if (s === 0) s = 0x12345678
	const next = () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return (s >>> 0) / 0x1_0000_0000
	}
	return {
		int(max: number) {
			return Math.floor(next() * max)
		},
		pick<T>(arr: readonly T[]): T {
			return arr[Math.floor(next() * arr.length)]
		},
		bool(p = 0.5) {
			return next() < p
		},
	}
}

/**
 * Compute the set of commands that are legal against the current ferment.
 * We don't try to be exhaustive — just enough variety that the sequence
 * exercises every event type the mapper emits.
 */
function legalCommands(f: Ferment, rng: Rng): Command[] {
	const out: Command[] = []

	if (f.status === "draft") {
		// Only scope is legal in draft.
		const usesGroup = rng.bool(0.4)
		out.push({
			type: "scope",
			goal: "Auto goal",
			successCriteria: "Auto criteria",
			constraints: ["c1"],
			phases: usesGroup
				? [
						{ name: "G1A", goal: "g1a", parallel_group: 1, steps: [{ description: "s1" }] },
						{ name: "G1B", goal: "g1b", parallel_group: 1, steps: [{ description: "s2" }] },
						{ name: "P3", goal: "g3", steps: [{ description: "s3" }] },
					]
				: [{ name: "P1", goal: "g1", steps: [{ description: "s1" }] }],
		})
		return out
	}

	if (f.status === "paused") {
		// Strongly prefer resume — abandon is a one-way trip and short-circuits
		// the property test before it can exercise much state.
		out.push({ type: "resume" })
		out.push({ type: "resume" })
		out.push({ type: "resume" })
		if (rng.bool(0.1)) out.push({ type: "abandon" })
		return out
	}

	if (f.status === "complete" || f.status === "abandoned") {
		return out // terminal
	}

	// Status is planned or running.
	const active = f.phases.find((p) => p.status === "active")
	const hasRunning = f.phases.some((p) => p.steps.some((s) => s.status === "running"))

	// Activate a planned phase.
	const planned = f.phases.find((p) => p.status === "planned")
	if (planned) {
		if (planned.groupIndex !== undefined) {
			out.push({ type: "activate_phase_group", groupIndex: planned.groupIndex })
		} else {
			out.push({ type: "activate_phase", phaseId: planned.id })
		}
	}

	if (active) {
		// Refine — only when no step is currently running (audit #4 guard).
		if (!hasRunning && active.steps.length === 0) {
			out.push({
				type: "refine_phase",
				phaseId: active.id,
				steps: [{ description: "step a" }, { description: "step b" }],
			})
		}

		// Step lifecycle.
		const pending = active.steps.find((s) => s.status === "pending")
		if (pending && !hasRunning) {
			out.push({ type: "start_step", phaseId: active.id, stepId: pending.id })
		}
		const running = active.steps.find((s) => s.status === "running")
		if (running) {
			out.push({ type: "complete_step", phaseId: active.id, stepId: running.id })
			out.push({ type: "skip_step", phaseId: active.id, stepId: running.id })
			out.push({ type: "fail_step", phaseId: active.id, stepId: running.id, error: "boom" })
		}

		// Complete phase only if all steps are terminal AND non-empty.
		const allTerminal =
			active.steps.length > 0 &&
			active.steps.every(
				(s) => s.status === "done" || s.status === "verified" || s.status === "skipped" || s.status === "failed",
			)
		if (allTerminal) {
			out.push({ type: "complete_phase", phaseId: active.id, summary: "ok" })
			out.push({ type: "skip_phase", phaseId: active.id, reason: "skipping" })
		}
	}

	// Always-legal additive operations.
	out.push({ type: "add_decision", title: "T", description: "D" })
	out.push({ type: "add_memory", category: "gotcha", content: "watch out" })
	// Pause is rare so the sequence keeps moving forward.
	if (rng.bool(0.1)) out.push({ type: "pause" })

	if (out.length === 0) {
		// Defensive fallback — shouldn't happen given the branches above.
		out.push({ type: "abandon" })
	}
	return out
}

interface RunStats {
	commandsApplied: number
	rejections: number
}

function runRandomSequence(seed: number, length: number): RunStats {
	const dir = tempDir()
	clearFermentCache()
	const eventStore = new FermentEventStore(dir)
	const parent = new FermentStorage(dir)
	const rng = makeRng(seed)
	const stats: RunStats = { commandsApplied: 0, rejections: 0 }

	const ferment = eventStore.create("Property", "auto-generated")

	// Bump events.jsonl mtime so eventStore.get() prefers the fold path on every
	// read — `shouldUseEvents` returns true iff eventsMtime >= snapMtime.
	const bumpEventsMtime = () => {
		const eventsPath = join(dir, `${ferment.id}.events.jsonl`)
		const future = new Date(Date.now() + 60_000)
		try {
			utimesSync(eventsPath, future, future)
		} catch {
			// File might not exist yet — fine.
		}
	}

	for (let i = 0; i < length; i++) {
		clearFermentCache()
		const current = parent.get(ferment.id)
		if (!current) break
		const legal = legalCommands(current, rng)
		if (legal.length === 0) break
		const cmd = rng.pick(legal)
		const now = new Date(Date.now() + i).toISOString() // monotonic
		const result = applyCommand(current, cmd, { now })
		if (!result.ok) {
			// Rejected by guards — we generated an illegal command. Skip and try next.
			stats.rejections++
			continue
		}
		const events = commandToEvents(cmd, current, result.ferment, { now })
		eventStore.writeWithEvents(result.ferment, events)
		stats.commandsApplied++

		// Force fold path on read.
		bumpEventsMtime()
		clearFermentCache()
		const snap = parent.get(ferment.id)
		const folded = eventStore.get(ferment.id)

		// Hash equivalence is the contract. If this fails, the four layers have
		// drifted apart and we have a fold/mapper/state-machine bug. Set
		// PROPERTY_DEBUG=1 to dump the diverging snap+fold pair to /tmp.
		if (stateHash(folded) !== stateHash(snap) && process.env.PROPERTY_DEBUG) {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("node:fs") as typeof import("node:fs")
			fs.writeFileSync(`/tmp/divergence-${seed}-${i}.json`, JSON.stringify({ snap, folded, cmd }, null, 2))
		}
		expect(stateHash(folded), `seed=${seed} step=${i} cmd=${cmd.type}`).toBe(stateHash(snap))
	}

	return stats
}

describe("FermentEventStore — property-style fold equivalence", () => {
	// Deterministic seeds; if a future bug reproduces, the seed is in the test name.
	const seeds = [1, 7, 42, 137, 31337]

	for (const seed of seeds) {
		it(`seed ${seed}: fold matches snapshot after every command in a 40-step random sequence`, () => {
			const stats = runRandomSequence(seed, 40)
			// Sanity: the sequence should actually have done something. If the
			// generator stalls (always picks rejected commands or terminal-state
			// no-ops), the test isn't exercising the contract — fail loudly.
			expect(stats.commandsApplied).toBeGreaterThan(5)
		})
	}
})
