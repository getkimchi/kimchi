/**
 * Tests for the tool-error classification module.
 *
 * The fixture set (tool-error-classification.fixtures.json) is curated from
 * the real PostHog error-series export (27-Oct→3-Nov-2026): every fixture is
 * a literal production message, paired with the classification it must
 * produce. When a producer's wording changes, the fixture goes stale and
 * this suite fails — update the fixture together with the pattern.
 *
 * Producer-contract coverage: where a gate message is produced by an
 * exported pure function (ferment FSM), the test calls the real producer
 * instead of a copied literal, so wording changes are caught without a
 * second hand-written string. Producers whose message builders are not
 * exported (todo check-in gate, permissions plan-mode gate) are covered by
 * fixtures only — a documented residual drift risk.
 */

import { describe, expect, it } from "vitest"
import { type FermentFsmContext, FSM_STATES, transition } from "../../../ferment/fsm.js"
import fixtures from "./tool-error-classification.fixtures.json" with { type: "json" }
import { classifyToolError } from "./tool-error-classification.js"

interface Fixture {
	tool: string
	message: string
	expect: { kind: string; message: string }
}

/** Narrow a classification to its command_outcome branch — the discriminated
 *  union carries commandOutcome only there. */
function asCommandOutcome(c: ReturnType<typeof classifyToolError>) {
	if (c.kind !== "command_outcome") throw new Error(`expected command_outcome, got ${c.kind}`)
	return c
}

const typedFixtures = fixtures as Fixture[]

describe("classifyToolError — fixture replay (real export messages)", () => {
	for (const f of typedFixtures) {
		it(`classifies ${f.expect.kind}: ${JSON.stringify(f.message.slice(0, 70))}`, () => {
			const c = classifyToolError(f.tool, f.message)
			expect(c.kind).toBe(f.expect.kind)
			expect(c.message).toBe(f.expect.message)
		})
	}

	it("every curated fixture maps to a known family (no raw fallback)", () => {
		for (const f of typedFixtures) {
			const c = classifyToolError(f.tool, f.message)
			// A recognized failure (mode flap) carries a canonical message; the
			// catch-all fallback would echo the raw text.
			const fellBack = c.kind === "failure" && c.message === f.message.slice(0, 300)
			expect(fellBack).toBe(false)
		}
	})

	it("collapses the curated set to a bounded set of canonical messages", () => {
		const distinct = new Set(typedFixtures.map((f) => f.expect.message))
		// ~40 canonical families cover the curated export; growth beyond this
		// means a new pattern is emitting per-instance messages.
		expect(distinct.size).toBeLessThanOrEqual(40)
	})

	it("leaks no absolute path, ISO timestamp, or rate-limit window into canonical messages", () => {
		for (const f of typedFixtures) {
			const c = classifyToolError(f.tool, f.message)
			expect(c.message).not.toMatch(/(^|[^\w])\/(?:Users|home|tmp|Volumes)\//)
			expect(c.message).not.toMatch(/[CD]:[\\/]/)
			expect(c.message).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
			expect(c.message).not.toMatch(/until \d{4}-/)
		}
	})

	it("drops the classifier rate-limit timestamp and free-text reasons from attributes", () => {
		const c = classifyToolError(
			"write",
			"Classifier: classifier error: minimax-m3 model is rate limited until 2026-10-29T23:55:00Z (model=minimax-m3 tool=write) (no UI to confirm)",
		)
		expect(c.kind).toBe("blocked")
		expect(c.attrs?.failure_code).toBe("rate_limited")
		expect(c.attrs?.classifier_model).toBe("minimax-m3")
		expect(c.attrs?.classifier_tool).toBe("write")
		for (const v of Object.values(c.attrs ?? {})) {
			expect(String(v)).not.toContain("2026-10-29")
		}
	})

	it("maps classifier timeout and budget exhaustion to bounded failure codes", () => {
		const timeout = classifyToolError(
			"bash",
			"Classifier: classifier timeout (model=minimax-m3 tool=bash) (no UI to confirm)",
		)
		expect(timeout.kind).toBe("blocked")
		expect(timeout.attrs?.failure_code).toBe("timeout")

		const budget = classifyToolError("bash", "Classifier: classifier budget exhausted (no UI to confirm)")
		expect(budget.kind).toBe("blocked")
		expect(budget.attrs?.failure_code).toBe("budget_exhausted")

		const other = classifyToolError(
			"write",
			"Classifier: classifier error: request failed (model=minimax-m3) (no UI to confirm)",
		)
		expect(other.attrs?.failure_code).toBe("other")
		expect(other.attrs?.classifier_tool).toBeUndefined()
	})

	it("caps classifier model/tool diagnostic attribute lengths", () => {
		const longModel = "m".repeat(200)
		const c = classifyToolError(
			"bash",
			`Classifier: classifier timeout (model=${longModel} tool=bash) (no UI to confirm)`,
		)
		expect(String(c.attrs?.classifier_model).length).toBeLessThanOrEqual(64)
	})
})

describe("classifyToolError — bash terminal status precedence", () => {
	it("resolves a real exit status over gate-like text printed by the command", () => {
		const c = classifyToolError(
			"bash",
			"Blocked: the session is in plan mode (read-only). Do not retry writes.\n\nCommand exited with code 2",
		)
		expect(c.kind).toBe("command_outcome")
		const outcome = asCommandOutcome(c)
		expect(outcome.commandOutcome).toBe("nonzero_exit")
		expect(c.exitCode).toBe(2)
	})

	it("resolves timeout after verbose output (status line beyond 300 chars)", () => {
		const c = classifyToolError("bash", `${"x".repeat(400)}\n\nCommand timed out after 5 seconds`)
		expect(c.kind).toBe("command_outcome")
		const outcome = asCommandOutcome(c)
		expect(outcome.commandOutcome).toBe("timeout")
		expect(c.attrs?.timeout_seconds).toBe(5)
		expect(c.exitCode).toBeUndefined()
	})

	it("supports fractional timeouts (upstream reports the raw value)", () => {
		const c = classifyToolError("bash", "Command timed out after 0.5 seconds")
		expect(c.kind).toBe("command_outcome")
		const outcome = asCommandOutcome(c)
		expect(outcome.commandOutcome).toBe("timeout")
		expect(c.attrs?.timeout_seconds).toBe(0.5)
		expect(c.exitCode).toBeUndefined()
	})

	it("resolves abort after verbose output", () => {
		const c = classifyToolError("bash", "partial output\n\nCommand aborted")
		expect(c.kind).toBe("aborted")
	})

	it("resolves termination without an exit code after output", () => {
		const c = classifyToolError("bash", "partial output\n\nCommand terminated without an exit code")
		expect(c.kind).toBe("command_outcome")
		const outcome = asCommandOutcome(c)
		expect(outcome.commandOutcome).toBe("terminated")
		expect(c.exitCode).toBeUndefined()
	})

	it("ignores nonterminal status-like text inside command output", () => {
		// A status line printed in the middle, with more output after it, is
		// command output — not the terminal status.
		const c = classifyToolError("bash", "Command exited with code 1\nmore output after that")
		expect(c.kind).toBe("failure")
		expect(c.message).toBe("Command exited with code 1\nmore output after that")
	})

	it("recognizes exit status variants 22 and 128 with real codes", () => {
		expect(classifyToolError("bash", "Command exited with code 22").exitCode).toBe(22)
		expect(classifyToolError("bash", "Command exited with code 128").exitCode).toBe(128)
	})

	it("treats bare Operation aborted as an exact match only", () => {
		expect(classifyToolError("read", "Operation aborted").kind).toBe("aborted")
		expect(classifyToolError("read", "Operation aborted by the user mid-flight").kind).toBe("failure")
	})
})

describe("classifyToolError — tool scoping (negative cases)", () => {
	it("does not apply edit patterns to the read tool", () => {
		const c = classifyToolError("read", "Could not find the exact text in /src/app.ts. The old text must match")
		expect(c.kind).toBe("failure")
	})

	it("does not apply path-probe patterns to the read tool", () => {
		const c = classifyToolError("read", "Path not found: /src/missing")
		expect(c.kind).toBe("failure")
	})

	it("does not apply read patterns to the find tool", () => {
		const c = classifyToolError("find", "ENOENT: no such file or directory, access '/src/missing'")
		expect(c.kind).toBe("failure")
	})

	it("does not apply the ask_user cancellation pattern to other tools", () => {
		const c = classifyToolError("bash", "ask_user could not route the question (user_cancelled): User cancelled")
		expect(c.kind).toBe("failure")
	})

	it("does not apply ferment guard patterns to non-ferment tools", () => {
		const c = classifyToolError("bash", 'Event "complete_step" is not valid in state "PHASE_ACTIVE".')
		expect(c.kind).toBe("failure")
	})

	it("applies cross-tool harness gates on any tool", () => {
		const c = classifyToolError("write", "Declined by user")
		expect(c.kind).toBe("declined")
	})
})

describe("classifyToolError — fallback", () => {
	it("keeps today's behavior for unknown messages (first 300 chars)", () => {
		const long = "y".repeat(500)
		const c = classifyToolError("bash", long)
		expect(c.kind).toBe("failure")
		expect(c.message).toBe("y".repeat(300))
	})

	it("returns an empty failure message for empty input (caller supplies the fallback)", () => {
		const c = classifyToolError("read", "")
		expect(c.kind).toBe("failure")
		expect(c.message).toBe("")
	})

	it("never throws on nullish input", () => {
		expect(() => classifyToolError("read", undefined as unknown as string)).not.toThrow()
	})
})

describe("classifyToolError — attribute shape", () => {
	it("hashes file paths for edit/read/path families instead of exporting them", () => {
		const c = classifyToolError(
			"edit",
			"Could not find the exact text in /Users/x/secret.ts. The old text must match exactly including all whitespace and newlines.",
		)
		expect(c.kind).toBe("model_mistake")
		expect(c.message).toBe("Edit oldText not found")
		expect(c.attrs?.file_hash).toMatch(/^[0-9a-f]{12}$/)
		expect(JSON.stringify(c)).not.toContain("/Users/x/secret.ts")
	})

	it("carries edit_index, occurrences, offset, and revision as numbers", () => {
		const edit = classifyToolError(
			"multiedit",
			"Could not find edits[2] in /src/a.ts. The oldText must match exactly including all whitespace and newlines.",
		)
		expect(edit.attrs?.edit_index).toBe(2)
		const occ = classifyToolError("edit", "Found 3 occurrences of the text in /src/a.ts. The text must be unique.")
		expect(occ.attrs?.occurrences).toBe(3)
		const offset = classifyToolError("read", "Offset 1400 is beyond end of file (1342 lines total)")
		expect(offset.attrs?.offset).toBe(1400)
		const todo = classifyToolError("bash", "⏸ Todo check-in pending (input revision 7). Reconcile the todo list.")
		expect(todo.attrs?.revision).toBe(7)
	})

	it("caps the engine-validation tool attribute and keeps model-mistake messages canonical", () => {
		const longName = "t".repeat(200)
		const c = classifyToolError("bash", `Tool ${longName} not found`)
		expect(c.kind).toBe("model_mistake")
		expect(c.message).toBe("Tool not found")
		expect(String(c.attrs?.tool).length).toBeLessThanOrEqual(64)
	})
})

describe("classifyToolError — producer contract (ferment FSM)", () => {
	it("classifies the real FSM invalid-event message as a ferment state guard", () => {
		const ctx: FermentFsmContext = { fermentStatus: "planned", phases: [] }
		const result = transition(FSM_STATES.PLANNED, "start_step", ctx)
		expect(result.error).toBeDefined()
		const c = classifyToolError("start_ferment_step", result.error ?? "")
		expect(c.kind).toBe("blocked")
		expect(c.message).toBe("Ferment state guard")
	})
})
