import { describe, expect, it } from "vitest"
import { redact } from "./engine.js"
import { collectKnownSecrets } from "./secret-registry.js"

describe("smoke tests", () => {
	it("collects apiKey from process.env.KIMCHI_API_KEY", () => {
		const saved = process.env.KIMCHI_API_KEY
		process.env.KIMCHI_API_KEY = "test-api-key-for-smoke-12345"
		try {
			const secrets = collectKnownSecrets()
			expect(secrets.has("test-api-key-for-smoke-12345")).toBe(true)
		} finally {
			process.env.KIMCHI_API_KEY = saved
		}
	})

	it("redacts known apiKey in printenv-style output", () => {
		const secrets = new Set(["test-api-key-for-smoke-12345"])
		const output = "HOME=/home/user\nKIMCHI_API_KEY=test-api-key-for-smoke-12345\nPATH=/usr/bin"
		const result = redact(output, secrets)
		expect(result).toContain("[REDACTED]")
		expect(result).not.toContain("test-api-key-for-smoke-12345")
	})

	it("redacts GitHub token pattern (unknown secret)", () => {
		const output = "token = ghp_0123456789abcdefghij0123456789abcdefghij"
		const result = redact(output, new Set())
		expect(result).toBe("token = [REDACTED]")
	})

	it("does not false-positive on normal ls output", () => {
		const secrets = new Set(["test-api-key-for-smoke-12345"])
		const output = "file1.txt\nfile2.txt\ndocs/\nsrc/"
		expect(redact(output, secrets)).toBe(output)
	})

	it("redacts AWS credentials in config format", () => {
		const output =
			"aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
		const result = redact(output, new Set())
		expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE")
		expect(result).not.toContain("wJalrXUtnFEMI")
	})

	it("redacts PEM private key block", () => {
		const output = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----`
		const result = redact(output, new Set())
		expect(result).toBe("[REDACTED]")
	})
})
