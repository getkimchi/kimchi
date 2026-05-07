import { beforeEach, describe, expect, it, vi } from "vitest"

// Create mock functions outside vi.mock so they can be referenced in the factory
const mockReaddir = vi.hoisted(() => vi.fn())
const mockReadFile = vi.hoisted(() => vi.fn())

vi.mock("fs/promises", () => ({
	readdir: mockReaddir,
	readFile: mockReadFile,
}))

vi.mock("path", () => ({
	join: vi.fn((...args: string[]) => args.join("/")),
}))

import { summarizeLogs } from "./log-summarizer.js"

interface MockDirent {
	name: string
	isFile: () => boolean
	isDirectory: () => boolean
}

describe("summarizeLogs", () => {
	beforeEach(() => {
		mockReaddir.mockClear()
		mockReadFile.mockClear()
		mockReadFile.mockReset()
	})

	it("reads summaries from the summaries directory", async () => {
		const mockEntries: MockDirent[] = [
			{ name: "summary-1.md", isFile: () => true, isDirectory: () => false },
			{ name: "summary-2.md", isFile: () => true, isDirectory: () => false },
		]
		mockReaddir.mockResolvedValueOnce(mockEntries)

		// Return different content based on path
		mockReadFile.mockImplementation(async (path: string) => {
			if (path.includes("failure-log")) return ""
			if (path.includes("summary-1.md")) return "# Session 1\nSome summary content"
			if (path.includes("summary-2.md")) return "# Session 2\nMore summary content"
			return ""
		})

		const result = await summarizeLogs("/memory")

		expect(mockReaddir).toHaveBeenCalledWith("/memory/summaries", { withFileTypes: true })
		expect(result.summaries).toHaveLength(2)
		// Files are sorted alphabetically, then reversed, so summary-2.md comes first
		expect(result.summaries[0]).toBe("# Session 2\nMore summary content")
		expect(result.summaries[1]).toBe("# Session 1\nSome summary content")
	})

	it("reads failure log JSONL file", async () => {
		mockReaddir.mockResolvedValueOnce([])
		mockReadFile.mockImplementation(async (path: string) => {
			if (path.includes("failure-log")) {
				return '{"type":"timeout","timestamp":"2024-01-01T10:00:00Z"}\n{"type":"auth_error","timestamp":"2024-01-01T11:00:00Z"}\n'
			}
			return ""
		})

		const result = await summarizeLogs("/memory")

		expect(mockReadFile).toHaveBeenCalledWith("/memory/failure-log.jsonl", "utf-8")
		expect(result.failurePatterns).toHaveLength(2)
	})

	it("aggregates failure patterns by type", async () => {
		mockReaddir.mockResolvedValueOnce([])
		mockReadFile.mockImplementation(async (path: string) => {
			if (path.includes("failure-log")) {
				return (
					'{"type":"timeout","timestamp":"2024-01-01T10:00:00Z"}\n' +
					'{"type":"timeout","timestamp":"2024-01-02T10:00:00Z"}\n' +
					'{"type":"timeout","timestamp":"2024-01-01T09:00:00Z"}\n' +
					'{"type":"auth_error","timestamp":"2024-01-01T11:00:00Z"}\n'
				)
			}
			return ""
		})

		const result = await summarizeLogs("/memory")

		expect(result.failurePatterns).toHaveLength(2)
		const timeoutPattern = result.failurePatterns.find((p: { type: string }) => p.type === "timeout")
		expect(timeoutPattern?.count).toBe(3)
		expect(timeoutPattern?.lastSeen).toBe("2024-01-02T10:00:00Z")
		const authPattern = result.failurePatterns.find((p: { type: string }) => p.type === "auth_error")
		expect(authPattern?.count).toBe(1)
	})

	it("returns empty arrays when logs are missing", async () => {
		mockReaddir.mockRejectedValueOnce(new Error("ENOENT"))
		mockReadFile.mockRejectedValueOnce(new Error("ENOENT"))

		const result = await summarizeLogs("/memory")

		expect(result.summaries).toEqual([])
		expect(result.failurePatterns).toEqual([])
	})

	it("skips malformed JSON lines in failure log", async () => {
		mockReaddir.mockResolvedValueOnce([])
		const malformedContent = `${[
			'{"type":"timeout","timestamp":"2024-01-01T10:00:00Z"}',
			"not valid json",
			'{"type":"auth_error","timestamp":"2024-01-01T11:00:00Z"}',
		].join("\n")}\n`
		mockReadFile.mockImplementation(async (path: string) => {
			if (path.includes("failure-log")) return malformedContent
			return ""
		})

		const result = await summarizeLogs("/memory")

		expect(result.failurePatterns).toHaveLength(2)
	})

	it("limits summaries to MAX_SUMMARIES", async () => {
		const mockEntries: MockDirent[] = Array.from({ length: 25 }, (_, i) => ({
			name: `summary-${i}.md`,
			isFile: () => true,
			isDirectory: () => false,
		}))

		mockReaddir.mockResolvedValueOnce(mockEntries)
		mockReadFile.mockResolvedValue("content")

		const result = await summarizeLogs("/memory")

		expect(result.summaries).toHaveLength(20)
	})

	it("limits failure log entries to MAX_FAILURES", async () => {
		mockReaddir.mockResolvedValueOnce([])
		const manyLines = Array.from({ length: 100 }, (_, i) => {
			const typeNum = i % 50
			return `{"type":"error_${typeNum}","timestamp":"2024-01-${String((i % 30) + 1).padStart(2, "0")}T00:00:00Z"}`
		}).join("\n")
		mockReadFile.mockImplementation(async (path: string) => {
			if (path.includes("failure-log")) return manyLines
			return ""
		})

		const result = await summarizeLogs("/memory")

		// Should get 50 aggregated patterns (one per unique type)
		expect(result.failurePatterns).toHaveLength(50)
	})
})
