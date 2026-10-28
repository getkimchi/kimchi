// ACP integration: LSP vs python-edit AST-nudge precedence, per the
// two-branch design.
//
//  - Branch A (pyright serves Python at session start): the AST nudge is
//    suppressed entirely — lsp_* tools advertised from request 0, no
//    "When editing or creating Python" body steered, no activation steer.
//  - Branch B (lazy activation mid-session): a one-time activation steer
//    announces the server and supersedes any already-steered AST guidance.
//    Both orderings are covered: activation before the first .py write
//    (the read-activation geometry) and AST nudge before activation
//    (scratch write in a marker-less dir, then project materialization).
//  - TS-winner fallback: a typescript-language-server session still steers
//    the AST nudge for .py files (the conflict is pyright-specific), and the
//    scripted lsp_diagnostics call surfaces the ordinary-result refusal
//    ("No LSP server available for this file type.") that the guidance's
//    fallback clause keys on. No server is ever spawned — deterministic on
//    any machine.
//
// pyright/typescript-language-server are made "installed" via
// KIMCHI_LSP_BINARIES; no lsp_* invocation here depends on a live server.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const PYPROJECT_TOML = '[project]\nname = "precedence"\nversion = "0.1.0"\n'

/** The python-edit body — identifies the AST nudge (never ast.parse alone:
 *  the activation steer mentions ast.parse too). */
const AST_NUDGE_PHRASE = "When editing or creating Python"
const ACTIVATION_STEER_PHRASE = "Language server pyright is now active"

describe("ACP integration — LSP vs AST-nudge precedence", () => {
	let fixture: AcpFixture
	/** Restored in afterEach — the spawn env is copied from process.env. */
	let priorBinaries: string | undefined

	afterEach(async () => {
		if (priorBinaries === undefined) {
			delete process.env.KIMCHI_LSP_BINARIES
		} else {
			process.env.KIMCHI_LSP_BINARIES = priorBinaries
		}
		// beforeEach can bail before fixture assignment (fixture start failure);
		// don't mask the real error with a teardown crash.
		await fixture?.stop()
	})

	function requestToolNames(request: { body?: unknown }): string[] {
		const tools = (request.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
		return (tools ?? []).map((t) => t?.function?.name ?? "")
	}

	function bodyText(request: { body?: unknown }): string {
		return JSON.stringify(request.body ?? "")
	}

	/** First recorded request whose body contains `fragment` (-1 when absent). */
	function firstRequestIndexContaining(fragment: string): number {
		return fixture.fake.requests.findIndex((r) => bodyText(r).includes(fragment))
	}

	/** The tool-result message for a specific tool-call id, from a request
	 *  body's message list (the tool result reaches the model in the next
	 *  request — matching the id pins the assertion to THIS invocation). */
	function findToolResult(body: unknown, toolCallId: string): Record<string, unknown> | undefined {
		if (!body || typeof body !== "object") return undefined
		const messages = (body as Record<string, unknown>).messages
		if (!Array.isArray(messages)) return undefined
		return messages.find((message): message is Record<string, unknown> => {
			return Boolean(
				message &&
					typeof message === "object" &&
					(message as Record<string, unknown>).role === "tool" &&
					(message as Record<string, unknown>).tool_call_id === toolCallId,
			)
		})
	}

	describe("branch A — pyright serves Python at session start", () => {
		beforeEach(async () => {
			priorBinaries = process.env.KIMCHI_LSP_BINARIES
			process.env.KIMCHI_LSP_BINARIES = "pyright-langserver"
			fixture = await startAcpFixture({
				artifactName: "lsp-ast-nudge-precedence-a",
				responses: [
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
									arguments: JSON.stringify({
										path: "utils.py",
										content: "def helper() -> int:\n    return 1\n",
									}),
								},
							},
						],
					},
					{ stream: ["Wrote two files."] },
				],
				pretrustWorkDir: true,
			})
			// The marker exists before the session starts: session-start
			// detection makes pyright the winner, so the lsp-tools prompt block
			// covers guidance from request 0 and the gate suppresses python-edit.
			writeFileSync(join(fixture.workDir, "pyproject.toml"), PYPROJECT_TOML)
		}, STARTUP_TIMEOUT_MS)

		it("suppresses the AST nudge entirely — no body, no activation steer, lsp_* from request 0", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "create python files")).stopReason).toBe("end_turn")

			// lsp_* tools advertised from request 0 (the prompt request itself).
			const chatRequests = fixture.fake.requests.filter((r) => {
				const tools = (r.body as { tools?: unknown[] } | undefined)?.tools
				return Array.isArray(tools) && tools.length > 0
			})
			expect(chatRequests.length).toBeGreaterThan(0)
			for (const name of ["lsp_diagnostics", "lsp_hover", "lsp_rename"]) {
				expect(requestToolNames(chatRequests[0])).toContain(name)
			}

			// No AST nudge text and no activation steer in ANY request: the
			// gate kept the behaviour unloaded (branch A) and maybeActivateForPath
			// never ran (a server was active from session start).
			for (const request of fixture.fake.requests) {
				expect(bodyText(request)).not.toContain(AST_NUDGE_PHRASE)
				expect(bodyText(request)).not.toContain("ast.parse")
				expect(bodyText(request)).not.toContain(ACTIVATION_STEER_PHRASE)
			}
		})
	})

	describe("branch B — lazy pyright activation, activation before the first .py write", () => {
		beforeEach(async () => {
			priorBinaries = process.env.KIMCHI_LSP_BINARIES
			process.env.KIMCHI_LSP_BINARIES = "pyright-langserver"
			fixture = await startAcpFixture({
				artifactName: "lsp-ast-nudge-precedence-b1",
				responses: [
					// Turn 1, step 1 — the marker write. On its own response step so
					// the file is on disk before the read runs: pi-mono executes a
					// tool-call batch concurrently, so a read sharing the batch with
					// the marker write races the write and reliably loses it.
					{
						stream: ["Setting up the project."],
						toolCalls: [
							{
								id: "call_marker",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "pyproject.toml", content: PYPROJECT_TOML }),
								},
							},
						],
					},
					// Turn 1, step 2 — the read of the pre-seeded main.py: detection
					// activates pyright without loading python-edit (reads never match
					// the edit/write matcher).
					{
						stream: ["Now reading the entry point."],
						toolCalls: [
							{
								id: "call_read_main",
								index: 0,
								function: {
									name: "read",
									arguments: JSON.stringify({ path: "main.py" }),
								},
							},
						],
					},
					{ stream: ["The project is set up."] },
					// Turn 2 — the first .py write: python-edit loads now (the
					// session-start snapshot had no LSP, so the gate passed).
					{
						stream: ["Bumping the answer."],
						toolCalls: [
							{
								id: "call_write_main",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "main.py", content: "answer: int = 43\n" }),
								},
							},
						],
					},
					{ stream: ["Edited."] },
				],
				pretrustWorkDir: true,
			})
		}, STARTUP_TIMEOUT_MS)

		it("steers the activation notice with the supersession clause before any AST body", async () => {
			// The session starts in an EMPTY workDir (no markers → no LSP at
			// session start), then main.py is seeded through the fixture
			// filesystem AFTER session_start — the sam-cell-seg geometry.
			const sessionId = await newSession(fixture, fixture.workDir)
			writeFileSync(join(fixture.workDir, "main.py"), "answer: int = 42\n")

			expect((await prompt(fixture, sessionId, "set up the project")).stopReason).toBe("end_turn")
			expect((await prompt(fixture, sessionId, "bump the answer")).stopReason).toBe("end_turn")

			// The read's tool result reaches the model on the first continuation
			// request — and the lsp_* schemas join that same request (the visibility
			// vote is removed synchronously during the read's tool_result, and the
			// tools array is assembled at request build time).
			const readResultIndex = fixture.fake.requests.findIndex(
				(r) => findToolResult(r.body, "call_read_main") !== undefined,
			)
			expect(readResultIndex).toBeGreaterThanOrEqual(0)
			const readResultRequest = fixture.fake.requests[readResultIndex]
			for (const name of ["lsp_diagnostics", "lsp_hover"]) {
				expect(requestToolNames(readResultRequest)).toContain(name)
			}
			// No AST behaviour body yet — the read cannot load python-edit.
			expect(bodyText(readResultRequest)).not.toContain(AST_NUDGE_PHRASE)

			// The activation steer rides the first continuation request that
			// carries the read's tool result — same turn, no prompt rebuild — with
			// the supersession + content-keyed fallback clauses. (The steer and
			// the read are on separate response steps: pi-mono runs a tool-call
			// batch concurrently, so a read sharing the marker write's batch would
			// race the write and lose it.)
			const activationIndex = firstRequestIndexContaining(ACTIVATION_STEER_PHRASE)
			expect(activationIndex).toBe(readResultIndex)
			expect(bodyText(fixture.fake.requests[activationIndex])).toContain(
				"supersedes the earlier ast.parse post-edit validation",
			)

			// The conditional python-edit body reaches a LATER request than the
			// activation notice (identified by its heading, not ast.parse — the
			// activation notice mentions ast.parse too).
			const nudgeIndex = firstRequestIndexContaining(AST_NUDGE_PHRASE)
			expect(nudgeIndex).toBeGreaterThan(activationIndex)
		})
	})

	describe("branch B — lazy pyright activation, AST nudge before activation", () => {
		beforeEach(async () => {
			priorBinaries = process.env.KIMCHI_LSP_BINARIES
			process.env.KIMCHI_LSP_BINARIES = "pyright-langserver"
			fixture = await startAcpFixture({
				artifactName: "lsp-ast-nudge-precedence-b2",
				responses: [
					// Turn 1, step 1 — a scratch .py write with no markers: no
					// activation, and the AST nudge steers (the gate passed at
					// session start: no LSP then).
					{
						stream: ["Writing a scratch file."],
						toolCalls: [
							{
								id: "call_scratch",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "scratch.py", content: "x = 1\n" }),
								},
							},
						],
					},
					// Turn 1, step 2 — materialize the project (the marker write on
					// its own response step: pi-mono executes a tool-call batch
					// concurrently, so a .py touch sharing the batch with the marker
					// write races it and can lose).
					{
						stream: ["Materializing the project."],
						toolCalls: [
							{
								id: "call_marker",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "pyproject.toml", content: PYPROJECT_TOML }),
								},
							},
						],
					},
					// Turn 1, step 3 — edit the .py again: detection fires on that
					// tool result and the activation steer supersedes the earlier
					// AST body.
					{
						stream: ["Updating the scratch file."],
						toolCalls: [
							{
								id: "call_edit_py",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "scratch.py", content: "x = 2\n" }),
								},
							},
						],
					},
					{ stream: ["Done."] },
				],
				pretrustWorkDir: true,
			})
		}, STARTUP_TIMEOUT_MS)

		it("steers the AST nudge first, then the activation notice in a later request", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "work on python here")).stopReason).toBe("end_turn")

			// The AST nudge rides the request carrying the scratch write's
			// tool result…
			const scratchResultIndex = fixture.fake.requests.findIndex(
				(r) => findToolResult(r.body, "call_scratch") !== undefined,
			)
			expect(scratchResultIndex).toBeGreaterThanOrEqual(0)
			const nudgeIndex = firstRequestIndexContaining(AST_NUDGE_PHRASE)
			expect(nudgeIndex).toBe(scratchResultIndex)

			// …and the activation steer appears in a strictly LATER request,
			// carrying the supersession clause.
			const activationIndex = firstRequestIndexContaining(ACTIVATION_STEER_PHRASE)
			expect(activationIndex).toBeGreaterThan(nudgeIndex)
			expect(bodyText(fixture.fake.requests[activationIndex])).toContain("supersedes the earlier ast.parse")
		})
	})

	describe("TS-winner sessions — AST nudge survives, lsp_diagnostics refusal surfaces", () => {
		beforeEach(async () => {
			priorBinaries = process.env.KIMCHI_LSP_BINARIES
			process.env.KIMCHI_LSP_BINARIES = "typescript-language-server"
			fixture = await startAcpFixture({
				artifactName: "lsp-ast-nudge-precedence-ts",
				responses: [
					// Turn 1 — write a .py. The TS winner's extensions don't
					// include py, so the gate passes and the AST nudge steers.
					{
						stream: ["Writing a Python file."],
						toolCalls: [
							{
								id: "call_write_py",
								index: 0,
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "main.py", content: "answer: int = 42\n" }),
								},
							},
						],
					},
					// Turn 1, step 2 — try lsp_diagnostics on the .py: the
					// ordinary-result refusal the fallback clause keys on.
					{
						stream: ["Checking with the language server."],
						toolCalls: [
							{
								id: "call_lsp_diag",
								index: 0,
								function: {
									name: "lsp_diagnostics",
									arguments: JSON.stringify({ file_path: "main.py" }),
								},
							},
						],
					},
					// Turn 1, step 3 — the scripted fallback: the ast.parse syntax
					// check, with a success sentinel so the assertion below can tell
					// a real pass from a missing interpreter / unreadable file.
					// syntax check.
					{
						stream: ["Falling back to the syntax check."],
						toolCalls: [
							{
								id: "call_ast_check",
								index: 0,
								function: {
									name: "bash",
									arguments: JSON.stringify({
										command:
											'python3 -c "import ast, sys; ast.parse(open(sys.argv[1]).read())" main.py && echo AST_PARSE_OK',
									}),
								},
							},
						],
					},
					{ stream: ["The file parses."] },
				],
				pretrustWorkDir: true,
			})
			// The TS marker makes typescript-language-server the session-start
			// winner — no server for .py files in this session.
			writeFileSync(join(fixture.workDir, "package.json"), '{"name":"precedence","version":"1.0.0"}\n')
		}, STARTUP_TIMEOUT_MS)

		it("steers the AST nudge, surfaces the soft refusal, and delivers the fallback tool flow", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "create a python file and validate it")).stopReason).toBe("end_turn")

			// The gate passed (the TS winner doesn't serve py) — the AST nudge
			// reached the model after the write.
			const nudgeIndex = firstRequestIndexContaining(AST_NUDGE_PHRASE)
			expect(nudgeIndex).toBeGreaterThanOrEqual(0)

			// lsp_diagnostics answered with the ordinary-result refusal — no
			// server spawn, deterministic — and that result reached the model.
			const diagResult = fixture.fake.requests
				.map((r) => findToolResult(r.body, "call_lsp_diag"))
				.find((message) => message !== undefined)
			expect(diagResult).toBeDefined()
			expect(JSON.stringify(diagResult)).toContain("No LSP server available for this file type.")

			// The scripted ast.parse fallback ran and its result reached the
			// following request. The success sentinel only prints when python3
			// actually parsed the file — a missing interpreter, a permission
			// failure, or a FileNotFoundError fails the test instead of passing
			// vacuously (delivery + execution of the fallback flow; whether a real
			// model chooses it is the benchmark's question).
			const astResult = fixture.fake.requests
				.map((r) => findToolResult(r.body, "call_ast_check"))
				.find((message) => message !== undefined)
			expect(astResult).toBeDefined()
			expect(JSON.stringify(astResult)).toContain("AST_PARSE_OK")
			expect(JSON.stringify(astResult)).not.toContain("SyntaxError")
		})
	})
})
