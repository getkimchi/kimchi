// TUI workflow: LSP vs python-edit AST-nudge precedence, branch A plus the
// resource-disabled regression.
//
//  - Branch A: a session seeded with the pyright marker (and the binary made
//    "installed" via KIMCHI_LSP_BINARIES) serves Python at session start —
//    the lsp-tools prompt block covers validation guidance from turn 0, the
//    gate suppresses python-edit, and no AST nudge text or activation steer
//    ever reaches the model.
//  - Disabled-resource regression: the same setup with
//    {"resources":{"extensions.lsp":false}} in the harness settings — no LSP
//    extension, tools, or prompt block exist, so markers and the binary are
//    irrelevant: the gate treats it as "no LSP" and the AST nudge steers.

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Phrase from LSP_SYSTEM_PROMPT that appears in provider requests when the
 *  lsp-tools prompt block is active (i.e. at least one server activated). */
const LSP_PROMPT_PHRASE = "Prefer them over text-based alternatives"

/** The python-edit body — identifies the AST nudge (never ast.parse alone:
 *  the activation steer mentions ast.parse too). */
const AST_NUDGE_PHRASE = "When editing or creating Python"
const ACTIVATION_STEER_PHRASE = "Language server pyright is now active"

const PYPROJECT_TOML = '[project]\nname = "precedence"\nversion = "0.1.0"\n'

/** The scripted model: two .py writes in one turn (distinct tool-call
 *  ids/indices — the fake server defaults every id to "call_fake", and
 *  same-id calls get merged). */
const WRITE_PY_RESPONSES = [
	{
		stream: ["Writing Python files."],
		toolCalls: [
			{
				id: "call_write_main",
				index: 0,
				function: {
					name: "write",
					arguments: JSON.stringify({ path: "main.py", content: "answer: int = 42\n" }),
				},
			},
			{
				id: "call_write_utils",
				index: 1,
				function: {
					name: "write",
					arguments: JSON.stringify({ path: "utils.py", content: "def helper() -> int:\n    return 1\n" }),
				},
			},
		],
	},
	{ stream: ["Wrote two files."] },
]

type RecordedRequest = { body?: unknown }

function bodyText(request: RecordedRequest | undefined): string {
	return JSON.stringify(request?.body ?? "")
}

function toolNamesOf(request: RecordedRequest | undefined): string[] {
	const tools = (request?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
	return (tools ?? []).map((t) => t?.function?.name ?? "")
}

/** Seed the pyright project marker into the session workDir. */
function seedMarker(workDir: string): void {
	writeFileSync(join(workDir, "pyproject.toml"), PYPROJECT_TOML)
}

/** Merge a resource disable into the fixture's harness settings.json — the
 *  same file isResourceEnabled() reads (isolated HOME, so no real user
 *  settings are touched). */
function disableLspResource(homeDir: string): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.resources = { ...((settings.resources as Record<string, unknown>) ?? {}), "extensions.lsp": false }
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"))
}

test("pyright serving Python at session start suppresses the AST nudge entirely", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-ast-nudge-precedence-a",
			responses: WRITE_PY_RESPONSES,
			env: { KIMCHI_LSP_BINARIES: "pyright-langserver" },
			seedHome: (_homeDir, workDir) => {
				seedMarker(workDir)
			},
		},
		async (fixture, trace) => {
			terminal.submit("create python files")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			// User-visible state: the turn completes on screen and the status
			// footer carries the session-start pyright winner (no activation
			// banner — it was never lazily activated).
			await waitForText(terminal, "Wrote two files.")
			await waitForText(terminal, "LSP: pyright", { full: false })
			trace.step("completion text and LSP footer visible")

			// (a) No AST nudge text reaches any request — the gate kept
			// python-edit unloaded (no load, no steer).
			for (const request of fixture.fake.requests) {
				expect(bodyText(request)).not.toContain(AST_NUDGE_PHRASE)
				expect(bodyText(request)).not.toContain("ast.parse")
			}

			// (b) The lsp-tools prompt block is active from turn 0, and the
			// lsp_* tools are advertised alongside it.
			const firstChat = fixture.fake.requests.find((r) => bodyText(r).includes("create python files"))
			expect(firstChat).toBeDefined()
			expect(bodyText(firstChat)).toContain(LSP_PROMPT_PHRASE)
			for (const name of ["lsp_diagnostics", "lsp_hover"]) {
				expect(toolNamesOf(firstChat)).toContain(name)
			}

			// (c) No activation steer — a server was active at session start,
			// so maybeActivateForPath never ran.
			for (const request of fixture.fake.requests) {
				expect(bodyText(request)).not.toContain(ACTIVATION_STEER_PHRASE)
			}
		},
	)
})

test("disabled-resource regression: the AST nudge returns when the LSP extension is off", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-ast-nudge-precedence-disabled",
			responses: WRITE_PY_RESPONSES,
			env: { KIMCHI_LSP_BINARIES: "pyright-langserver" },
			seedHome: (homeDir, workDir) => {
				// Marker + binary are both present, but the LSP resource is
				// disabled — the gate must treat that as "no LSP" or Python
				// validation guidance silently disappears.
				seedMarker(workDir)
				disableLspResource(homeDir)
			},
		},
		async (fixture, trace) => {
			terminal.submit("create python files")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			// User-visible state: the turn completes on screen, and no LSP footer
			// ever appears — the extension itself never loaded.
			await waitForText(terminal, "Wrote two files.")
			expect(fullText(terminal)).not.toContain("LSP:")
			trace.step("completion text visible, no LSP footer")

			// The AST nudge text DOES reach the model — python-edit loads and
			// steers exactly as in an LSP-less session.
			const nudgeRequests = fixture.fake.requests.filter((r) => bodyText(r).includes(AST_NUDGE_PHRASE))
			expect(nudgeRequests.length).toBeGreaterThan(0)

			// And no lsp_* tools are advertised anywhere (the extension never
			// loaded), nor any LSP prompt guidance.
			for (const request of fixture.fake.requests) {
				expect(toolNamesOf(request)).not.toContain("lsp_diagnostics")
				expect(bodyText(request)).not.toContain(LSP_PROMPT_PHRASE)
			}
		},
	)
})
