import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

/**
 * ACP-side parity for the reversible redaction feature (TUI coverage lives
 * in tests/e2e/tui/pii-redaction.test.ts): with token mode enabled, the
 * session file and the provider keep `[ENTITY_N]` tokens while the ACP
 * client stream shows the ORIGINAL text — the substitution is
 * presentation-side and the stored form is unconditionally tokenized.
 */
describe("ACP reversible redaction (token mode)", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("ACP stream shows originals while provider and session file hold tokens", async () => {
		// Assembled at runtime — a literal address would itself be redacted
		// by any agent pipeline editing this file.
		const email = ["alice.stone", "corp-mail.io"].join("@")
		fixture = await startAcpFixture({
			artifactName: "acp-redaction-tokens",
			responses: [
				{ stream: [`Replying to ${email} as asked`] },
				// Second turn: the model ECHOES the stored token (realistic — the
				// stored transcript in its context is tokenized). This is the
				// delta path's real workload: split-token streaming substitution.
				{ stream: [`Reaching out to [EMAIL_ADDRESS_1], specifically ${email}`] },
			],
			settings: {
				redaction: { renderMode: "tokens" },
				resources: { "extensions.pii-redaction": true },
			},
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		const result = await prompt(fixture, session.sessionId, [`echo back ${email} verbatim`].join(" "))
		expect(result.stopReason).toBe("end_turn")

		// Presentation: the client sees the ORIGINAL text — substitution is
		// server-side, chunks stream already substituted.
		expect(result.chunks).toContain(email)
		expect(result.chunks).not.toContain("[EMAIL_ADDRESS_")
		expect(result.chunks).not.toContain("[REDACTED-EMAIL_ADDRESS]")

		// The echoed token from the model mouths out the ORIGINAL the vault
		// recorded — the client never sees the tokenize stored form.
		const echo = await prompt(fixture, session.sessionId, "who are you reaching out to?")
		expect(echo.stopReason).toBe("end_turn")
		// chunks accumulate for the session; the echoed token must surface as
		// the ORIGINAL, and no token shape may appear in any streamed text.
		expect(echo.chunks).toContain(`Reaching out to ${email}, specifically ${email}`)
		expect(echo.chunks).not.toContain("[EMAIL_ADDRESS_")

		// Provider side: the outgoing request carries tokens only.
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat.length).toBeGreaterThan(0)
		const wire = JSON.stringify(chat.map((request) => request.body))
		expect(wire).toContain("[EMAIL_ADDRESS_1]")
		expect(wire).not.toContain(email)
		expect(wire).not.toContain("[REDACTED-EMAIL_ADDRESS]")

		// Disk side: the session transcript is tokenized end to end.
		const listJsonl = (root: string): string[] => {
			const out: string[] = []
			for (const entry of readdirSync(root)) {
				const path = join(root, entry)
				if (statSync(path).isDirectory()) out.push(...listJsonl(path))
				else if (entry.endsWith(".jsonl")) out.push(path)
			}
			return out
		}
		const sessionsDir = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
		const stored = listJsonl(sessionsDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n")
		expect(stored).toContain("[EMAIL_ADDRESS_1]")
		expect(stored).not.toContain(email)
		expect(stored).not.toContain("[REDACTED-EMAIL_ADDRESS]")
	})
})
