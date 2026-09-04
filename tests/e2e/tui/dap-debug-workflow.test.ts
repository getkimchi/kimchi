// DAP debugger TUI workflow coverage.
//
// Test A (deterministic everywhere): degraded path — the model calls
// debug_launch in a project whose marker requires an adapter that is NOT
// installed. Asserts the user-visible surfaces: the degraded status footer,
// the DAP tool render line, and the actionable tool error ("not installed or
// not on PATH") that debug_launch returns since the Chunk 3 pre-check.
//
// Test B (skip-when-absent): happy path with a REAL js-debug dapDebugServer.js
// — one debug_state_at call performs the whole launch → breakpoint → continue
// → locals → terminate workflow, and the captured state must render in the
// terminal. Skipped when the script is not resolvable (same candidates the
// resolution in src/extensions/dap/adapters.ts uses: JS_DEBUG_PATH env,
// cwd-relative node_modules, npm global prefix).

import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** True when any recorded provider request body contains the phrase — used to
 *  assert the tool result actually made it back to the model (the TUI
 *  collapses long tool output, so request bodies are the reliable surface). */
function anyRequestContains(fixture: { fake: { requests: { body: unknown }[] } }, phrase: string): boolean {
	for (const request of fixture.fake.requests) {
		if (JSON.stringify(request.body ?? "").includes(phrase)) return true
	}
	return false
}

// =============================================================================
// Test A: degraded path — adapter missing
// =============================================================================

test("DAP degraded state: debug_launch surfaces the missing-adapter error and status footer", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "dap-degraded",
			responses: [
				// The model tries to launch a debugging session for app.js — which
				// resolves to js-debug by extension, but the adapter script is not
				// installed anywhere resolvable, so launchSession's availability
				// pre-check must fail with the actionable error.
				{
					toolCalls: [
						{
							function: {
								name: "debug_launch",
								arguments: JSON.stringify({ program: "app.js" }),
							},
						},
					],
				},
				{ stream: ["The debug adapter is missing, so I cannot debug."] },
			],
			// No adapter binaries — dlv/debugpy/lldb-dap can exist on a dev
			// machine but must not change this scenario.
			env: { KIMCHI_DAP_BINARIES: "" },
			seedHome: (_homeDir, workDir) => {
				// package.json marks the project as TS/JS → js-debug is the missing
				// adapter shown in the status footer.
				writeFileSync(join(workDir, "package.json"), '{"name":"debugme","version":"1.0.0"}\n')
				writeFileSync(join(workDir, "app.js"), 'console.log("hi")\n')
			},
		},
		async (fixture, trace) => {
			// The DAP status footer shows the missing adapter as soon as
			// session_start detection ran. Poll instead of snapshotting —
			// the footer status is applied asynchronously.
			trace.step("checking status footer for degraded DAP segment")
			await waitForText(terminal, "DAP: js-debug not installed", { full: false })

			terminal.submit("debug app.js for me")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			const view = viewText(terminal)
			// The DAP tool rendered with its user-visible (name-derived) header.
			expect(view).toContain("Debug Launch")
			// The one-time degraded warning notification names the missing adapter
			// and its install path.
			expect(view).toContain("DAP unavailable: debug adapter(s) not installed")
			// The availability pre-check error made it back to the model as the
			// tool result — without this, launch would have tried to spawn a
			// missing binary (Chunk 3 regression).
			expect(anyRequestContains(fixture, "not installed or not on PATH")).toBe(true)
			// The scripted assistant completion rendered.
			expect(view).toContain("cannot debug")
		},
	)
})

// =============================================================================
// Test B: happy path with real js-debug (skip when unresolvable)
// =============================================================================

/** Mirrors the resolution candidates in adapters.ts (kept inline so the TUI
 *  e2e infra stays free of src imports). Returns true when a
 *  dapDebugServer.js script is resolvable. */
function jsDebugScriptResolvable(): boolean {
	if (process.env.JS_DEBUG_PATH && existsSync(process.env.JS_DEBUG_PATH)) return true
	for (const c of [
		"node_modules/js-debug-adapter/src/dapDebugServer.js",
		"node_modules/@vscode/js-debug/src/dapDebugServer.js",
	]) {
		if (existsSync(c)) return c.length > 0
	}
	try {
		const prefix = spawnSync("npm", ["prefix", "-g"], { encoding: "utf-8" })
		if (
			prefix.status === 0 &&
			existsSync(`${prefix.stdout.trim()}/lib/node_modules/js-debug-adapter/src/dapDebugServer.js`)
		)
			return true
	} catch {
		// npm not on PATH
	}
	return false
}

const HAS_JS_DEBUG_SCRIPT = jsDebugScriptResolvable()

// Conditional skip via the alias pattern (see clipboard-wayland-idle.test.ts) —
// the shim types test.skip as a registration call (title, body), not a
// conditional predicate.
const testWithJsDebug = HAS_JS_DEBUG_SCRIPT ? test : test.skip

testWithJsDebug(
	"DAP happy path: debug_state_at runs the full launch→breakpoint→locals→terminate workflow",
	async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: "dap-happy",
				responses: [
					{
						toolCalls: [
							{
								function: {
									name: "debug_state_at",
									arguments: JSON.stringify({ file: "app.js", line: 2, evaluated: ["a + b"] }),
								},
							},
						],
					},
					{ stream: ["State captured at the breakpoint."] },
				],
				env: { KIMCHI_DAP_BINARIES: "" }, // keep other machine adapters inert
				seedHome: (_homeDir, workDir) => {
					writeFileSync(join(workDir, "package.json"), '{"name":"debugme","version":"1.0.0"}\n')
					// Breakpoint at line 2 stops inside add() with a=2, b=3.
					writeFileSync(
						join(workDir, "app.js"),
						'function add(a, b) {\n  return a + b\n}\nconst r = add(2, 3)\nconsole.log("result=" + r)\n',
					)
				},
			},
			async (fixture, trace) => {
				trace.step("checking status footer for active js-debug")
				expect(viewText(terminal)).toContain("DAP: js-debug")

				terminal.submit("capture state at app.js line 2")
				trace.step("submitted prompt")
				await waitForTurnToSettle(fixture.fake.requests)
				trace.step("settled")

				const view = viewText(terminal)
				expect(view).toContain("Debug State At")
				// The program ran to completion after the breakpoint — its stdout is
				// part of the captured state, which must reach the model as the tool
				// result (visible tool output is collapsed in the TUI).
				expect(anyRequestContains(fixture, "result=5")).toBe(true)
			},
		)
	},
)
