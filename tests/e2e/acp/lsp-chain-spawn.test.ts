// ACP integration: LSP on the ACP surface. Two contracts:
// 1. The session model request registers the five lsp_* tools (the LSP
//    extension's session_start ran with an active server).
// 2. A session edit spawns a real gopls chain process (the file-sync
//    handler fires on tool_result in ACP mode too, not just the TUI).
// Gated on gopls being installed (CI runners may not have it); the
// process assertion uses a before/after delta so machines with unrelated
// gopls instances (e.g. VS Code) don't flake it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { goplsOnPath, goplsProcessCount } from "./support/processes.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — LSP chain spawn", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "lsp-chain-spawn",
			responses: [
				{
					stream: ["I'll edit the Go file."],
					toolCalls: [
						{
							function: {
								name: "edit",
								arguments: JSON.stringify({
									path: "f0.go",
									edits: [{ oldText: "// anchor", newText: "// anchor\n// edited" }],
								}),
							},
						},
					],
				},
				{ stream: ["done"] },
			],
			pretrustWorkDir: true,
		})
		// Seed a minimal Go module after fixture creation but before the
		// first prompt: session_start (which runs detectServers) fires on
		// the session's first turn.
		mkdirSync(fixture.workDir, { recursive: true })
		writeFileSync(join(fixture.workDir, "go.mod"), "module sim/go\n\ngo 1.23\n")
		writeFileSync(
			join(fixture.workDir, "f0.go"),
			'package main\n\nimport "fmt"\n\n// anchor\nfunc Func0() int {\n\tx := 0 * 2\n\tfmt.Println("f0", x)\n\treturn x\n}\n',
		)
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it.runIf(goplsOnPath)("registers the lsp_* tools on the session model request", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Reply with: ok")

		const withTools = fixture.fake.requests.filter((r) => {
			const tools = (r.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools
			return Array.isArray(tools) && tools.length > 0
		})
		expect(withTools.length).toBeGreaterThan(0)
		const names = ((withTools[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
			(t) => t?.function?.name,
		)
		expect(names).toContain("lsp_diagnostics")
		expect(names).toContain("lsp_hover")
	})

	it.runIf(goplsOnPath)("spawns a gopls chain when a session edits a Go file", async () => {
		const before = goplsProcessCount()
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Edit f0.go once.")

		// The edit really applied — the turn executed, not just ended.
		expect(readFileSync(join(fixture.workDir, "f0.go"), "utf-8")).toContain("// edited")

		// Chain boot is async (initialize handshake with the server); poll
		// briefly for the process to appear.
		let spawned = false
		for (let i = 0; i < 20; i++) {
			if (goplsProcessCount() > before) {
				spawned = true
				break
			}
			await new Promise((r) => setTimeout(r, 1000))
		}
		expect(spawned).toBe(true)
	})
})
