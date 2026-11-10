/**
 * Unit probes for the fail-closed path-argument guard: which argument keys
 * are inspected, which shapes are ignored, and what the block reason says.
 * The hook wiring (gating on enablement, nested codemode calls) lives in
 * index.test.ts.
 */
import { describe, expect, it } from "vitest"
import { findPathArgPlaceholder, pathArgPlaceholderReason } from "./path-arg-guard.js"

describe("findPathArgPlaceholder", () => {
	it("finds a marker in the path argument", () => {
		expect(findPathArgPlaceholder({ path: "[REDACTED-LOCAL_PATH]" })).toEqual({
			key: "path",
			marker: "[REDACTED-LOCAL_PATH]",
		})
	})

	it("finds a marker inside a longer path", () => {
		const finding = findPathArgPlaceholder({ path: "src/[REDACTED-LOCAL_PATH]/nested" })
		expect(finding?.key).toBe("path")
		expect(finding?.marker).toBe("[REDACTED-LOCAL_PATH]")
	})

	it("covers the file_path and filePath aliases", () => {
		expect(findPathArgPlaceholder({ file_path: "[REDACTED-SECRET_FIELD]" })?.key).toBe("file_path")
		expect(findPathArgPlaceholder({ filePath: "[REDACTED-AWS_SECRET_KEY]" })?.key).toBe("filePath")
	})

	it("never inspects content or other free-text keys", () => {
		// Writing tests and docs that contain markers must keep working —
		// this very file is such a document.
		expect(
			findPathArgPlaceholder({
				content: "[REDACTED-LOCAL_PATH] in prose",
				code: 'tools.write({ path: "[REDACTED-LOCAL_PATH]" })',
				command: "cat [REDACTED-LOCAL_PATH]",
				pattern: "[REDACTED-LOCAL_PATH]",
				text: "[REDACTED-LOCAL_PATH]",
			}),
		).toBeUndefined()
	})

	it("ignores absent or non-string path values", () => {
		expect(findPathArgPlaceholder({})).toBeUndefined()
		expect(findPathArgPlaceholder({ path: undefined })).toBeUndefined()
		expect(findPathArgPlaceholder({ path: 42 })).toBeUndefined()
		expect(findPathArgPlaceholder({ path: { nested: "[REDACTED-LOCAL_PATH]" } })).toBeUndefined()
	})

	it("returns undefined for a clean path", () => {
		expect(findPathArgPlaceholder({ path: "src/tsconfig.json", content: "x" })).toBeUndefined()
	})

	it("is total: non-object inputs are safe", () => {
		expect(findPathArgPlaceholder(null)).toBeUndefined()
		expect(findPathArgPlaceholder(undefined)).toBeUndefined()
		expect(findPathArgPlaceholder("just a string")).toBeUndefined()
		expect(findPathArgPlaceholder(7)).toBeUndefined()
	})

	it("the reason names the argument, the tool, and the placeholder", () => {
		const reason = pathArgPlaceholderReason({ key: "path", marker: "[REDACTED-LOCAL_PATH]" }, "write")
		expect(reason).toContain('"path"')
		expect(reason).toContain("write")
		expect(reason).toContain("[REDACTED-LOCAL_PATH]")
	})
})
