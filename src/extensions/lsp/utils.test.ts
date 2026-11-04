// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// src/extensions/lsp/utils.test.ts
import { describe, expect, it } from "vitest"
import { detectLanguageId, fileToUri, formatDiagnostic, uriToFile } from "./utils.js"

describe("fileToUri", () => {
	it("converts absolute unix path to file URI", () => {
		expect(fileToUri("/home/user/foo.ts")).toBe("file:///home/user/foo.ts")
	})

	it("resolves relative paths", () => {
		const result = fileToUri("foo.ts")
		expect(result).toMatch(/^file:\/\/\//)
		expect(result).toMatch(/foo\.ts$/)
	})
})

describe("uriToFile", () => {
	it("converts file URI back to path", () => {
		expect(uriToFile("file:///home/user/foo.ts")).toBe("/home/user/foo.ts")
	})

	it("passes through non-file URIs", () => {
		expect(uriToFile("untitled:foo")).toBe("untitled:foo")
	})

	it("round-trips with fileToUri", () => {
		const path = "/tmp/test/bar.go"
		expect(uriToFile(fileToUri(path))).toBe(path)
	})
})

describe("detectLanguageId", () => {
	it("detects TypeScript", () => {
		expect(detectLanguageId("foo.ts")).toBe("typescript")
	})

	it("detects TypeScript JSX", () => {
		expect(detectLanguageId("foo.tsx")).toBe("typescriptreact")
	})

	it("detects Go", () => {
		expect(detectLanguageId("foo.go")).toBe("go")
	})

	it("detects JavaScript", () => {
		expect(detectLanguageId("foo.js")).toBe("javascript")
	})

	it("falls back to plaintext for unknown", () => {
		expect(detectLanguageId("foo.xyz")).toBe("plaintext")
	})
})

describe("formatDiagnostic", () => {
	it("formats an error diagnostic", () => {
		const result = formatDiagnostic({
			range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
			severity: 1,
			message: "Cannot find name 'foo'",
		})
		expect(result).toBe("5:3 error: Cannot find name 'foo'")
	})

	it("formats a warning diagnostic with code", () => {
		const result = formatDiagnostic({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 2,
			code: "TS2345",
			message: "Type mismatch",
		})
		expect(result).toBe("1:1 warning [TS2345]: Type mismatch")
	})

	it("defaults to error severity when missing", () => {
		const result = formatDiagnostic({
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			message: "something wrong",
		})
		expect(result).toContain("error")
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
