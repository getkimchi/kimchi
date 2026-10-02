// extensions/tool-exposure.test.ts
//
// Integration-level "tools are exposed correctly" test set (token-optimization
// Phase 1, follow-up to Chunk 3's DAP deferral).
//
// Unlike the budget slice (which measures description/schema sizes), this
// verifies WHO is advertised at session start:
//   - the active-tool set after every extension's session_start must EXACTLY
//     match a documented exposure spec (no tool silently missing or appearing)
//   - deferred tools (DAP entry/session tools, Agent continuations) are still
//     REGISTERED but hidden — availability preserved, surface reduced.
//     bash_control and web_fetch are NOT deferred: they are part of the
//     static session surface so the top-level tools array never changes
//     mid-session (prompt-cache stability).
//   - the mcp gateway is config-gated (Chunk 5): not registered at all when
//     zero MCP servers are configured (a dedicated test asserts the on-state)
//   - the five lsp_* tools are detection-gated (Chunk 6): registered but
//     hidden via a visibility vote when no language server is detected for
//     the session cwd (a dedicated test asserts the detected state)
//   - the Skill tool is resource-gated: registers at session_start only when
//     a .claude skills dir exists for the session cwd (gate tests live in
//     claude-code-skills/index.test.ts)
//   - the visibility votes (getDisabledToolNames) equal the declared deferral
//     spec — the drift guard: a new deferral must declare itself here
//   - the DAP + Agent continuation reveals expose their tools exactly once
//   - agent workers are carved out of the tactical deferrals
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
import { DAP_ENTRY_TOOL_NAMES, DAP_SESSION_TOOL_NAMES } from "./dap/tools.js"
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
//
// Without useProgrammaticConfig: true, mcp/index.ts passes empty options to
// createMcpAdapter, which then reads the real MCP config from disk (the agent
// dir set by PI_CODING_AGENT_DIR) and registers its tools (atlassian_*) into
// the tool surface under test. The flag makes the adapter use only the
// servers mocked above.
// =============================================================================

const mcpConfigState = vi.hoisted(() => ({
	servers: {} as Record<string, unknown>,
}))
vi.mock("./mcp/config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./mcp/config.js")>()
	return {
		...original,
		loadKimchiMcpConfig: () => ({
			config: { mcpServers: mcpConfigState.servers },
			warnings: [],
			useProgrammaticConfig: true,
		}),
	}
})

// The adapter falls through to createMcpAdapter({}) when the mocked config
// carries no configPath — the library then discovers the DEVELOPER MACHINE's
// real default MCP config (~/.config/mcp/mcp.json) and leaks those tools into
// the spec. Stub createMcpAdapter so mcpConfigState is the single source of
// truth: zero servers → nothing registered; >=1 → the bare gateway tool.
vi.mock("pi-mcp-adapter", async (importOriginal) => {
	const original = await importOriginal<typeof import("pi-mcp-adapter")>()
	const stub = (options?: { config?: { mcpServers?: Record<string, unknown> } }) => {
		// biome-ignore lint/suspicious/noExplicitAny: capture api — only registerTool is used
		return (api: { registerTool: (tool: any) => void }) => {
			const servers = options?.config?.mcpServers ?? mcpConfigState.servers
			if (Object.keys(servers).length === 0) return
			api.registerTool({
				name: "mcp",
				description: "MCP gateway (stubbed for the exposure spec)",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "" }] }),
			})
		}
	}
	return { ...original, createMcpAdapter: stub }
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
				if (prop === "getFlag") return () => undefined
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
				getFgAnsi: (_color?: string) => "",
				getBgAnsi: (_color?: string) => "",
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

/** Every tool that must be advertised at session start. Kept as a literal
 *  spec — deriving it from the same factories would make this test circular.
 *  (The historical "32 tools / ~7,881 est" comment was stale; the real
 *  ground truth is measured freshly by this spec itself.) */
const EXPECTED_SESSION_START_VISIBLE = new Set<string>([
	...UPSTREAM_BUILTINS,
	// todos
	"create_todos",
	"update_todos",
	"mark_todo",
	"add_todo",
	"clear_todos",
	// web-search / web-fetch / questionnaire — web_fetch is part of the
	// static surface (cache-stable tool surface: a mid-session reveal
	// invalidates the prompt cache for everything after the tools block).
	"web_search",
	"web_fetch",
	"questionnaire",
	// agents — `Agent` is the always-visible anchor; the three continuation
	// tools are deferred until the first subagent exists
	"Agent",
	// tags / skills (the mcp gateway is config-gated — Chunk 5: it registers
	// only when >=1 MCP server is configured; see the gate-on test below).
	// Skill is resource-gated: it registers only when a .claude skills dir
	// exists (gate tests in claude-code-skills/index.test.ts).
	"set_phase",
	// model-switch / permissions — previously registered but invisible to this
	// spec; now covered (and print-gated, separately, in Chunk C.6).
	"set_model",
	"submit_plan",
	// Interim (split 1/3): Skill registers unconditionally — the resource
	// gate arrives in split 2/3 — and bash_control stays deferred until
	// split 3/3 restores the static surface (see EXPECTED_DEFERRED_BY_DESIGN).
	"Skill",
	// dap — all 16 DAP tools are deferred (entry set reveals on the
	// dap-debugging skill read; session set on debug_launch)
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
const AGENT_CONTINUATION_TOOLS = ["resume_subagent", "steer_subagent", "get_subagent_result"] as const
const EXPECTED_DEFERRED_BY_DESIGN = new Set<string>([
	...DAP_ENTRY_TOOL_NAMES,
	...DAP_SESSION_TOOL_NAMES,
	...LSP_TOOL_NAMES,
	...AGENT_CONTINUATION_TOOLS,
	// Interim (split 1/3): bash_control keeps master's deferral until split
	// 3/3 makes it part of the static surface.
	"bash_control",
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
	// model-switch / permissions are not part of the canonical budget
	// measurement (their print gates are asserted by this spec instead), so
	// instantiate them ad hoc like dap/bash-control rather than via
	// EXTENSION_SOURCES.
	const modelSwitch = (await import("./model-switch.js")) as { default?: (api: unknown) => unknown }
	await modelSwitch.default?.(pi)
	const permissions = (await import("./permissions/index.js")) as { default?: (api: unknown) => unknown }
	await permissions.default?.(pi)
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

	it("advertises exactly the documented 20-tool surface and hides the 24 deferred tools", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		const visible = new Set(harness.active)
		expect(visible).toEqual(EXPECTED_SESSION_START_VISIBLE)
		expect(visible.size).toBe(20)

		// Deferred tools are still REGISTERED (availability preserved)…
		for (const name of EXPECTED_DEFERRED_BY_DESIGN) {
			expect(harness.registered.has(name), `${name} must stay registered`).toBe(true)
		}
		// …but never advertised at session start.
		const deferredInActive = [...EXPECTED_DEFERRED_BY_DESIGN].filter((n) => visible.has(n))
		expect(deferredInActive).toEqual([])
	})

	it("print mode drops questionnaire + set_phase at registration (set_model/submit_plan gates arrive in split 2)", async () => {
		await withPrintGate({ print: true }, async () => {
			const harness = createExposureHarness()
			await instantiateAllExtensions(harness)

			// Registration gates: unlike deferred tools, these are NOT registered
			// in --print mode — not merely hidden.
			for (const name of ["questionnaire", "set_phase"]) {
				expect(harness.registered.has(name), `${name} must not register in --print`).toBe(false)
			}

			// The remaining visible surface is the interactive spec minus the two
			// gate-outs; deferred spec is unchanged.
			const expectedVisible = new Set(
				[...EXPECTED_SESSION_START_VISIBLE].filter((n) => n !== "questionnaire" && n !== "set_phase"),
			)
			const visible = new Set(harness.active)
			expect(visible).toEqual(expectedVisible)
			expect(visible.size).toBe(18)
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
				// Multi-model print keeps set_model — the orchestrator may switch
				// roles mid-run. submit_plan registers too: its print gate arrives
				// in split 2/3.
				expect(harness.registered.has("set_model"), "set_model must register in multi-model --print").toBe(true)
				expect(harness.registered.has("submit_plan"), "submit_plan registers until split 2's print gate").toBe(true)
			})
		} finally {
			vi.mocked(resolveMultiModelEnabled).mockReturnValue({ value: false, source: "cli" })
		}
	})

	it("print + ferment-oneshot keeps submit_plan registered (planning catalog)", async () => {
		await withPrintGate({ print: true, fermentOneshot: true }, async () => {
			const harness = createExposureHarness()
			await instantiateAllExtensions(harness)
			expect(harness.registered.has("submit_plan"), "submit_plan must register in ferment-oneshot --print").toBe(true)
			expect(harness.registered.has("set_phase"), "set_phase must register in ferment-oneshot --print").toBe(true)
		})
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
		expect(votes.size).toBe(25)
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

		// Execute the registered debug_launch (real tool → mocked session registry
		// launch succeeds); the reveal anchors on the tool_result so the call id
		// is known for the in-band addedToolNames stamp.
		const launchTool = harness.registered.get("debug_launch")
		expect(launchTool).toBeDefined()
		if (!launchTool) throw new Error("debug_launch not registered")
		await launchTool.execute("call-1", { program: "app.ts" }, undefined, undefined, sessionStartPayload())
		await harness.fireEvent("tool_result", {
			toolName: "debug_launch",
			toolCallId: "call-1",
			isError: false,
		})

		for (const name of DAP_SESSION_TOOL_NAMES) {
			expect(harness.active.has(name), `${name} visible after session start`).toBe(true)
		}
		const transitionsAfterReveal = harness.activeTransitions.length
		expect(transitionsAfterReveal).toBeGreaterThan(0)

		// Second launch: guard prevents a second visibility transition.
		await launchTool.execute("call-2", { program: "app.ts" }, undefined, undefined, sessionStartPayload())
		await harness.fireEvent("tool_result", {
			toolName: "debug_launch",
			toolCallId: "call-2",
			isError: false,
		})
		expect(harness.activeTransitions.length).toBe(transitionsAfterReveal)
	})

	it("bash_control reveal round-trip exposes it exactly once on the first background handle (restored to static surface in split 3)", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		expect(harness.registered.has("bash_control"), "bash_control must be registered").toBe(true)
		expect(harness.active.has("bash_control"), "bash_control deferred until first handle").toBe(false)

		// Reveal on the first background bash result carrying a live handle.
		await harness.fireEvent("tool_result", {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "long build" },
			content: [{ type: "text", text: "still running" }],
			isError: false,
			details: { handle: "h1", checkin: true, exited: false },
		})
		expect(harness.active.has("bash_control"), "bash_control revealed on first handle").toBe(true)

		// Second handle: the reveal guard prevents a second visibility transition.
		const transitionsAfterReveal = harness.activeTransitions.length
		await harness.fireEvent("tool_result", {
			toolName: "bash",
			toolCallId: "c2",
			input: { command: "another build" },
			content: [{ type: "text", text: "still running" }],
			isError: false,
			details: { handle: "h2", checkin: true, exited: false },
		})
		expect(harness.activeTransitions.length).toBe(transitionsAfterReveal)
	})

	it("Agent reveal round-trip exposes the 3 continuation tools exactly once after the first Agent result", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		for (const name of AGENT_CONTINUATION_TOOLS) {
			expect(harness.active.has(name), `${name} hidden before any subagent`).toBe(false)
		}

		// An errored Agent result (spawn failure / budget rejection) leaves no
		// subagent in the session — it must NOT reveal the continuation tools.
		await harness.fireEvent("tool_result", {
			toolName: "Agent",
			toolCallId: "a0",
			input: { prompt: "fails", description: "test", subagent_type: "General-Purpose" },
			content: [{ type: "text", text: "spawn failed" }],
			isError: true,
		})
		for (const name of AGENT_CONTINUATION_TOOLS) {
			expect(harness.active.has(name), `${name} stays hidden after an errored Agent result`).toBe(false)
		}

		await harness.fireEvent("tool_result", {
			toolName: "Agent",
			toolCallId: "a1",
			input: { prompt: "do the thing", description: "test", subagent_type: "General-Purpose" },
			content: [{ type: "text", text: "agent result" }],
			isError: false,
			details: { agentId: "agent-1", status: "completed" },
		})

		for (const name of AGENT_CONTINUATION_TOOLS) {
			expect(harness.active.has(name), `${name} visible after the first Agent result`).toBe(true)
		}
		const transitionsAfterReveal = harness.activeTransitions.length

		// Second Agent result: reveal is one-way, no further transition.
		await harness.fireEvent("tool_result", {
			toolName: "Agent",
			toolCallId: "a2",
			input: { prompt: "more", description: "test", subagent_type: "General-Purpose" },
			content: [{ type: "text", text: "agent result" }],
			isError: false,
			details: { agentId: "agent-2", status: "completed" },
		})
		expect(harness.activeTransitions.length).toBe(transitionsAfterReveal)

		// Per-session lifecycle: a second session_start (e.g. /new in the same
		// process) must re-hide the tools — the reveal must not leak forward.
		await harness.fire("session_start", sessionStartPayload())
		for (const name of AGENT_CONTINUATION_TOOLS) {
			expect(harness.active.has(name), `${name} re-hidden in the next session`).toBe(false)
		}
	})

	it("web_fetch is visible at session start and web_search results never transition the tool set", async () => {
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		expect(harness.active.has("web_fetch"), "web_fetch visible from session start").toBe(true)
		const transitionsAtStart = harness.activeTransitions.length

		await harness.fireEvent("tool_result", {
			toolName: "web_search",
			toolCallId: "w1",
			input: { query: "test" },
			content: [{ type: "text", text: "results" }],
			isError: false,
		})
		expect(harness.activeTransitions.length).toBe(transitionsAtStart)

		// Per-session lifecycle: a second session_start keeps it visible.
		await harness.fire("session_start", sessionStartPayload())
		expect(harness.active.has("web_fetch"), "web_fetch stays visible in the next session").toBe(true)
	})

	it("agent workers keep full DAP + Agent-continuation visibility (carve-out)", async () => {
		workerState.isWorker = true
		const harness = createExposureHarness()
		await instantiateAllExtensions(harness)

		for (const name of [...DAP_ENTRY_TOOL_NAMES, ...DAP_SESSION_TOOL_NAMES, ...AGENT_CONTINUATION_TOOLS]) {
			expect(harness.active.has(name), `${name} must stay visible in workers`).toBe(true)
		}
		// The tactical deferrals (DAP entry/session tools + Agent continuations)
		// are carved out of workers — they must not hold disable votes here. The
		// LSP gate (Chunk 6) is environmental, not tactical: in a no-server
		// session the lsp tools can only ever answer "No LSP server available",
		// so the gate deliberately applies to workers too. Assert the carve-outs
		// precisely instead of a blanket zero-vote count.
		const disabled = getDisabledToolNames(harness.pi)
		for (const name of [...DAP_SESSION_TOOL_NAMES, ...AGENT_CONTINUATION_TOOLS]) {
			expect(disabled.has(name), `${name} must not be hidden in workers`).toBe(false)
		}
	})
})
