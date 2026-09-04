// extensions/tool-exposure.test.ts
//
// Integration-level "tools are exposed correctly" test set (token-optimization
// Phase 1, follow-up to Chunk 3's DAP deferral).
//
// Unlike the budget slice (which measures description/schema sizes), this
// verifies WHO is advertised at session start:
//   - the active-tool set after every extension's session_start must EXACTLY
//     match a documented exposure spec (no tool silently missing or appearing)
//   - deferred tools (Chunk 3: 11 session-scoped DAP tools; Chunk 4:
//     bash_control) are still REGISTERED but hidden — availability preserved,
//     surface reduced
//   - the mcp gateway is config-gated (Chunk 5): not registered at all when
//     zero MCP servers are configured (a dedicated test asserts the on-state)
//   - the five lsp_* tools are detection-gated (Chunk 6): registered but
//     hidden via a visibility vote when no language server is detected for
//     the session cwd (a dedicated test asserts the detected state)
//   - the visibility votes (getDisabledToolNames) equal the declared deferral
//     spec — the drift guard: a new deferral must declare itself here
//   - the DAP + bash_control reveal round-trips expose their tools exactly once
//   - agent workers are carved out (full DAP + bash_control visibility)
//
// Harness: ONE capture pi shared by all extension factories (mirroring a real
// session), with a stateful active-tool set — the real visibility layer
// (prompt-construction/tool-visibility.js) applies its votes to it.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { EXTENSION_SOURCES } from "./context-budget-tools.js"
import { DAP_ALWAYS_VISIBLE_TOOL_NAMES, DAP_SESSION_TOOL_NAMES } from "./dap/tools.js"
import type { DapAdapterConfig } from "./dap/types.js"
import { resolveMultiModelEnabled } from "./multi-model.js"
import { withPrintGate } from "./print-mode.js"
import { getDisabledToolNames } from "./prompt-construction/tool-visibility.js"

vi.mock("./multi-model.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./multi-model.js")>()
	return { ...actual, resolveMultiModelEnabled: vi.fn(() => ({ value: false, source: "cli" })) }
})

// =============================================================================
// Mock MCP config — pin zero configured servers so the Chunk 5 registration
// gate rolls mcp-adapter up off the canonical surface deterministically
// (ambient ~/.config/kimchi/harness/mcp.json state must not leak into the
// spec). The metadata cache is also stubbed: with zero servers the factory
// would otherwise purge and rewrite the developer machine's real cache file.
// =============================================================================

const mcpConfigState = vi.hoisted(() => ({
	servers: {} as Record<string, unknown>,
}))
vi.mock("./mcp-adapter/config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mcp-adapter/config.js")>()
	return {
		...original,
		loadMcpConfig: () => ({ config: { mcpServers: mcpConfigState.servers }, warnings: [] }),
	}
})
vi.mock("./mcp-adapter/metadata-cache.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mcp-adapter/metadata-cache.js")>()
	return {
		...original,
		loadMetadataCache: () => undefined,
		overwriteMetadataCache: () => {},
		flushMetadataCache: () => {},
	}
})

// =============================================================================
// Mock adapter registry — controlled from tests via adapterState.active
// =============================================================================

const adapterState = vi.hoisted(() => ({
	active: [] as DapAdapterConfig[],
}))

vi.mock("./dap/adapters.js", () => ({
	detectAdapters: vi.fn(() => adapterState.active),
	detectMissingAdapters: vi.fn(() => []),
	adapterForFile: vi.fn(() => adapterState.active[0] ?? null),
	adapterForDirectory: vi.fn(() => null),
	adapterExists: vi.fn(() => true),
	allAdapters: vi.fn(() => adapterState.active),
}))

// =============================================================================
// Mock DAP client/session — launch succeeds against a stub session
// =============================================================================

const clientState = vi.hoisted(() => ({
	sessionAfterCreate: undefined as
		| {
				id: string
				adapter: { name: string }
				launch: () => Promise<void>
				terminate: () => Promise<void>
		  }
		| undefined,
}))

vi.mock("./dap/client.js", () => ({
	DapClientRegistry: vi.fn().mockImplementation(() => ({
		getOrCreate: vi.fn(async () => ({}) as unknown),
		shutdownAll: vi.fn(),
		getAll: vi.fn(() => []),
	})),
}))

vi.mock("./dap/session.js", () => ({
	DapSessionRegistry: vi.fn().mockImplementation(() => ({
		create: vi.fn(() => clientState.sessionAfterCreate ?? { id: "test-session" }),
		get: vi.fn(() => undefined),
		remove: vi.fn(),
		clearAll: vi.fn(),
		getActive: vi.fn(() => []),
	})),
}))

// Control isAgentWorker() per test.
const workerState = vi.hoisted(() => ({ isWorker: false }))
vi.mock("./agent-worker-context.js", () => ({
	isAgentWorker: () => workerState.isWorker,
}))

// =============================================================================
// Mock LSP server detection — pin zero detected servers so the Chunk 6
// visibility gate hides the five lsp_* tools deterministically. Detection
// otherwise hits the real filesystem (project markers) and PATH (`which`),
// and this dev machine HAS typescript-language-server installed — ambient
// host state must not leak into the spec. serverForFile/findRoot keep their
// real implementations (pure path logic; not exercised at session_start).
// =============================================================================

const lspServerState = vi.hoisted(() => ({
	active: [] as Array<{ name: string }>,
}))
vi.mock("./lsp/servers.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./lsp/servers.js")>()
	return {
		...original,
		detectServers: () => lspServerState.active,
		detectMissingCandidates: () => [],
	}
})

const dapExtension = (await import("./dap.js")).default

// =============================================================================
// Stateful capture pi — registerTool/getActiveTools/setActiveTools are real;
// everything else is a benign no-op (same tolerance as the budget harness).
// =============================================================================

function createDeepNoop(): unknown {
	const target = () => deepNoop
	const deepNoop: unknown = new Proxy(target, {
		get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : createDeepNoop()),
		apply: () => createDeepNoop(),
	})
	return deepNoop
}

interface ExposureHarness {
	registered: Map<string, { name: string; description?: string; execute: (...args: unknown[]) => Promise<unknown> }>
	/** Active tool set — what the model is actually offered. */
	active: Set<string>
	/** Every setActiveTools call, in order (transition log). */
	activeTransitions: string[][]
	fire: (event: string, payload?: unknown) => Promise<void>
	/** Fire an event where handlers receive the event object (e.g. tool_result,
	 *  whose handlers read event.toolName — `fire` passes the name string as the
	 *  first arg, which only suits name-only handlers like session_start). */
	fireEvent: (event: string, eventObject: unknown) => Promise<void>
}

function createExposureHarness(): ExposureHarness & { pi: ExtensionAPI } {
	const registered = new Map<
		string,
		{ name: string; description?: string; execute: (...args: unknown[]) => Promise<unknown> }
	>()
	const active = new Set<string>()
	const activeTransitions: string[][] = []
	const handlers = new Map<string, Array<(event: unknown, payload?: unknown) => unknown>>()

	const api = new Proxy(
		{},
		{
			get: (_target, prop) => {
				if (prop === "registerTool") {
					return (tool: { name: string; description?: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
						registered.set(tool.name, tool)
						active.add(tool.name) // real runtime: new tools are active by default
					}
				}
				if (prop === "getActiveTools") return () => [...active]
				if (prop === "setActiveTools") {
					return (names: string[]) => {
						activeTransitions.push([...names])
						active.clear()
						for (const n of names) active.add(n)
					}
				}
				if (prop === "on") {
					return (event: string, handler: (event: unknown, payload?: unknown) => unknown) => {
						const list = handlers.get(event) ?? []
						list.push(handler)
						handlers.set(event, list)
					}
				}
				if (prop === "then" || typeof prop === "symbol") return undefined
				return createDeepNoop()
			},
		},
	)

	const fire = async (event: string, payload?: unknown) => {
		// Real handlers take (event, ctx) (e.g. system-prompt-blocks reads
		// ctx.sessionManager); pass both so the ctx payload is honored.
		for (const handler of handlers.get(event) ?? []) {
			await handler(event as never, payload)
		}
	}

	const fireEvent = async (event: string, eventObject: unknown) => {
		for (const handler of handlers.get(event) ?? []) {
			await handler(eventObject as never, undefined)
		}
	}

	return {
		registered,
		active,
		activeTransitions,
		fire,
		fireEvent,
		pi: api as unknown as ExtensionAPI,
	}
}

/** The session-start payload extensions read — the shared mock ctx plus the
 *  surfaces todos/tags touch (getBranch() is mapped over; ui.theme is used by
 *  the tags status-line renderer). */
function sessionStartPayload(): ExtensionContext {
	return createContext({
		cwd: "/tmp/exposure-test",
		ui: {
			setWidget: vi.fn(),
			theme: {
				fg: (_style: string, s: string) => s,
				bold: (s: string) => s,
			} as unknown as ExtensionUIContext["theme"],
		},
		sessionManager: {
			getSessionId: () => "exposure-session",
			getBranch: () => [],
		},
	})
}

// =============================================================================
// Exposure spec — the documented session-start surface (must match the CI
// canonical measurement; any drift fails loudly here, not silently in prod)
// =============================================================================

const UPSTREAM_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const

/** bash_control is deferred in main sessions (Chunk 4): registered but
 *  hidden at session start, revealed on the first background bash handle. */
const BASH_CONTROL_TOOLS = ["bash_control"] as const

/** Every tool that must be advertised at session start, from the canonical
 *  measurement (2026-08-28 post-Chunk-4: 32 tools / ~7,881 est). Kept as a literal spec —
 *  deriving it from the same factories would make this test circular. */
const EXPECTED_SESSION_START_VISIBLE = new Set<string>([
	...UPSTREAM_BUILTINS,
	// todos
	"create_todos",
	"update_todos",
	"mark_todo",
	"add_todo",
	"clear_todos",
	// web-search / web-fetch / questionnaire
	"web_search",
	"web_fetch",
	"questionnaire",
	// agents
	"Agent",
	"resume_subagent",
	"get_subagent_result",
	"steer_subagent",
	// tags / skills (the mcp gateway is config-gated — Chunk 5: it registers
	// only when >=1 MCP server is configured; see the gate-on test below)
	"set_phase",
	"Skill",
	// dap — always-visible set (deferred session tools below)
	...DAP_ALWAYS_VISIBLE_TOOL_NAMES,
])

/** Deferral spec: tools REGISTERED but hidden at session start. A future
 *  deferral must add itself here — the drift-guard tests below enforce it.
 *  (Config-gated tools like mcp don't belong here: in their off state they
 *  are unregistered, not hidden.) */

/** The five lsp_* tools are detection-gated (token-optimization Phase 1
 *  Chunk 6): registered at session start but hidden via a visibility vote
 *  when no language server is detected for the session cwd. They share the
 *  visibility-vote mechanics with the deferrals above, so they are asserted
 *  in the same drift-guard bucket. */
const LSP_TOOL_NAMES = ["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_rename"] as const
const EXPECTED_DEFERRED_BY_DESIGN = new Set<string>([
	...DAP_SESSION_TOOL_NAMES,
	...BASH_CONTROL_TOOLS,
	...LSP_TOOL_NAMES,
])

/** Extensions that register tools at session_start, mirroring the budget
 *  measurement + the DAP extension (the real subject of the Chunk 3 deferral).
 *  Upstream builtins are also registered, exactly as measureBuiltinTools does,
 *  so the harness models a real session's tool surface. */
async function instantiateAllExtensions(harness: ExposureHarness & { pi: ExtensionAPI }): Promise<void> {
	const { pi, fire } = harness
	// Upstream builtins — registered by the pi core, not by extensions. Use the
	// same factory approach as the budget measurement so the exposure spec can
	// include them side by side with extension tools.
	const builtinFactories = [
		createReadToolDefinition,
		createBashToolDefinition,
		createEditToolDefinition,
		createWriteToolDefinition,
		createGrepToolDefinition,
		createFindToolDefinition,
		createLsToolDefinition,
	] as const
	for (const factory of builtinFactories) {
		pi.registerTool(factory("/tmp/exposure-test") as never)
	}
	for (const { module } of EXTENSION_SOURCES) {
		const imported = (await import(module)) as { default?: (api: unknown) => unknown }
		if (typeof imported.default !== "function") throw new Error(`no default export in ${module}`)
		await imported.default(pi)
	}
	dapExtension(pi)
	const bashControl = (await import("./bash-background/bash-control-extension.js")) as {
		default?: (api: unknown) => unknown
	}
	await bashControl.default?.(pi)
	await fire("session_start", sessionStartPayload())
}

const JS_DEBUG: DapAdapterConfig = {
	name: "js-debug",
	command: "js-debug-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

// =============================================================================
// Tests
// =============================================================================

describe("tool exposure at session start", () => {
	beforeEach(() => {
		mcpConfigState.servers = {}
		lspServerState.active = []
		adapterState.active = [JS_DEBUG]
		clientState.sessionAfterCreate = {
			id: "test-session",
			adapter: { name: "js-debug" },
			launch: vi.fn(async () => {}),
			terminate: vi.fn(async () => {}),
		}
		workerState.isWorker = false
	})

	it("advertises exactly the documented 26-tool surface and hides the 17 deferred tools", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		const visible = new Set(harness.active)
		expect(visible).toEqual(EXPECTED_SESSION_START_VISIBLE)
		expect(visible.size).toBe(26)

		// Deferred tools are still REGISTERED (availability preserved)…
		for (const name of EXPECTED_DEFERRED_BY_DESIGN) {
			expect(harness.registered.has(name), `${name} must stay registered`).toBe(true)
		}
		// …but never advertised at session start.
		const deferredInActive = [...EXPECTED_DEFERRED_BY_DESIGN].filter((n) => visible.has(n))
		expect(deferredInActive).toEqual([])
	})

	it("print mode drops questionnaire + set_phase at registration (Chunk 7)", async () => {
		await withPrintGate({ print: true }, async () => {
			const harness = createExposureHarness()
			await instantiateAllExtensions(harness)

			// Registration gates: unlike deferred tools, these are NOT registered
			// in --print mode — not merely hidden.
			expect(harness.registered.has("questionnaire"), "questionnaire must not register in --print").toBe(false)
			expect(harness.registered.has("set_phase"), "set_phase must not register in --print").toBe(false)

			// The remaining visible surface is the interactive spec minus the two
			// gate-outs; deferred spec is unchanged.
			const expectedVisible = new Set(
				[...EXPECTED_SESSION_START_VISIBLE].filter((n) => n !== "questionnaire" && n !== "set_phase"),
			)
			const visible = new Set(harness.active)
			expect(visible).toEqual(expectedVisible)
			expect(visible.size).toBe(24)
			for (const name of EXPECTED_DEFERRED_BY_DESIGN) {
				expect(harness.registered.has(name), `${name} must stay registered in --print`).toBe(true)
			}
		})
	})

	it("print mode keeps set_phase registered when the session is multi-model", async () => {
		vi.mocked(resolveMultiModelEnabled).mockReturnValue({ value: true, source: "cli" })
		try {
			await withPrintGate({ print: true }, async () => {
				const harness = createExposureHarness()
				await instantiateAllExtensions(harness)

				// The orchestrator prompt instructs set_phase calls; the tool must
				// exist even though the print gate would otherwise skip it.
				expect(harness.registered.has("set_phase"), "set_phase must register in multi-model --print").toBe(true)
				expect(harness.registered.has("questionnaire"), "questionnaire stays print-gated").toBe(false)
			})
		} finally {
			vi.mocked(resolveMultiModelEnabled).mockReturnValue({ value: false, source: "cli" })
		}
	})

	it("drift guard: every registered tool is either visible or explicitly deferred, and vice versa", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		const registered = new Set(harness.registered.keys())
		// No undeclared tool in the active set:
		for (const name of harness.active) {
			expect(EXPECTED_SESSION_START_VISIBLE.has(name), `${name} visible but not in spec`).toBe(true)
		}
		// No registered tool silently missing from both spec sets (would be a
		// tool hidden without declaring itself):
		for (const name of registered) {
			expect(
				EXPECTED_SESSION_START_VISIBLE.has(name) || EXPECTED_DEFERRED_BY_DESIGN.has(name),
				`${name} registered but neither visible nor declared deferred`,
			).toBe(true)
		}
		// The spec declares nothing that isn't registered:
		for (const name of EXPECTED_SESSION_START_VISIBLE) {
			expect(registered.has(name), `${name} in spec but never registered`).toBe(true)
		}
	})

	it("visibility votes exactly match the deferral spec (no undeclared hidden tools)", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		const votes = new Set(getDisabledToolNames(harness.pi))
		expect(votes).toEqual(EXPECTED_DEFERRED_BY_DESIGN)
		expect(votes.size).toBe(17)
	})

	it("lsp tools stay advertised when a language server is detected (Chunk 6 gate on)", async () => {
		lspServerState.active = [{ name: "typescript-language-server" }]
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		for (const name of LSP_TOOL_NAMES) {
			expect(harness.registered.has(name), `${name} must be registered`).toBe(true)
			expect(harness.active.has(name), `${name} must be advertised when a server is detected`).toBe(true)
		}
	})

	it("mcp gateway registers and is advertised when a server is configured (Chunk 5 gate on)", async () => {
		mcpConfigState.servers = {
			// Spawn fails fast (ENOENT) and is caught inside initializeMcp — the
			// registration/advertisement under test happens before init runs.
			"gate-test": { command: "definitely-not-a-real-kimchi-exposure-command" },
		}
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		expect(harness.registered.has("mcp"), "mcp must be registered with >=1 configured server").toBe(true)
		expect(harness.active.has("mcp"), "mcp must be advertised with >=1 configured server").toBe(true)
	})

	it("DAP reveal round-trip exposes the 11 session tools exactly once when a session starts", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(harness.active.has(name), `${name} hidden before any debug session`).toBe(false)
		}

		// Execute the registered debug_launch (real tool → real launchSession
		// in dap.ts → mocked session registry launch succeeds → reveal fires).
		const launchTool = harness.registered.get("debug_launch")
		expect(launchTool).toBeDefined()
		if (!launchTool) throw new Error("debug_launch not registered")
		await launchTool.execute("call-1", { program: "app.ts" }, undefined, undefined, sessionStartPayload())

		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(harness.active.has(name), `${name} visible after session start`).toBe(true)
		}
		const transitionsAfterReveal = harness.activeTransitions.length
		expect(transitionsAfterReveal).toBeGreaterThan(0)

		// Second launch: guard prevents a second visibility transition.
		await launchTool.execute("call-2", { program: "app.ts" }, undefined, undefined, sessionStartPayload())
		expect(harness.activeTransitions.length).toBe(transitionsAfterReveal)
	})

	it("bash_control reveal round-trip exposes it exactly once on the first background handle", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		expect(harness.active.has("bash_control"), "bash_control hidden before any background handle").toBe(false)

		// A bash result carrying a background handle reveals bash_control
		// (the gate handler observes the handle; reveal happens in the same seam).
		await harness.fireEvent("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long build" },
			content: [{ type: "text", text: "still running" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false },
		})

		expect(harness.active.has("bash_control"), "bash_control visible after the first background handle").toBe(true)
		const transitionsAfterReveal = harness.activeTransitions.length

		// A second handle must not re-transition visibility (one-way reveal).
		await harness.fireEvent("tool_result", {
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "another long build" },
			content: [{ type: "text", text: "still running" }],
			isError: false,
			details: { handle: "h2", checkin: true, exited: false },
		})
		expect(harness.activeTransitions.length).toBe(transitionsAfterReveal)
	})

	it("agent workers keep full DAP + bash_control visibility (carve-out)", async () => {
		workerState.isWorker = true
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		for (const name of [...DAP_ALWAYS_VISIBLE_TOOL_NAMES, ...DAP_SESSION_TOOL_NAMES]) {
			expect(harness.active.has(name), `${name} must stay visible in workers`).toBe(true)
		}
		// The tactical deferrals (DAP session tools + bash_control) are carved
		// out of workers — they must not hold disable votes here. The LSP gate
		// (Chunk 6) is environmental, not tactical: in a no-server session the
		// lsp tools can only ever answer "No LSP server available", so the gate
		// deliberately applies to workers too. Assert the carve-outs precisely
		// instead of a blanket zero-vote count.
		const disabled = getDisabledToolNames(harness.pi)
		for (const name of [...DAP_SESSION_TOOL_NAMES, ...BASH_CONTROL_TOOLS]) {
			expect(disabled.has(name), `${name} must not be hidden in workers`).toBe(false)
		}
	})
})
