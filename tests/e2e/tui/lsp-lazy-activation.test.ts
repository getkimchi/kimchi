// TUI workflow: a session started in an EMPTY directory is LSP-less at
// session start (no markers → the lsp_* tools are hidden), but when the
// agent scaffolds a Python project mid-session — pyproject.toml marker,
// then a source file — the language server activates lazily:
//   - the status footer flips to the activated server,
//   - the lsp_* tools join the advertised tools array of the request built
//     after the materializing edit (request-level availability — what
//     single-prompt benchmark runs see; no prompt rebuild required),
//   - the lsp-tools guidance block renders on the next prompt rebuild
//     (the multi-prompt surface benchmarks cannot show).
// pyright is made "installed" via KIMCHI_LSP_BINARIES so activation is
// deterministic on any machine; no lsp_* tool is invoked here — the ACP
// lazy-activation e2e covers the real invocation against a live server.

import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Phrase from LSP_SYSTEM_PROMPT that appears in provider requests when the
 *  lsp-tools prompt block is active (i.e. at least one server activated). */
const LSP_PROMPT_PHRASE = "Prefer them over text-based alternatives"

/** Phrase from the one-time activation steer sent by maybeActivateForPath
 *  when a language server activates mid-session. */
const ACTIVATION_STEER_PHRASE = "Language server pyright is now active"

const FIRST_PROMPT = "set up a python project here"
const SECOND_PROMPT = "is the language server active now"

type RecordedRequest = { body?: unknown }

function bodyText(request: RecordedRequest | undefined): string {
	return JSON.stringify(request?.body ?? "")
}

function toolNamesOf(request: RecordedRequest | undefined): string[] {
	const tools = (request?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
	return (tools ?? []).map((t) => t?.function?.name ?? "")
}

test("LSP activates mid-session when the agent scaffolds a Python project in an empty dir", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-lazy-activation",
			responses: [
				{
					stream: ["Scaffolding the Python project."],
					toolCalls: [
						// Distinct tool-call ids/indices — the fake server defaults
						// every id to "call_fake", and same-id calls get merged.
						{
							id: "call_scaffold_marker",
							index: 0,
							function: {
								name: "write",
								arguments: JSON.stringify({
									path: "pyproject.toml",
									content: '[project]\nname = "scaffolded"\nversion = "0.1.0"\n',
								}),
							},
						},
						{
							id: "call_scaffold_source",
							index: 1,
							function: {
								name: "write",
								arguments: JSON.stringify({
									path: "main.py",
									content: "answer: int = 42\n",
								}),
							},
						},
					],
				},
				{ stream: ["Project scaffolded."] },
				{ stream: ["The language server is active."] },
			],
			env: { KIMCHI_LSP_BINARIES: "pyright-langserver" },
		},
		async (fixture, trace) => {
			// Turn 1: the agent scaffolds the project. The marker write
			// (pyproject.toml — no server-supported extension) cannot activate
			// by construction; the main.py write is the materializing edit.
			terminal.submit(FIRST_PROMPT)
			trace.step("submitted scaffold prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			// User-visible state: the status footer now reflects the language
			// server (poll — footer statuses are applied asynchronously).
			await waitForText(terminal, "LSP: pyright", { full: false })
			trace.step("status footer shows the activated server")

			// The activation steer was delivered during the materializing edit's
			// tool_result, so it already reached the model on the first request
			// after that edit — the in-turn continuation inside the same turn,
			// before any second prompt or prompt rebuild. (The steer also
			// carries the Python supersession + fallback clauses.)
			const activationRequests = fixture.fake.requests.filter((r) => bodyText(r).includes(ACTIVATION_STEER_PHRASE))
			expect(activationRequests.length).toBeGreaterThan(0)
			expect(bodyText(activationRequests[0])).toContain("supersedes the earlier ast.parse post-edit validation")
			trace.step("activation steer reached the in-turn continuation request")

			// The request built before any materializing edit advertised no
			// lsp_* tools and no LSP guidance.
			const firstChat = fixture.fake.requests.find((r) => bodyText(r).includes(FIRST_PROMPT))
			expect(firstChat).toBeDefined()
			expect(toolNamesOf(firstChat)).not.toContain("lsp_diagnostics")
			expect(bodyText(firstChat)).not.toContain(LSP_PROMPT_PHRASE)

			// Turn 2: a subsequent prompt — the multi-prompt surface.
			terminal.submit(SECOND_PROMPT)
			trace.step("submitted second prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			// The turn-2 request advertises the lsp_* tools (request-level
			// availability) and carries the lsp-tools guidance block that
			// rendered at the prompt rebuild.
			const secondChats = fixture.fake.requests.filter((r) => bodyText(r).includes(SECOND_PROMPT))
			expect(secondChats.length).toBeGreaterThan(0)
			for (const request of secondChats) {
				const names = toolNamesOf(request)
				expect(names).toContain("lsp_diagnostics")
				expect(names).toContain("lsp_hover")
				expect(bodyText(request)).toContain(LSP_PROMPT_PHRASE)
			}
		},
	)
})
