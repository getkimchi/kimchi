// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { validateURL } from "./url-validator.js"

describe("validateURL", () => {
	describe("valid URLs", () => {
		it("accepts http URL", () => {
			const result = validateURL("http://example.com")
			expect(result.valid).toBe(true)
			if (result.valid) {
				expect(result.url.href).toBe("http://example.com/")
			}
		})

		it("accepts https URL", () => {
			const result = validateURL("https://example.com/path?q=1#frag")
			expect(result.valid).toBe(true)
			if (result.valid) {
				expect(result.url.href).toBe("https://example.com/path?q=1#frag")
			}
		})

		it("accepts URL with port", () => {
			const result = validateURL("https://example.com:8080/page")
			expect(result.valid).toBe(true)
		})

		it("accepts public IP address", () => {
			const result = validateURL("http://8.8.8.8")
			expect(result.valid).toBe(true)
		})

		it("accepts 172.x address outside private range", () => {
			const result = validateURL("http://172.15.0.1")
			expect(result.valid).toBe(true)
		})

		it("accepts 172.32.x address outside private range", () => {
			const result = validateURL("http://172.32.0.1")
			expect(result.valid).toBe(true)
		})
	})

	describe("invalid URLs", () => {
		it("rejects malformed URL", () => {
			const result = validateURL("not-a-url")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("Invalid URL")
			}
		})

		it("rejects empty string", () => {
			const result = validateURL("")
			expect(result.valid).toBe(false)
		})

		it("rejects URL without scheme", () => {
			const result = validateURL("example.com")
			expect(result.valid).toBe(false)
		})
	})

	describe("blocked schemes", () => {
		it("rejects ftp scheme", () => {
			const result = validateURL("ftp://example.com/file")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("Unsupported scheme")
				expect(result.error).toContain("ftp")
			}
		})

		it("rejects file scheme", () => {
			const result = validateURL("file:///etc/passwd")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("Unsupported scheme")
			}
		})

		it("rejects javascript scheme", () => {
			const result = validateURL("javascript:alert(1)")
			expect(result.valid).toBe(false)
		})

		it("rejects data scheme", () => {
			const result = validateURL("data:text/html,<h1>Hi</h1>")
			expect(result.valid).toBe(false)
		})
	})

	describe("SSRF protection — private IPv4 ranges", () => {
		it("blocks 10.0.0.0/8", () => {
			const result = validateURL("http://10.0.0.1")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("SSRF")
				expect(result.error).toContain("10.0.0.0/8")
			}
		})

		it("blocks 10.255.255.255", () => {
			const result = validateURL("http://10.255.255.255")
			expect(result.valid).toBe(false)
		})

		it("blocks 127.0.0.0/8 (loopback)", () => {
			const result = validateURL("http://127.0.0.1")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("loopback")
			}
		})

		it("blocks 127.0.0.2", () => {
			const result = validateURL("http://127.0.0.2")
			expect(result.valid).toBe(false)
		})

		it("blocks 169.254.0.0/16 (link-local)", () => {
			const result = validateURL("http://169.254.1.1")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("link-local")
			}
		})

		it("blocks 192.168.0.0/16", () => {
			const result = validateURL("http://192.168.1.1")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("192.168")
			}
		})

		it("blocks 172.16.0.0/12 (172.16.x.x)", () => {
			const result = validateURL("http://172.16.0.1")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("172.16.0.0/12")
			}
		})

		it("blocks 172.31.255.255 (top of 172.16/12 range)", () => {
			const result = validateURL("http://172.31.255.255")
			expect(result.valid).toBe(false)
		})

		it("blocks 172.20.0.1", () => {
			const result = validateURL("http://172.20.0.1")
			expect(result.valid).toBe(false)
		})
	})

	describe("SSRF protection — localhost", () => {
		it("blocks localhost", () => {
			const result = validateURL("http://localhost")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("localhost")
			}
		})

		it("blocks localhost with port", () => {
			const result = validateURL("http://localhost:3000")
			expect(result.valid).toBe(false)
		})

		it("blocks localhost.localdomain", () => {
			const result = validateURL("http://localhost.localdomain")
			expect(result.valid).toBe(false)
		})
	})

	describe("SSRF protection — cloud metadata endpoints", () => {
		it("blocks AWS/GCP metadata endpoint 169.254.169.254", () => {
			const result = validateURL("http://169.254.169.254/latest/meta-data/")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("SSRF")
			}
		})

		it("blocks GCP metadata.google.internal", () => {
			const result = validateURL("http://metadata.google.internal/computeMetadata/v1/")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("metadata")
			}
		})
	})

	describe("SSRF protection — IPv6", () => {
		it("blocks ::1 (IPv6 loopback)", () => {
			const result = validateURL("http://[::1]/")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("IPv6")
			}
		})

		it("blocks fc00:: (unique-local)", () => {
			const result = validateURL("http://[fc00::1]/")
			expect(result.valid).toBe(false)
		})

		it("blocks fd00:: (unique-local)", () => {
			const result = validateURL("http://[fd12:3456::1]/")
			expect(result.valid).toBe(false)
		})

		it("blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", () => {
			const result = validateURL("http://[::ffff:127.0.0.1]/")
			expect(result.valid).toBe(false)
			if (!result.valid) {
				expect(result.error).toContain("SSRF")
			}
		})

		it("blocks IPv4-mapped IPv6 private ::ffff:10.0.0.1", () => {
			const result = validateURL("http://[::ffff:10.0.0.1]/")
			expect(result.valid).toBe(false)
		})

		it("allows IPv4-mapped IPv6 public address", () => {
			const result = validateURL("http://[::ffff:8.8.8.8]/")
			expect(result.valid).toBe(true)
		})
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
