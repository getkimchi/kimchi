import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type ResourceLoaderOptions = Record<string, unknown>

const capturedLoaderOptions: ResourceLoaderOptions[] = []

// Partial mock: keep the entire real pi-coding-agent package, but record the
// options handed to DefaultResourceLoader and stub createAgentSession. The
// wiring under test ends at the resource loader; a real session creation
// would pull in model/auth setup unrelated to the _meta → appendSystemPrompt
// thread-through.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	class CapturingResourceLoader extends actual.DefaultResourceLoader {
		// biome-ignore lint/suspicious/noExplicitAny: test double forwarding the real ctor options
		constructor(options: any) {
			capturedLoaderOptions.push(options as ResourceLoaderOptions)
			super(options)
		}
	}
	return {
		...actual,
		DefaultResourceLoader: CapturingResourceLoader,
		createAgentSession: async () => ({ session: { sessionId: "stubbed-session" } }) as never,
	}
})

import { defaultSessionFactory, defaultSessionLoader, type RunAcpOptions } from "./server.js"

// Mirror of server.ts's private encodeCwdDir — the encoding is a public
// on-disk format (see its comment).
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

describe("default session factory/loader _meta wiring", () => {
	let agentDir: string
	let cwd: string
	const tempDirs: string[] = []

	beforeEach(() => {
		capturedLoaderOptions.length = 0
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-acp-wiring-agent-"))
		cwd = mkdtempSync(join(tmpdir(), "kimchi-acp-wiring-cwd-"))
		tempDirs.push(agentDir, cwd)
	})

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	function makeOptions(extra?: Partial<RunAcpOptions>): RunAcpOptions {
		return { extensionFactories: [], agentDir, ...extra }
	}

	it("defaultSessionFactory threads _meta['kimchi.dev'].systemPrompt into DefaultResourceLoader.appendSystemPrompt", async () => {
		const factory = defaultSessionFactory(makeOptions())
		await factory({
			cwd,
			mcpServers: [],
			_meta: { "kimchi.dev": { systemPrompt: "You are a worker under AO supervision." } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(capturedLoaderOptions[0].appendSystemPrompt).toEqual(["You are a worker under AO supervision."])
	})

	it("defaultSessionFactory appends meta content after --append-system-prompt CLI flag content", async () => {
		const factory = defaultSessionFactory(makeOptions({ appendSystemPrompt: ["cli base prompt"] }))
		await factory({
			cwd,
			mcpServers: [],
			_meta: { "kimchi.dev": { systemPrompt: "meta prompt" } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(capturedLoaderOptions[0].appendSystemPrompt).toEqual(["cli base prompt", "meta prompt"])
	})

	it("defaultSessionFactory leaves appendSystemPrompt unset when no meta is present (backward compat)", async () => {
		const factory = defaultSessionFactory(makeOptions())
		await factory({ cwd, mcpServers: [] })
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(capturedLoaderOptions[0].appendSystemPrompt).toBeUndefined()
	})

	it("defaultSessionLoader threads _meta['kimchi.dev'].systemPrompt identically", async () => {
		const sessionId = "wiring-load-1"
		const sessionDir = join(agentDir, "sessions", encodeCwdDir(cwd))
		mkdirSync(sessionDir, { recursive: true })
		writeFileSync(
			join(sessionDir, `2026-05-09T00-00-00.000Z_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-05-09T00:00:00Z",
				cwd,
			})}\n`,
		)
		const loader = defaultSessionLoader(makeOptions())
		await loader({
			sessionId,
			cwd,
			mcpServers: [],
			_meta: { "kimchi.dev": { systemPrompt: "Loaded sessions get the same prompt." } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(capturedLoaderOptions[0].appendSystemPrompt).toEqual(["Loaded sessions get the same prompt."])
	})
})
