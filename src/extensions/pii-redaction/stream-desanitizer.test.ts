import { beforeEach, describe, expect, it } from "vitest"
import { StreamDesanitizer } from "./stream-desanitizer.js"
import { createTokenVault, resetTokenVaults, tokenFor } from "./vault.js"

describe("StreamDesanitizer", () => {
	beforeEach(() => {
		resetTokenVaults()
	})

	function tokensVault() {
		const vault = createTokenVault()
		return {
			vault,
			email: tokenFor(vault, "EMAIL_ADDRESS", "jane.doe@acme.com"),
			ip: tokenFor(vault, "IP_ADDRESS", "84.17.46.1"),
		}
	}

	it("substitutes a complete token arriving in one delta", () => {
		const { vault, email } = tokensVault()
		const d = new StreamDesanitizer(vault)
		expect(d.push(`contact ${email} today`)).toBe("contact jane.doe@acme.com today")
		expect(d.flush()).toBe("")
	})

	it("substitutes identically at every split point (property over offsets)", () => {
		const { vault, email, ip } = tokensVault()
		const full = `mail ${email} or ${ip}; end`
		for (let cut = 0; cut <= full.length; cut++) {
			// Fresh desanitizer per offset: a token split anywhere must yield
			// exactly the whole-text substitution.
			const d = new StreamDesanitizer(vault)
			const out = d.push(full.slice(0, cut)) + d.push(full.slice(cut)) + d.flush()
			expect(out).toBe(full.replaceAll(email, "jane.doe@acme.com").replaceAll(ip, " 84.17.46.1".trim()))
		}
	})

	it("substitutes across many small deltas", () => {
		const { vault, email } = tokensVault()
		const d = new StreamDesanitizer(vault)
		const full = `x ${email} y`
		let out = ""
		for (const ch of full) out += d.push(ch)
		out += d.flush()
		expect(out).toBe("x jane.doe@acme.com y")
	})

	it("passes confabulated (never-allocated) tokens through verbatim", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		expect(d.push("imagine [EMAIL_ADDRESS_42] exists")).toBe("imagine [EMAIL_ADDRESS_42] exists")
		expect(d.flush()).toBe("")
	})

	it("streams [REDACTED-…] markers immediately (no holdback)", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		// A marker split across deltas must NOT be held: the hyphen breaks
		// the candidate shape, so each delta flows through as-is.
		expect(d.push("see [REDACTED-EMAIL")).toBe("see [REDACTED-EMAIL")
		expect(d.push("_ADDRESS]")).toBe("_ADDRESS]")
		expect(d.flush()).toBe("")
	})

	it("holds only a bounded tail: a '[' + 500 letters flood is never retained", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		// First delta: a plausible start — held.
		expect(d.push("[")).toBe("")
		// Then a flood that can no longer be a token: everything flushes out.
		const flood = d.push("A".repeat(500))
		expect(flood.length).toBeGreaterThan(0)
		expect(flood).toBe(`[${"A".repeat(500)}`)
		expect(d.flush()).toBe("")
	})

	it("digit run after a token-shaped prefix never accumulates unboundedly", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		// Plausible prefix with a short counter — held (fits the 42-char cap).
		expect(d.push("[EMAIL_ADDRESS_12")).toBe("")
		// Once the run exceeds the cap it can never complete as a token —
		// the whole buffered prefix flushes through verbatim instead of
		// accumulating with the flood.
		const buffered = `[EMAIL_ADDRESS_12${"3".repeat(500)}`
		expect(d.push("3".repeat(500))).toBe(buffered)
		expect(d.flush()).toBe("")
		// Repeated floods: holdback stays bounded regardless of stream length.
		const tail = "[EMAIL_ADDRESS_1"
		expect(d.push(tail)).toBe("")
		expect(d.push("3".repeat(300))).toBe(`${tail}${"3".repeat(300)}`)
		expect(d.flush()).toBe("")
	})

	it("flush emits a held incomplete tail verbatim", () => {
		const { vault, email } = tokensVault()
		const d = new StreamDesanitizer(vault)
		const pushed = d.push(`see ${email.slice(0, 8)}`)
		expect(pushed + d.flush()).toBe(`see ${email.slice(0, 8)}`)
	})

	it("a complete token substitutes immediately on push (no unnecessary holdback)", () => {
		const { vault, email } = tokensVault()
		const d = new StreamDesanitizer(vault)
		expect(d.push(`see ${email}`)).toBe("see jane.doe@acme.com")
		expect(d.flush()).toBe("")
	})

	it("handles empty pushes and a bare '[' at stream end", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		expect(d.push("")).toBe("")
		expect(d.push("arr [")).toBe("arr ")
		// Stream ends with a dangling bracket — emit as written, not lost.
		expect(d.flush()).toBe("[")
	})

	it("does not mistake array/prose brackets for tokens during streaming", () => {
		const { vault } = tokensVault()
		const d = new StreamDesanitizer(vault)
		expect(d.push("a[0] and b[x] stay")).toBe("a[0] and b[x] stay")
		expect(d.flush()).toBe("")
	})
})
