import { describe, expect, it } from "vitest"
import { formatSessionLabel } from "./teleport.js"

describe("formatSessionLabel", () => {
	it("strips .remote.kimchi.dev and wraps in parens", () => {
		expect(formatSessionLabel("s-abc.remote.kimchi.dev")).toBe("(s-abc)")
	})

	it("preserves non-kimchi hosts", () => {
		expect(formatSessionLabel("host.example.com")).toBe("(host.example.com)")
	})

	it("falls back to (remote) for undefined", () => {
		expect(formatSessionLabel(undefined)).toBe("(remote)")
	})

	it("falls back to (remote) for empty string", () => {
		expect(formatSessionLabel("")).toBe("(remote)")
	})

	it("handles host that is exactly .remote.kimchi.dev", () => {
		expect(formatSessionLabel(".remote.kimchi.dev")).toBe("(remote)")
	})

	it("strips suffix from long session names", () => {
		expect(formatSessionLabel("trusting-expensive-titan-e0baa2-a980.remote.kimchi.dev")).toBe(
			"(trusting-expensive-titan-e0baa2-a980)",
		)
	})
})
