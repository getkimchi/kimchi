import { describe, expect, it, vi } from "vitest"
import { promptForApproval, truncate } from "./prompts.js"

describe("truncate helper", () => {
	it("returns original string if under max length", () => {
		expect(truncate("short", 10)).toBe("short")
	})

	it("truncates strings exceeding max length", () => {
		expect(truncate("hello world", 5)).toBe("hell…")
	})

	it("handles exact length strings", () => {
		expect(truncate("hello", 5)).toBe("hello")
	})
})

describe("promptForApproval — title sanitization", () => {
	function fakeCtx(captureTitle: (t: string) => void) {
		return {
			hasUI: true,
			ui: {
				select: vi.fn(async (title: string) => {
					captureTitle(title)
					return undefined
				}),
				input: vi.fn(),
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any
	}

	it("collapses newlines in a multi-line bash command before passing to ui.select", async () => {
		let observed = ""
		const ctx = fakeCtx((t) => {
			observed = t
		})
		const multiline = ['python3 -c "', "import os", "print(os.uname())", '"'].join("\n")
		await promptForApproval({ toolName: "bash", input: { command: multiline }, ctx })
		expect(observed).not.toContain("\nimport os")
		expect(observed).toContain(" ⏎ import os ⏎ ")
		// only the explicit separator between title and subtitle should be a newline; the
		// command itself must not introduce any
		expect(observed.split("\n").length).toBe(1)
	})

	it("collapses newlines for non-bash tools with a path", async () => {
		let observed = ""
		const ctx = fakeCtx((t) => {
			observed = t
		})
		await promptForApproval({ toolName: "read", input: { path: "weird\npath" }, ctx })
		expect(observed).not.toContain("\npath")
		expect(observed).toContain(" ⏎ ")
	})
})
