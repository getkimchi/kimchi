// ACP integration: LSP lazy mid-session activation on the ACP surface. A
// session that starts in an EMPTY workDir (no markers → session_start
// detects nothing, lsp_* tools hidden) gains them when the model scaffolds a
// TypeScript project mid-session (package.json marker + main.ts source):
//  1. (always) the request AFTER the materializing edit carries the lsp_*
//     tool schemas in its tools array — tool availability rides the request
//     payload, not a prompt rebuild, which is the single-prompt
//     benchmark-visible surface;
//  2. (gated on the real binary) an lsp_diagnostics invocation against the
//     live language server succeeds and its result reaches the model.
// The workspace's typescript is symlinked from the repo's own classic
// install so typescript-language-server initializes without a network
// install. node_modules is not a project marker (and the marker scans skip
// it), so the session still starts LSP-less until the scaffold lands.

import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { typescriptLanguageServerOnPath } from "./support/processes.js"
import { newSession, prompt } from "./support/scenarios.js"

// Repo root, resolved from this file's location (tests/e2e/acp/) — three
// levels up, one fewer than acp-fixture.ts which lives in support/.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

describe("ACP integration — LSP lazy activation", () => {
	let fixture: AcpFixture
	let typescriptLink: string | undefined
	/** Restored in afterEach — the spawn env is copied from process.env. */
	let priorBinaries: string | undefined

	beforeEach(async () => {
		// Make the TS server binary "visible" on every machine: activation
		// (marker + exists()) is what the ungated test below pins. The real
		// spawn only happens on machines that have the binary (gated test).
		priorBinaries = process.env.KIMCHI_LSP_BINARIES
		process.env.KIMCHI_LSP_BINARIES = "typescript-language-server"
		fixture = await startAcpFixture({
			artifactName: "lsp-lazy-activation",
			responses: [
				// Turn 1 — the scaffold: marker write first, source second. The
				// main.ts write is the materializing edit (file-anchored
				// detection runs on server-supported extensions only). Distinct
				// tool-call ids/indices — the fake server defaults every id to
				// "call_fake", and same-id calls get merged into one.
				{
					stream: ["Scaffolding the TypeScript project."],
					toolCalls: [
						{
							id: "call_scaffold_marker",
							index: 0,
							function: {
								name: "write",
								arguments: JSON.stringify({
									path: "package.json",
									content: '{"name":"scaffolded","version":"1.0.0"}\n',
								}),
							},
						},
						{
							id: "call_scaffold_source",
							index: 1,
							function: {
								name: "write",
								arguments: JSON.stringify({
									path: "main.ts",
									content: 'const answer: number = "not a number"\n',
								}),
							},
						},
					],
				},
				{ stream: ["Scaffolded."] },
				// Turn 2 — the invocation against the (now activated) server.
				{
					stream: ["Checking main.ts with the language server."],
					toolCalls: [
						{
							id: "call_lsp_diag",
							index: 0,
							function: {
								name: "lsp_diagnostics",
								arguments: JSON.stringify({ file_path: "main.ts", wait_ms: 8000 }),
							},
						},
					],
				},
				{ stream: ["There is one type error in main.ts."] },
			],
			pretrustWorkDir: true,
		})
		const modules = join(fixture.workDir, "node_modules")
		mkdirSync(modules, { recursive: true })
		typescriptLink = join(modules, "typescript")
		symlinkSync(resolve(REPO_ROOT, "node_modules/typescript"), typescriptLink, "dir")
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		if (priorBinaries === undefined) {
			delete process.env.KIMCHI_LSP_BINARIES
		} else {
			process.env.KIMCHI_LSP_BINARIES = priorBinaries
		}
		if (typescriptLink !== undefined) {
			// Unlink only — never follow into the repo's own install.
			rmSync(typescriptLink, { force: true })
		}
		// beforeEach can bail before fixture assignment (fixture start failure);
		// don't mask the real error with a teardown crash.
		await fixture?.stop()
	})

	function requestToolNames(request: { body?: unknown }): string[] {
		const tools = (request.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
		return (tools ?? []).map((t) => t?.function?.name ?? "")
	}

	/** Requests carrying an advertised tools array (the chat requests). */
	function chatRequests(): Array<{ body?: unknown }> {
		return fixture.fake.requests.filter((r) => {
			const tools = (r.body as { tools?: unknown[] } | undefined)?.tools
			return Array.isArray(tools) && tools.length > 0
		})
	}

	/** The tool-result message for a specific tool-call id, from a request
	 *  body's message list (the tool result reaches the model in the next
	 *  request — matching the id pins the assertion to THIS invocation, not
	 *  to the write-sync handler's automatic diagnostics steer). */
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

	it("advertises the lsp_* tools on every request after the materializing edit", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "scaffold a TypeScript project")).stopReason).toBe("end_turn")

		const chat = chatRequests()
		expect(chat.length).toBeGreaterThanOrEqual(2)
		// The pre-scaffold request advertised no lsp_* tools…
		expect(requestToolNames(chat[0])).not.toContain("lsp_diagnostics")
		// …and every request after the materializing edit does — including the
		// mid-turn continuation, the single-prompt benchmark semantics (no
		// prompt rebuild required).
		for (const request of chat.slice(1)) {
			expect(requestToolNames(request)).toContain("lsp_diagnostics")
			expect(requestToolNames(request)).toContain("lsp_hover")
		}
	})

	it.runIf(typescriptLanguageServerOnPath)(
		"lsp_diagnostics succeeds against the live server after lazy activation",
		async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "scaffold a TypeScript project")).stopReason).toBe("end_turn")
			expect((await prompt(fixture, sessionId, "check main.ts for type errors")).stopReason).toBe("end_turn")

			// The scaffold and the invocation both really ran…
			expect(readFileSync(join(fixture.workDir, "main.ts"), "utf-8")).toContain("not a number")
			// …and THIS invocation's tool result (matched by tool-call id, not
			// just any request body — the write-sync handler's automatic
			// diagnostics could satisfy that) returned the real tsserver
			// diagnostic for the deliberate type error in main.ts.
			const diagResult = fixture.fake.requests
				.map((r) => findToolResult(r.body, "call_lsp_diag"))
				.find((message) => message !== undefined)
			expect(diagResult).toBeDefined()
			expect(JSON.stringify(diagResult)).toContain("Type 'string' is not assignable")
		},
	)
})
