// ACP integration — skill auto-load on prompt keywords.
//
// Dual-surface parity for the skills-manager auto-loader: the TUI e2e
// (tests/e2e/tui/skill-autoload.test.ts) covers the terminal surface; this
// test drives the real ACP server process end-to-end. A prompt naming a
// .pdf file must deterministically inject the bundled pdf skill body as a
// steer BEFORE the first inference — the fake provider records every
// request body, so the assertion happens at the provider boundary: the
// first chat request already carries the skill body wrapped in
// <system-reminder>, without any skill_view tool call. The session JSONL
// carries the persisted skill_autoload_loaded entry.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

/** Distinctive fragments of the bundled pdf skill's body. */
const BODY_MARKERS = ["dump-shapes", "fill-form"]

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(PROMPT_TIMEOUT_MS).then(() => {
			throw new Error(`${label} timed out after ${PROMPT_TIMEOUT_MS}ms`)
		}),
	])
}

interface SessionEntryLine {
	type: string
	customType?: string
	data?: { name?: string; pattern?: string; turnIndex?: number }
}

function readJsonl(path: string): SessionEntryLine[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as SessionEntryLine)
}

describe("ACP integration — skill auto-load on prompt keywords", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-skill-autoload",
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [{ stream: ["Acknowledged."], usage: { prompt_tokens: 10_000, completion_tokens: 50 } }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("injects the pdf skill body into the first chat request when the prompt names a .pdf", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = (await withTimeout(
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "read ~/runbook-q4.pdf and summarize it in two lines" }],
			}),
			"prompt",
		)) as { stopReason: string }
		expect(result.stopReason).toBe("end_turn")

		// The first chat request already carried the auto-loaded skill body
		// as a steer — determinism proven at the wire. (Later harness calls,
		// e.g. session naming, don't matter; the injection must land before
		// the FIRST inference.)
		const chatBodies = fixture.fake.requests
			.filter((r) => r.method === "POST" && r.url?.includes("/chat/completions"))
			.map((r) => JSON.stringify(r.body))
		expect(chatBodies.length).toBeGreaterThan(0)
		expect(chatBodies[0]).toContain("auto-loaded because the prompt matched its declared trigger")
		expect(chatBodies[0]).toContain("<system-reminder>")
		expect(chatBodies[0]).toContain("Skill directory:")
		for (const marker of BODY_MARKERS) expect(chatBodies[0]).toContain(marker)
		// no skill_view tool call was issued or answered in this single turn
		expect(chatBodies[0]).not.toContain('"name": "skill_view"')
		// exactly one request carries the injection — one-shot per session
		expect(chatBodies.filter((b) => b.includes("auto-loaded because the prompt matched"))).toHaveLength(1)

		// The persisted session records the load with its matched pattern.
		const encodedWorkDir = `--${fixture.workDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
		const sessionSubdir = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions", encodedWorkDir)
		const sessionFiles = readdirSync(sessionSubdir).filter((f) => f.endsWith(".jsonl"))
		expect(sessionFiles, "session JSONL under the ACP agent dir").toHaveLength(1)
		const entries = readJsonl(join(sessionSubdir, sessionFiles[0]))
		const loaded = entries.filter((e) => e.type === "custom" && e.customType === "skill_autoload_loaded")
		expect(loaded).toHaveLength(1)
		expect(loaded[0].data?.name).toBe("pdf")
		expect(loaded[0].data?.pattern).toBe("\\.pdf\\b")
		expect(loaded[0].data?.turnIndex).toBe(0)
	})
})
