import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Phrase from LSP_SYSTEM_PROMPT that appears in provider requests when the
 *  lsp-tools prompt block is active (i.e. at least one server binary on PATH). */
const LSP_PROMPT_PHRASE = "Prefer them over text-based alternatives"

/** Footer status-bar text for degraded LSP: marker present, binary missing. */
const LSP_DEGRADED_FOOTER = "gopls not installed"

/** Footer status-bar text for active LSP: binary on PATH and marker present. */
const LSP_ACTIVE_FOOTER = "typescript-language-server"

/**
 * Waits for the harness to finish processing the main agent turn AND any
 * follow-up completions. Polls request count until stable for settleForMs.
 */
async function waitForTurnToSettle(fixture: KimchiFixture) {
	const settleForMs = 1_200
	const timeoutMs = 30_000
	const startedAt = Date.now()
	let lastCount = fixture.fake.requests.length
	let stableSince = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 100))
		const currentCount = fixture.fake.requests.length
		if (currentCount !== lastCount) {
			lastCount = currentCount
			stableSince = Date.now()
		} else if (Date.now() - stableSince >= settleForMs) {
			return
		}
	}
}

/** Returns true if any recorded provider request body contains the phrase. */
function anyRequestContains(fixture: KimchiFixture, phrase: string): boolean {
	for (const request of fixture.fake.requests) {
		const bodyText = JSON.stringify(request.body ?? "")
		if (bodyText.includes(phrase)) return true
	}
	return false
}

/** Checks the viewable terminal text for a substring. */
function viewTextContains(terminal: { getViewableBuffer: () => string[][] }, phrase: string): boolean {
	const text = terminal
		.getViewableBuffer()
		.map((row) => row.join(""))
		.join("\n")
	return text.includes(phrase)
}

// =============================================================================
// Scenario 1: Go project with go.mod but gopls NOT on PATH → degraded state
// =============================================================================

test("LSP degraded state shows status-bar segment and omits prompt in a Go project without gopls", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-degraded-go",
			responses: [{ stream: ["Done."] }],
			env: { KIMCHI_LSP_BINARIES: "" },
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "go.mod"), "module example.com/test\n\ngo 1.22\n")
			},
		},
		async (fixture, trace) => {
			// Wait for the footer to render the degraded LSP segment.
			trace.step("checking footer for degraded LSP status")
			expect(viewTextContains(terminal, LSP_DEGRADED_FOOTER)).toBe(true)

			// Submit a prompt to trigger before_agent_start (which fires the
			// one-time warning) and settle the turn.
			terminal.submit("hello")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")

			// The LSP system prompt block must NOT appear in any request —
			// no server is active so render() returned undefined.
			expect(anyRequestContains(fixture, LSP_PROMPT_PHRASE)).toBe(false)
		},
	)
})

// =============================================================================
// Scenario 2: No project markers → no LSP segment at all
// =============================================================================

test("LSP segment absent when no project markers are present", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-no-markers",
			responses: [{ stream: ["Done."] }],
			env: { KIMCHI_LSP_BINARIES: "typescript-language-server,gopls" },
		},
		async (fixture, trace) => {
			trace.step("checking footer for absence of LSP segment")
			expect(viewTextContains(terminal, "LSP:")).toBe(false)

			terminal.submit("hello")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")

			// No markers → no server active → prompt block omitted.
			expect(anyRequestContains(fixture, LSP_PROMPT_PHRASE)).toBe(false)
		},
	)
})

// =============================================================================
// Scenario 3: TS project with package.json and typescript-language-server on PATH
//             → active LSP, prompt block present, no degraded warning
// =============================================================================

test("LSP active state shows status-bar segment and includes prompt in a TS project", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-active-ts",
			responses: [{ stream: ["Done."] }],
			env: { KIMCHI_LSP_BINARIES: "typescript-language-server" },
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "package.json"), '{"name":"test","version":"1.0.0"}\n')
			},
		},
		async (fixture, trace) => {
			trace.step("checking footer for active LSP status")
			expect(viewTextContains(terminal, LSP_ACTIVE_FOOTER)).toBe(true)

			terminal.submit("hello")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture)
			trace.step("settled")

			// LSP system prompt MUST appear in requests — server is active.
			expect(anyRequestContains(fixture, LSP_PROMPT_PHRASE)).toBe(true)
		},
	)
})
