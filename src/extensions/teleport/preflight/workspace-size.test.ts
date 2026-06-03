import { describe, expect, it } from "vitest"
import {
	SIZE_REFUSE_BYTES,
	SIZE_WARN_BYTES,
	type WorkspaceSizeOptions,
	estimateWorkspaceBytes,
} from "./workspace-size.js"

type MockExec = NonNullable<WorkspaceSizeOptions["execFile"]>

function mockExec(fn: () => string): MockExec {
	return (() => fn()) as unknown as MockExec
}

describe("estimateWorkspaceBytes", () => {
	it("parses du -sk output into bytes", () => {
		const exec = mockExec(() => "12345\t/some/path\n")
		expect(estimateWorkspaceBytes("/some/path", { execFile: exec })).toBe(12345 * 1024)
	})

	it("handles space-separated du output", () => {
		const exec = mockExec(() => "987 /another/path")
		expect(estimateWorkspaceBytes("/another/path", { execFile: exec })).toBe(987 * 1024)
	})

	it("returns 0 when du fails", () => {
		const exec = mockExec(() => {
			throw new Error("du not found")
		})
		expect(estimateWorkspaceBytes("/x", { execFile: exec })).toBe(0)
	})

	it("returns 0 when du output is unparseable", () => {
		const exec = mockExec(() => "garbage")
		expect(estimateWorkspaceBytes("/x", { execFile: exec })).toBe(0)
	})

	it("returns 0 for empty output", () => {
		const exec = mockExec(() => "")
		expect(estimateWorkspaceBytes("/x", { execFile: exec })).toBe(0)
	})
})

describe("size thresholds", () => {
	it("exports the task-07 constants", () => {
		expect(SIZE_WARN_BYTES).toBe(500_000_000)
		expect(SIZE_REFUSE_BYTES).toBe(5_000_000_000)
	})
})
