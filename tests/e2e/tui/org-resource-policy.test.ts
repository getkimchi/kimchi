/**
 * Org-managed resources (the platform's kimchi_resources policy): resources
 * locked by the organization show as locked in the /resources UI and cannot
 * be toggled there, and a FORCE_OFF'd tool is actually unavailable to the
 * model.
 *
 * Seeding: the fixture writes apiKey "fake" into the isolated home's
 * ~/.config/kimchi/config.json, and initOrgPolicy keys its cache by the
 * sha256 of that key. Under fetch-first delivery the startup fetch 404s
 * against the fake server (a fast, local no-access), and the session falls
 * back to this key's cached policy — so writing org-policy.json with the
 * matching fingerprint deterministically puts the session under the seeded
 * policy.
 *
 * Enforcement note: tool resources are restart-gated — FORCE_OFF filters the
 * extension factory out at session load, so the tool is never registered and
 * the model's tool list lacks it (the runtime tool-blocker is the backstop
 * for sessions started before a policy change). The e2e asserts both the
 * visible refusal when the model insists on calling it and its absence from
 * the recorded tool list.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const FIXTURE_API_KEY = "fake"

function webSearchToolCall() {
	return { function: { name: "web_search", arguments: JSON.stringify({ query: "kimchi" }) } }
}

test("org-locked resources show as locked in /resources and a FORCE_OFF tool is blocked", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-resource-policy",
			responses: [
				{ stream: ["Searching."], toolCalls: [webSearchToolCall()] },
				{ stream: ["Handled the blocked search."] },
			],
			seedHome(homeDir) {
				const fingerprint = createHash("sha256").update(FIXTURE_API_KEY).digest("hex")
				writeFileSync(
					join(homeDir, ".config", "kimchi", "org-policy.json"),
					`${JSON.stringify({
						keyFingerprint: fingerprint,
						orgId: "org-e2e",
						fetchedAt: Date.now(),
						policy: {
							resources: {
								"tools.web_search": "FORCE_OFF",
								"extensions.workflows": "FORCE_ON",
							},
						},
					})}\n`,
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("/resources")
			await waitForText(terminal, "Kimchi resources", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("resources overlay open")

			// The summary counts BOTH FORCE_* rows as org-locked, and locked rows
			// carry the lock marker. (A FORCE_ON row counting here proves locks
			// are not only rendered for disabled resources.)
			expect(viewText(terminal)).toContain("2 org-locked")
			expect(viewText(terminal)).toContain("org-locked)")
			trace.step("locked rows visible")

			// Selection starts on the first row; step down to tools.web_search
			// (skills.pptx, skills.pdf, hooks.bash, then tools.web_search) and
			// read its org-policy note.
			terminal.keyDown()
			terminal.keyDown()
			terminal.keyDown()
			await waitForText(terminal, "locked off", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("locked-off row selected, policy note visible")

			// The toggle is inert: Enter/Space does not change the locked row's
			// state — the policy note stays on screen and no override is written
			// (proven by the unavailable-tool assertions below, which need
			// FORCE_OFF intact).
			terminal.submit("")
			expect(viewText(terminal)).toContain("locked off")
			trace.step("toggle on the locked row is a no-op")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false, timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("overlay closed")

			// The org's FORCE_OFF is not just UI: the tool is not registered in
			// this session, so the model's scripted search attempt is refused and
			// the session continues on the error result.
			terminal.submit("Search the web for kimchi")
			await waitForText(terminal, "Tool web_search not found", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("web_search unavailable under org policy")
			await waitForText(terminal, "Handled the blocked search.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session continued after the refusal")

			// Wire-level proof: the model's tool list never contained web_search.
			const chatRequests = fixture.fake.requests.filter((request) =>
				request.url.includes("/openai/v1/chat/completions"),
			)
			expect(chatRequests.length).toBeGreaterThan(0)
			for (const request of chatRequests) {
				const tools = (request.body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
				expect(tools.some((tool) => tool.function?.name === "web_search")).toBe(false)
			}
			trace.step("web_search absent from the model tool list")
		},
	)
})
