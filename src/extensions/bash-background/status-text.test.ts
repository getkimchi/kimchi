/**
 * Focused formatter tests for the model-visible status and result text of
 * the background-bash cohort: checkpoint evidence, headers, no-output
 * wording, clamped remaining budget, and omission/truncation formatting.
 */
import { describe, expect, it } from "vitest"
import type { IncrementalSnapshot } from "./process-registry.js"
import {
	checkpointGuidanceText,
	formatBytes,
	handoffGuidanceText,
	inspectionHeaderText,
	processEvidenceText,
	terminalResultText,
	unseenOutputText,
	waitCheckpointHeaderText,
} from "./status-text.js"

function incremental(overrides: Partial<IncrementalSnapshot> = {}): IncrementalSnapshot {
	return {
		text: "",
		nextCursor: 0,
		newBytes: 0,
		omittedBytes: 0,
		totalBytes: 0,
		state: "running",
		exitCode: null,
		reason: null,
		...overrides,
	}
}

describe("processEvidenceText", () => {
	it("formats identity, runtime, output age, streak, and remaining budget", () => {
		const text = processEvidenceText({
			handle: "build-1",
			commandSummary: "pnpm run build",
			runtimeSeconds: 600,
			lastOutputAgeSeconds: 540,
			consecutiveCheckpoints: 2,
			safetyRemainingSeconds: 3000,
			cwd: "/repo",
		})
		expect(text).toContain("build-1: pnpm run build")
		expect(text).toContain("Running: 600s")
		expect(text).toContain("Last output: 540s ago")
		expect(text).toContain("Consecutive wait checkpoints: 2")
		expect(text).toContain("Safety budget remaining: 3000s")
	})

	it("reports 'no output yet' for a silent process", () => {
		const text = processEvidenceText({
			handle: "silent-1",
			commandSummary: "sleep 100",
			runtimeSeconds: 30,
			lastOutputAgeSeconds: undefined,
			consecutiveCheckpoints: 0,
			safetyRemainingSeconds: 3570,
			cwd: "/repo",
		})
		expect(text).toContain("Last output: no output yet")
	})

	it("renders the cwd only when it differs from the session cwd", () => {
		const base = {
			handle: "h",
			commandSummary: "c",
			runtimeSeconds: 1,
			lastOutputAgeSeconds: undefined,
			consecutiveCheckpoints: 0,
			safetyRemainingSeconds: 1,
		} as const
		expect(processEvidenceText({ ...base, sessionCwd: "/repo", cwd: "/repo" })).not.toContain("cwd:")
		expect(processEvidenceText({ ...base, sessionCwd: "/repo", cwd: "/repo/sub" })).toContain("cwd: sub")
		expect(processEvidenceText({ ...base, sessionCwd: "/repo", cwd: "/elsewhere" })).toContain("cwd: /elsewhere")
	})
})

describe("waitCheckpointHeaderText / inspectionHeaderText", () => {
	it("reports requested and actually waited time separately", () => {
		expect(waitCheckpointHeaderText(300, 17)).toBe("Wait checkpoint: requested 300s, waited 17s.")
	})

	it("inspection header counts processes with plural handling", () => {
		expect(inspectionHeaderText(1)).toBe("Inspection of 1 background bash process:")
		expect(inspectionHeaderText(3)).toBe("Inspection of 3 background bash processes:")
	})
})

describe("checkpointGuidanceText", () => {
	it("asks for reassessment without claiming silence proves a stall", () => {
		const text = checkpointGuidanceText()
		expect(text).toContain("Reassess the runtime against the expected duration")
		expect(text).toContain("Silence alone does not establish that a command is stalled")
	})
})

describe("unseenOutputText", () => {
	it("reports no new output factually (never 'no progress')", () => {
		const text = unseenOutputText(incremental())
		expect(text).toContain("No new output since the previous delivery.")
		expect(text).not.toContain("no progress")
	})

	it("notes omitted unseen bytes so a gap is never silent loss", () => {
		const text = unseenOutputText(incremental({ omittedBytes: 4096, newBytes: 4096, text: "tail" }))
		expect(text).toContain("4 KB of older unseen output omitted")
		expect(text).toContain("New output since the previous delivery:")
		expect(text).toContain("tail")
	})

	it("explains evicted output that cannot be shown", () => {
		const text = unseenOutputText(incremental({ newBytes: 100, text: "" }))
		expect(text).toContain("New output was produced but evicted")
	})
})

describe("terminalResultText", () => {
	it("includes the handle identity, reason, and runtime for tracked processes", () => {
		const text = terminalResultText({
			handle: "build-1",
			commandSummary: "pnpm run build",
			elapsedSeconds: 42,
			state: "exited",
			exitCode: 0,
			reason: null,
			deadlineSeconds: 3600,
			output: "done",
		})
		expect(text).toContain(" handle: build-1")
		expect(text).toContain("exited (exit code 0)")
		expect(text).toContain("ran for 42s")
		expect(text).toContain("Final output:")
	})

	it("uses the headerless form for pre-handoff exits", () => {
		const text = terminalResultText({
			elapsedSeconds: 1,
			state: "exited",
			exitCode: 3,
			reason: null,
			deadlineSeconds: 3600,
			output: "",
		})
		expect(text).toContain("[Process exited (exit code 3); ran for 1s.]")
		expect(text).toContain("The process produced no further output.")
	})

	it("points at the full-output file when truncated", () => {
		const text = terminalResultText({
			elapsedSeconds: 5,
			state: "exited",
			exitCode: 0,
			reason: null,
			deadlineSeconds: 3600,
			output: "partial",
			truncated: true,
			fullOutputPath: "/tmp/spill.log",
		})
		expect(text).toContain("[Output truncated. Full output: /tmp/spill.log]")
	})
})

describe("handoffGuidanceText", () => {
	it("states the continuation contract without scheduled-review claims", () => {
		const text = handoffGuidanceText()
		expect(text).toContain("continues by default")
		expect(text).toContain("exit result will be delivered automatically")
		expect(text).toContain("wait: true")
		expect(text).toContain("five minutes by default, ten at most")
		expect(text).not.toContain("review")
	})
})

describe("formatBytes", () => {
	it("uses human-readable units", () => {
		expect(formatBytes(512)).toBe("512 B")
		expect(formatBytes(4096)).toBe("4 KB")
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
	})
})
