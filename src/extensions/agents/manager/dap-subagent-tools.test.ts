// dap-subagent-tools.test.ts
//
// Regression test for the Debugger persona wiring (code-review finding: the
// Debugger persona requested debug_* tools via builtinToolNames but set
// extensions: false — and repo-native extensions registered in cli.ts are not
// discovered by a child session's DefaultResourceLoader, so the tools never
// existed in the child session).
//
// This test uses the REAL pi SDK (createAgentSession + DefaultResourceLoader)
// with the REAL dap extension registered as an inline factory, mirroring how
// agent-runner.ts constructs subagent sessions for extensions:false personas:
//   1. Child loader created with noExtensions: true + inline dapExtension.
//   2. createAgentSession receives the requested tool names via `tools`
//      (the SDK's allowlist).
//   3. bindExtensions emits session_start → the dap extension registers its
//      tools → the SDK activates them because their names are in the allowlist.
//
// The assertion is on the child session's ACTIVE tool names.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it } from "vitest"
import { runAsAgentWorker } from "../../agent-worker-context.js"
import dapExtension from "../../dap.js"

/** Minimal model stub — the session never streams in this test, so the model
 *  and runtime only need to satisfy construction-time shape checks. */
const fakeModel = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>

const tmpDirs: string[] = []

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dap-subagent-tools-"))
	tmpDirs.push(dir)
	return dir
}

afterAll(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("DAP tools in subagent sessions", () => {
	it("activation alone does not require adapters to be installed", async () => {
		// dap.ts runs adapter detection at activation and on session_start. This
		// must not throw even when no debug adapter is on PATH.
		const tmp = makeTmpDir()
		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "test",
			appendSystemPromptOverride: () => [],
			extensionFactories: [dapExtension],
		})
		await expect(loader.reload()).resolves.toBeUndefined()
	})

	it("child session activates debug tools whose names are in the tools allowlist", async () => {
		const tmp = makeTmpDir()
		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true, // mirrors personas with extensions: false (Debugger)
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "test",
			appendSystemPromptOverride: () => [],
			extensionFactories: [dapExtension],
		})
		await loader.reload()

		// The real agent-runner wraps every child session in runAsAgentWorker
		// (agent-runner.ts:351), so the DAP deferral carve-out (isAgentWorker →
		// keep full visibility) applies. Mirror that here: without the worker
		// context, the deferral would hide step_in and fail the allowlist test.
		await runAsAgentWorker(async () => {
			const walker = await createAgentSession({
				cwd: tmp,
				agentDir: tmp,
				sessionManager: SessionManager.inMemory(tmp),
				settingsManager: SettingsManager.create(tmp, tmp),
				model: fakeModel,
				modelRuntime: {} as ModelRuntime,
				resourceLoader: loader,
				// Mirrors agent-runner's extensions:false path (sessionOpts.tools = toolNames).
				tools: ["read", "grep", "find", "ls", "debug_launch", "debug_state_at", "step_in"],
			})
			const session = walker.session
			await session.bindExtensions({
				onError: (err) => {
					throw new Error(`dap extension failed in child session: ${err.error ?? err.extensionPath}`)
				},
			})

			const active = session.getActiveToolNames()
			expect(active).toContain("debug_launch")
			expect(active).toContain("debug_state_at")
			expect(active).toContain("step_in")

			// Cleanup: emit shutdown so the dap extension tears down registries.
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
		})
	})

	it("without the dap extension factory, debug tool names activate nothing", async () => {
		// Falsification of the original bug: requested debug_* names are silently
		// dropped when the extension is not registered in the child session.
		const tmp = makeTmpDir()
		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir: tmp,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "test",
			appendSystemPromptOverride: () => [],
			extensionFactories: [],
		})
		await loader.reload()

		const walker = await createAgentSession({
			cwd: tmp,
			agentDir: tmp,
			sessionManager: SessionManager.inMemory(tmp),
			settingsManager: SettingsManager.create(tmp, tmp),
			model: fakeModel,
			modelRuntime: {} as ModelRuntime,
			resourceLoader: loader,
			tools: ["read", "debug_launch"],
		})
		const session = walker.session
		await session.bindExtensions({ onError: () => {} })

		const active = session.getActiveToolNames()
		expect(active).toContain("read")
		expect(active).not.toContain("debug_launch")

		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	})
})
