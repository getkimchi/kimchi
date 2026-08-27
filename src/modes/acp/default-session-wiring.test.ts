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

// Stub the skill-list block: buildSkillListBlock(cwd) would otherwise
// discover the real HOME's skills and pollute the asserted prompt array (the
// block itself is upstream's contribution appended after the _meta entries).
vi.mock("./skill-commands.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./skill-commands.js")>()
	return { ...actual, buildSkillListBlock: () => "" }
})

import { defaultSessionFactory, defaultSessionLoader, type RunAcpOptions } from "./server.js"

// Mirror of server.ts's private encodeCwdDir — the encoding is a public
// on-disk format (see its comment).
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

// Since the rebase onto upstream/master, DefaultResourceLoader is configured
// through appendSystemPromptOverride (upstream added the skill-list block via
// an override), not a static appendSystemPrompt array. Invoke the captured
// override the way pi's resource loader does (with the discovered base
// entries — empty here because the temp cwd has no append-system prompt file)
// and assert on the appended entries.
type AppendOverride = (base: string[]) => string[]

function invokeCapturedOverride(index = 0): string[] {
	const override = capturedLoaderOptions[index].appendSystemPromptOverride as AppendOverride | undefined
	if (!override) throw new Error("expected DefaultResourceLoader to receive an appendSystemPromptOverride")
	return override([])
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

	it("defaultSessionFactory threads _meta['kimchi.dev'].appendSystemPrompt into DefaultResourceLoader.appendSystemPrompt", async () => {
		const factory = defaultSessionFactory(makeOptions())
		await factory({
			cwd,
			mcpServers: [],
			_meta: { "kimchi.dev": { appendSystemPrompt: "You are a worker under AO supervision." } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(invokeCapturedOverride()).toEqual(["You are a worker under AO supervision."])
	})

	it("defaultSessionFactory appends meta content after --append-system-prompt CLI flag content", async () => {
		const factory = defaultSessionFactory(makeOptions({ appendSystemPrompt: ["cli base prompt"] }))
		await factory({
			cwd,
			mcpServers: [],
			_meta: { "kimchi.dev": { appendSystemPrompt: "meta prompt" } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(invokeCapturedOverride()).toEqual(["cli base prompt", "meta prompt"])
	})

	it("defaultSessionFactory leaves appendSystemPrompt unset when no meta is present (backward compat)", async () => {
		const factory = defaultSessionFactory(makeOptions())
		await factory({ cwd, mcpServers: [] })
		expect(capturedLoaderOptions).toHaveLength(1)
		// Only the upstream skill-list block may be appended — and an empty
		// temp cwd yields no skills, so the result must be empty.
		expect(invokeCapturedOverride()).toEqual([])
	})

	it("defaultSessionLoader threads _meta['kimchi.dev'].appendSystemPrompt identically", async () => {
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
			_meta: { "kimchi.dev": { appendSystemPrompt: "Loaded sessions get the same prompt." } },
		})
		expect(capturedLoaderOptions).toHaveLength(1)
		expect(invokeCapturedOverride()).toEqual(["Loaded sessions get the same prompt."])
	})
})
