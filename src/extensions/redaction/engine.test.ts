import { describe, expect, it } from "vitest"
import { PATTERN_CATALOG, redact } from "./engine.js"

describe("redact", () => {
	describe("pattern catalog", () => {
		it("redacts AWS access key IDs", () => {
			const text = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"
			expect(redact(text, new Set())).toBe("aws_access_key_id = [REDACTED]")
		})

		it("redacts AWS secret access keys in config format", () => {
			const text = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
			expect(redact(text, new Set())).toBe("aws_secret_access_key = [REDACTED]")
		})

		it("redacts AWS secret access keys with colon separator", () => {
			const text = 'aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
			expect(redact(text, new Set())).toBe('aws_secret_access_key: "[REDACTED]"')
		})

		it("redacts GitHub classic tokens", () => {
			const text = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
			expect(redact(text, new Set())).toBe("GITHUB_TOKEN=[REDACTED]")
		})

		it("redacts GitHub fine-grained PATs", () => {
			const text = "github_pat_abcdefghijklmnopqrstuvwxyz0123"
			expect(redact(text, new Set())).toBe("[REDACTED]")
		})

		it("redacts GitLab tokens", () => {
			const text = "gitlab_token=glpat-abcdefghijklmnopqrstuvwxyz0123"
			expect(redact(text, new Set())).toBe("gitlab_token=[REDACTED]")
		})

		it("redacts JWTs", () => {
			const jwt =
				"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
			expect(redact(`token: ${jwt}`, new Set())).toBe("token: [REDACTED]")
		})

		it("redacts JWTs with non-eyJ payload and signature", () => {
			// Header starts with eyJ, but payload and signature do not.
			const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.U29tZS1iYXNlNjQtcGF5bG9hZA.SflKxwRJSMeKKF2QT4fwpMeJf36P"
			expect(redact(`token: ${jwt}`, new Set())).toBe("token: [REDACTED]")
		})

		it("redacts PEM private key blocks", () => {
			const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF5TkDkLQ7n5t1QX2uJ
fM1H5ZbGaR9V4pDqsM7n5t1QX2uJfM1H5ZbGaR9V4pDqsM7n5t1QX2
-----END RSA PRIVATE KEY-----`
			expect(redact(text, new Set())).toBe("[REDACTED]")
		})

		it("redacts Slack tokens", () => {
			const text = "slack_token=xoxb-fakeslacktoken-notarealtoken-fakedata12"
			expect(redact(text, new Set())).toBe("slack_token=[REDACTED]")
		})

		it("redacts generic Bearer tokens", () => {
			const text = "Authorization: Bearer dGhpcyBpcyBhIHNlY3JldCB0b2tlbg=="
			expect(redact(text, new Set())).toBe("Authorization: [REDACTED]")
		})

		it("redacts Bearer tokens with base64 characters", () => {
			const text = "Authorization: Bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
			expect(redact(text, new Set())).toBe("Authorization: [REDACTED]")
		})

		it("redacts env var assignments with API_KEY in name", () => {
			const text = "MY_API_KEY=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
			expect(redact(text, new Set())).toBe("MY_API_KEY=[REDACTED]")
		})

		it("redacts env var assignments with ACCESS_KEY in name", () => {
			const text = "STORAGE_ACCESS_KEY=GOOG1EH37KFIKLDLG6DW7BYS3ZWBOJVTELXQO35B4"
			expect(redact(text, new Set())).toBe("STORAGE_ACCESS_KEY=[REDACTED]")
		})

		it("redacts env var assignments with PASSWORD in name", () => {
			const text = "DB_PASSWORD=abcdef0123456789abcdef0123456789"
			expect(redact(text, new Set())).toBe("DB_PASSWORD=[REDACTED]")
		})

		it("redacts env var assignments with SECRET in name and colon separator", () => {
			const text = "client_secret: dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ=="
			expect(redact(text, new Set())).toBe("client_secret: [REDACTED]")
		})

		it("redacts quoted secret values", () => {
			const text = 'DB_PASSWORD="my-secret-pass-1234"'
			expect(redact(text, new Set())).toBe('DB_PASSWORD="[REDACTED]"')
		})

		it("redacts multiple env var secrets in one block", () => {
			const text = [
				"DB_PASSWORD=abcdef0123456789abcdef0123456789",
				"STORAGE_ACCESS_KEY=GOOG1EH37KFIKLDLG6DW7BYS3ZWBOJVTELXQO35B4",
				"API_SECRET=dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ==",
			].join("\n")
			const result = redact(text, new Set())
			expect(result).toBe("DB_PASSWORD=[REDACTED]\nSTORAGE_ACCESS_KEY=[REDACTED]\nAPI_SECRET=[REDACTED]")
		})

		it("does not false-positive on non-secret KEY names", () => {
			const text = "MONKEY_TYPE=chimpanzee"
			expect(redact(text, new Set())).toBe("MONKEY_TYPE=chimpanzee")
		})

		it("does not redact short values under 8 chars", () => {
			const text = "API_KEY=abc123"
			expect(redact(text, new Set())).toBe("API_KEY=abc123")
		})

		it("preserves the key name, redacts only the value", () => {
			const text = "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
			const result = redact(text, new Set())
			expect(result).toBe("TOKEN=[REDACTED]")
		})
	})

	describe("exact-match stage", () => {
		it("redacts a known apiKey", () => {
			const secrets = new Set(["test-api-key-123456789"])
			expect(redact("key=test-api-key-123456789", secrets)).toBe("key=[REDACTED]")
		})

		it("redacts a known gitToken", () => {
			const secrets = new Set(["ghp_knownTokenValue123456789012345678"])
			expect(redact("token: ghp_knownTokenValue123456789012345678", secrets)).toBe("token: [REDACTED]")
		})

		it("redacts multiple known secrets in one string", () => {
			const secrets = new Set(["secret-aaaa1111", "secret-bbbb2222"])
			expect(redact("a=secret-aaaa1111 b=secret-bbbb2222", secrets)).toBe("a=[REDACTED] b=[REDACTED]")
		})

		it("redacts secret at start of text", () => {
			const secrets = new Set(["test-secret-value-12345678"])
			expect(redact("test-secret-value-12345678 is here", secrets)).toBe("[REDACTED] is here")
		})

		it("redacts secret at end of text", () => {
			const secrets = new Set(["test-secret-value-12345678"])
			expect(redact("here is test-secret-value-12345678", secrets)).toBe("here is [REDACTED]")
		})

		it("redacts secret in middle of text", () => {
			const secrets = new Set(["test-secret-value-12345678"])
			expect(redact("prefix test-secret-value-12345678 suffix", secrets)).toBe("prefix [REDACTED] suffix")
		})
	})

	describe("edge cases", () => {
		it("returns empty string unchanged", () => {
			expect(redact("", new Set())).toBe("")
		})

		it("returns text unchanged when no secrets match", () => {
			const text = "just a normal command output line"
			expect(redact(text, new Set())).toBe(text)
		})

		it("skips known secrets shorter than 8 characters", () => {
			const secrets = new Set(["short"])
			expect(redact("this is short text", secrets)).toBe("this is short text")
		})

		it("does not false-positive on short eyJ strings", () => {
			expect(redact("data=eyJabc.eyJdef.eyJghi", new Set())).toBe("data=eyJabc.eyJdef.eyJghi")
		})

		it("handles multiple PEM blocks in one string", () => {
			const text = `Key1:
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF5TkDkLQ7n5t1QX2uJ
-----END RSA PRIVATE KEY-----
Key2:
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINrU8VRnVqk1tqK8r5n2d3V4xk7WpQ6vZ3F2bN9mY4T7
-----END EC PRIVATE KEY-----`
			const result = redact(text, new Set())
			expect(result).toBe("Key1:\n[REDACTED]\nKey2:\n[REDACTED]")
		})

		it("exact-match runs before patterns, preventing pattern from seeing the secret", () => {
			const secrets = new Set(["ghp_abcdefghijklmnopqrstuvwxyz0123456789"])
			const text = "key=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
			expect(redact(text, secrets)).toBe("key=[REDACTED]")
		})
	})
})
