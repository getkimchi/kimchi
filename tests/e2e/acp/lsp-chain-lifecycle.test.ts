// ACP integration: LSP chain lifecycle across concurrent sessions.
// The client registry is module-global and every session used to call
// shutdownAll on session_shutdown — the first close killed another live
// session's chain (PR review finding, verified live pre-fix).
// Contract now:
//  1. Two sessions on two projects spawn two chains in one ACP process.
//  2. Closing the first session kills NOTHING — the registry ref-counts
//     sessions and only the last close tears chains down.
//  3. Closing the last session kills every chain.
// Gated on gopls being installed; process assertions use a before/after
// delta so unrelated gopls instances (e.g. VS Code) don't flake it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { goplsOnPath, goplsProcessCount } from "./support/processes.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

function seedGoModule(dir: string, file: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "go.mod"), "module sim/lifecycle\n\ngo 1.23\n")
	writeFileSync(join(dir, file), 'package main\n\nimport "fmt"\n\n// anchor\nfunc F() { fmt.Println("ok") }\n')
}

describe("ACP integration — LSP cross-session chain lifecycle", () => {
	let fixture: AcpFixture
	let workDir2: string

	beforeEach(async () => {
		workDir2 = mkdtempSync(join(tmpdir(), "acp-lsp-wd2-"))
		fixture = await startAcpFixture({
			artifactName: "lsp-chain-lifecycle",
			responses: [
				{
					stream: ["Editing the first Go file."],
					toolCalls: [
						{
							function: {
								name: "edit",
								arguments: JSON.stringify({
									path: "f0.go",
									edits: [{ oldText: "// anchor", newText: "// anchor\n// one" }],
								}),
							},
						},
					],
				},
				{ stream: ["done one"] },
				{
					stream: ["Editing the second Go file."],
					toolCalls: [
						{
							function: {
								name: "edit",
								arguments: JSON.stringify({
									path: "f0.go",
									edits: [{ oldText: "// anchor", newText: "// anchor\n// two" }],
								}),
							},
						},
					],
				},
				{ stream: ["done two"] },
			],
			pretrustWorkDir: true,
			extraTrustedWorkDirs: [workDir2],
		})
		seedGoModule(fixture.workDir, "f0.go")
		seedGoModule(workDir2, "f0.go")
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		// beforeEach can bail before fixture assignment (fixture start failure);
		// don't mask the real error with a teardown crash.
		await fixture?.stop()
		rmSync(workDir2, { recursive: true, force: true })
	})

	it.runIf(goplsOnPath)("first session close keeps the other session's chain; last close kills all", async () => {
		const before = goplsProcessCount()

		// Session 1 on workDir: an edit triggers the file-sync chain spawn.
		const s1 = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, s1, "edit the go file")).stopReason).toBe("end_turn")
		await waitFor(goplsProcessCount, (n) => n >= before + 1)

		// Session 2 on workDir2: a second chain for the second root.
		const s2 = await newSession(fixture, workDir2)
		expect((await prompt(fixture, s2, "edit the go file")).stopReason).toBe("end_turn")
		await waitFor(goplsProcessCount, (n) => n >= before + 2)

		// Closing session 1 must NOT kill anything: pre-fix this dropped the
		// count by 2 (both chains died in shutdownAll).
		await fixture.conn.unstable_closeSession({ sessionId: s1 })
		const afterFirstClose = goplsProcessCount()
		expect(afterFirstClose).toBeGreaterThanOrEqual(before + 2)

		// Closing the last session tears down everything.
		await fixture.conn.unstable_closeSession({ sessionId: s2 })
		await waitFor(goplsProcessCount, (n) => n <= before)
	})
})
