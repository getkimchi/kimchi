import { describe, expect, it } from "vitest"
import { collapseCommand } from "./bash-collapse.js"

describe("collapseCommand", () => {
	it("collapses consecutive newlines into a printable arrow", () => {
		expect(collapseCommand("echo hello\necho world")).toBe("echo hello ⏎ echo world")
	})

	it("handles multiple consecutive newlines", () => {
		// Multiple consecutive newlines collapse into a single arrow.
		expect(collapseCommand("cat << 'EOF'\nhello\n\nworld\nEOF")).toBe("cat << 'EOF' ⏎ hello ⏎ world ⏎ EOF")
	})

	it("leaves single-line commands untouched", () => {
		expect(collapseCommand("git status")).toBe("git status")
	})

	it("defaults to empty string when command is undefined", () => {
		expect(collapseCommand(undefined)).toBe("")
	})
})
