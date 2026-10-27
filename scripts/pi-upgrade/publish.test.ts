import { describe, expect, it } from "vitest"
import type { IssueSnapshot } from "./github.ts"
import { type PublishInput, planPublish } from "./publish.ts"
import type { SettleResult } from "./settle.ts"
import type { State } from "./state.ts"

const NOW = new Date("2026-10-27T06:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

const settle = (target: string | null, versionsBehind = 1): SettleResult => ({
	baseline: "1.3.0",
	target,
	chain: target ? [target] : [],
	behind: { versions: versionsBehind, days: 12, lines: 1, latest: target ?? "1.3.0" },
	forced: false,
})

const lastRun = (target: string, at = daysAgo(1)) => ({ baseline: "1.3.0", target, inputsHash: "h1", at })
const open: IssueSnapshot = { number: 7, state: "open", title: "Pi upgrade ready: 1.3.0 → 1.4.0", stateCommentId: 99 }
const closed: IssueSnapshot = { ...open, state: "closed" }

const base: PublishInput = {
	issue: null,
	state: { v: 1, digests: {} },
	settle: settle("1.4.0"),
	report: "REPORT",
	inputsHash: "h1",
	now: NOW,
	forced: false,
	complete: true,
	whatsNew: ["setModel no longer persists"],
}

describe("planPublish", () => {
	const cases: Array<{ name: string; input: Partial<PublishInput>; kind: string; comment?: RegExp | null }> = [
		{ name: "creates an issue when none exists", input: {}, kind: "create", comment: null },
		{
			name: "does nothing when target, inputs and report age are unchanged",
			input: { issue: open, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0") } },
			kind: "noop",
		},
		{
			name: "refreshes the body weekly without a comment",
			input: { issue: open, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0", daysAgo(8)) } },
			kind: "update",
			comment: null,
		},
		{
			name: "refreshes when patches or hooked files changed",
			input: { issue: open, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0") }, inputsHash: "h2" },
			kind: "update",
			comment: null,
		},
		{
			name: "comments when the target moved",
			input: { issue: open, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0") }, settle: settle("1.5.0", 2) },
			kind: "update",
			comment: /^Target moved 1\.4\.0 → 1\.5\.0 — new since last report:\n- setModel no longer persists/,
		},
		{
			name: "stays quiet on an issue a person closed while the target is the same",
			input: { issue: closed, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0") } },
			kind: "noop",
		},
		{
			name: "reopens a person-closed issue once a newer target settles",
			input: { issue: closed, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0") }, settle: settle("1.5.0", 2) },
			kind: "reopen",
			comment: /^Target moved 1\.4\.0 → 1\.5\.0/,
		},
		{
			name: "opens a new issue after the job closed the last one as up to date",
			input: { issue: closed, state: { v: 1, digests: {}, lastRun: lastRun("1.4.0"), closedByJob: true } },
			kind: "create",
		},
		{
			name: "closes the open issue once the pin is the latest version",
			input: { issue: open, settle: settle(null, 0) },
			kind: "close",
			comment: /^Up to date at 1\.3\.0\.$/,
		},
		{
			name: "does nothing while the newest version is still settling",
			input: { issue: open, settle: settle(null) },
			kind: "noop",
		},
		{ name: "never touches the issue on a forced run", input: { issue: open, forced: true }, kind: "noop" },
	]

	for (const c of cases) {
		it(c.name, () => {
			const action = planPublish({ ...base, ...c.input })
			expect(action.kind).toBe(c.kind)
			if (c.comment !== undefined && action.kind !== "noop") {
				if (c.comment === null) expect(action.comment).toBeUndefined()
				else expect(action.comment).toMatch(c.comment)
			}
		})
	}

	it("titles the issue with baseline and target and records the run", () => {
		const action = planPublish(base)
		if (action.kind !== "create") throw new Error(action.kind)
		expect(action.title).toBe("Pi upgrade ready: 1.3.0 → 1.4.0")
		expect(action.body).toBe("REPORT")
		expect(action.state.lastRun).toEqual({
			baseline: "1.3.0",
			target: "1.4.0",
			inputsHash: "h1",
			at: NOW.toISOString(),
		})
		expect(action.state.closedByJob).toBeUndefined()
	})

	it("marks a job close so the next target opens a fresh issue", () => {
		const action = planPublish({ ...base, issue: open, settle: settle(null, 0) })
		if (action.kind !== "close") throw new Error(action.kind)
		expect(action.state.closedByJob).toBe(true)
	})
})

describe("planPublish incomplete runs", () => {
	it("publishes the partial report but keeps the previous lastRun so tomorrow retries", () => {
		const state: State = { v: 1, digests: {}, lastRun: lastRun("1.4.0", daysAgo(8)) }
		const action = planPublish({ ...base, issue: open, state, complete: false })
		if (action.kind !== "update") throw new Error(action.kind)
		expect(action.body).toBe("REPORT")
		expect(action.state.lastRun).toEqual(state.lastRun)
	})
})
