/**
 * Adapter-seam reconcile matrix for the runtime config reload (SPEC §2 H2,
 * §3.5). Driven against the real patched pi-mcp-adapter with stub
 * streamable-HTTP MCP servers; the credential store is the in-memory test
 * store. The reload handle arrives through the production sink
 * (McpAdapterOptions.reloadHandleSink) exactly the way the ACP harness
 * receives it.
 *
 * Scaffold adapted from auth-heal.test.ts (the #1574 seam suite).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import type { McpConfig, McpReloadContext, McpReloadHandle, SessionReloadOutcome } from "pi-mcp-adapter/types"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const GOOD_TOKEN = "good-bearer-token"

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let body = ""
		req.setEncoding("utf8")
		req.on("data", (chunk: string) => {
			body += chunk
		})
		req.on("end", () => {
			try {
				resolve(body === "" ? {} : (JSON.parse(body) as Record<string, unknown>))
			} catch (error) {
				reject(error)
			}
		})
	})
}

interface StubServer {
	server: Server
	url: string
	toolName: string
	counts: { initialize: number }
}

/**
 * Minimal streamable-HTTP MCP server serving one tool. `authenticated`
 * gates every request on the good bearer token (OAuth-capable shape: a 401
 * carries the protected-resource metadata pointer).
 */
function startStubMcpServer(toolName: string, authenticated = false): Promise<StubServer> {
	const counts = { initialize: 0 }
	const server = createServer(async (req, res: ServerResponse) => {
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const { pathname, searchParams } = new URL(req.url ?? "/", base)
		if (pathname === "/.well-known/oauth-protected-resource") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }))
			return
		}
		if (pathname === "/.well-known/oauth-authorization-server") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					registration_endpoint: `${base}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
				}),
			)
			return
		}
		if (pathname === "/register") {
			const body = await readJsonBody(req)
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ ...body, client_id: "stub-client-id" }))
			return
		}
		if (pathname === "/authorize") {
			const redirectUri = searchParams.get("redirect_uri")
			const target = new URL(redirectUri ?? `${base}/unused`)
			target.searchParams.set("code", "stub-auth-code")
			const state = searchParams.get("state")
			if (state !== null) target.searchParams.set("state", state)
			res.writeHead(302, { location: target.toString() })
			res.end()
			return
		}
		if (pathname === "/token") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ access_token: GOOD_TOKEN, token_type: "Bearer", expires_in: 3600 }))
			return
		}
		const authed = !authenticated || req.headers.authorization === `Bearer ${GOOD_TOKEN}`
		const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
		const id = (body.id as string | number | null) ?? null
		const respond = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
		}
		if (!authed) {
			res.writeHead(401, {
				"content-type": "application/json",
				"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
			})
			res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }))
			return
		}
		if (body.method === "initialize") {
			counts.initialize += 1
			respond({
				protocolVersion: (body.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: toolName, version: "1.0.0" },
			})
			return
		}
		if (body.method === "notifications/initialized") {
			res.writeHead(202)
			res.end()
			return
		}
		if (body.method === "tools/list") {
			respond({
				tools: [
					{
						name: toolName,
						description: `Tool ${toolName}.`,
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			})
			return
		}
		if (body.method === "tools/call") {
			const args = (body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}
			respond({ content: [{ type: "text", text: `${toolName}:${String(args.text ?? "")}` }], isError: false })
			return
		}
		respond({})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({ server, url: `http://127.0.0.1:${port}/mcp`, toolName, counts })
		})
	})
}

async function closeStub(stub: StubServer): Promise<void> {
	stub.server.closeAllConnections()
	await new Promise<void>((resolve) => stub.server.close(() => resolve()))
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n")
}

interface GatewayResult {
	content: Array<{ type: string; text?: string }>
	details?: Record<string, unknown>
}

describe("MCP runtime config reload (adapter seam)", () => {
	let homeDir: string
	let agentDir: string
	let cwd: string
	const openStubs: StubServer[] = []

	beforeAll(() => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-config-reload-"))
		agentDir = mkdtempSync(join(homeDir, "agent-"))
		cwd = mkdtempSync(join(homeDir, "project-"))
		vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory")
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
		// This sandbox exports KIMCHI_MANAGES_MCP_PROJECT_TRUST=1 (the kimchi
		// wrapper sets it in production); these adapter-seam tests exercise the
		// adapter's own trust machinery, so pin the stand-down OFF.
		vi.stubEnv("KIMCHI_MANAGES_MCP_PROJECT_TRUST", "")
	})

	afterAll(async () => {
		vi.unstubAllEnvs()
		await Promise.all(openStubs.map(closeStub))
		rmSync(homeDir, { recursive: true, force: true })
	})

	/**
	 * Installs the adapter the way the harness wrapper does (programmatic
	 * config + reload-handle sink) and returns the gateway plus the reload
	 * entry point. The provider, when given, re-derives the fresh config at
	 * reload time (D5).
	 */
	async function createReloadableSession(opts: {
		config?: McpConfig
		configPath?: string
		ctxOverrides?: Partial<ExtensionContext>
		overlayServerNames?: ReadonlySet<string>
		provider?: (ctx: McpReloadContext) => Promise<McpConfig | undefined> | McpConfig | undefined
	}): Promise<{
		gateway: (params: Record<string, unknown>) => Promise<GatewayResult>
		reload: (reloadOpts?: { servers?: string[] }) => Promise<SessionReloadOutcome>
		ctx: ExtensionContext
		/** Emits on the adapter's pi.events bus (e.g. MCP_RUNTIME_REGISTER_EVENT). */
		emitEvent: (channel: string, data: unknown) => void
		/** Currently registered Pi tool names (the model-facing surface). */
		listTools: () => string[]
	}> {
		const { createMcpAdapter } = await import("pi-mcp-adapter")
		const host = createExtensionApi()
		const api = {
			...host.api,
			getFlag: () => undefined,
			// Presence enables the adapter's pi-MCP integration path (project
			// config layers load only when the host declares MCP support).
			registerMcpServer: () => {
				throw new Error("registerMcpServer is not exercised by this suite")
			},
			getMcpServers: () => [],
			unregisterTool: (name: string) => {
				let removed = false
				for (let index = host.registerTool.mock.calls.length - 1; index >= 0; index -= 1) {
					if (host.registerTool.mock.calls[index]?.[0]?.name === name) {
						host.registerTool.mock.calls.splice(index, 1)
						removed = true
					}
				}
				return removed
			},
		} as unknown as typeof host.api
		const handleHolder: { handle: McpReloadHandle | null } = { handle: null }
		createMcpAdapter({
			...(opts.config !== undefined ? { config: opts.config } : {}),
			...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
			...(opts.overlayServerNames !== undefined ? { overlayServerNames: opts.overlayServerNames } : {}),
			...(opts.provider !== undefined ? { reloadProgrammaticConfigProvider: opts.provider } : {}),
			reloadHandleSink: (handle) => {
				handleHolder.handle = handle
			},
		})(api)
		const ctx = createContext({ cwd, hasUI: false, ui: undefined, ...opts.ctxOverrides })
		await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
		const gatewayTool = await vi.waitFor(
			() => {
				if (!host.getActiveToolNames().includes("mcp")) throw new Error("gateway tool not registered yet")
				return host.getRegisteredTool("mcp")
			},
			{ timeout: 10_000, interval: 50 },
		)
		return {
			ctx,
			emitEvent: (channel, data) => {
				host.api.events.emit(channel, data)
			},
			// Track the call LOG, not the mock's map: the factory's unregisterTool
			// override splices unregistered names out of registerTool.mock.calls
			// (that splice is the seam the adapter's direct-tool resync uses).
			listTools: () => [...new Set(host.registerTool.mock.calls.map(([tool]) => tool.name))],
			gateway: async (params) =>
				(await gatewayTool.execute(
					`test-${Math.random().toString(36).slice(2)}`,
					params,
					undefined,
					undefined,
					ctx as ExtensionToolContext,
				)) as GatewayResult,
			reload: async (reloadOpts) => {
				// The sink fires at initializeMcp finalization — a step after the
				// gateway tool registers, so poll briefly rather than failing fast.
				await vi.waitFor(
					() => {
						if (!handleHolder.handle) throw new Error("reload handle was not registered (yet)")
					},
					{ timeout: 15_000, interval: 50 },
				)
				const handle = handleHolder.handle
				if (!handle) throw new Error("reload handle missing after waitFor")
				return handle.reload(reloadOpts)
			},
		}
	}

	async function callTool(
		gateway: (params: Record<string, unknown>) => Promise<GatewayResult>,
		server: string,
		tool: string,
	): Promise<GatewayResult> {
		return gateway({ tool, server, args: { text: "hi" } })
	}

	function readCacheServers(): Record<string, { configHash?: string; tools?: unknown[] }> {
		const cachePath = join(agentDir, "mcp-cache.json")
		if (!existsSync(cachePath)) return {}
		const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as {
			servers?: Record<string, { configHash?: string; tools?: unknown[] }>
		}
		return raw.servers ?? {}
	}

	it("add: registers lazily — no connection during apply, materializes on first touch", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy" },
					beta: { url: stubB.url, lifecycle: "lazy" },
				},
			}),
		})

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.added).toEqual(["beta"])

		// LAZY: nothing connected during apply.
		const status = await session.gateway({})
		expect(status.details?.connectedCount).toBe(0)

		// First touch materializes the connection (#1574 gates).
		const call = await callTool(session.gateway, "beta", "beta_tool")
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("beta_tool:hi")
	}, 60_000)

	it("remove: eager teardown, deferred-catalog eviction, and residue cleanup", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		openStubs.push(stubA)
		const session = await createReloadableSession({
			config: {
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy" },
					keep: { url: stubA.url, lifecycle: "lazy" },
				},
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: { keep: { url: stubA.url, lifecycle: "lazy" } },
			}),
		})

		// Connect alpha so the teardown has a live connection to close.
		const call = await callTool(session.gateway, "alpha", "alpha_tool")
		expect(call.details?.error).toBeUndefined()
		expect((await session.gateway({})).details?.connectedCount).toBe(1)

		// Seed a cache entry so the eviction has something to remove.
		expect(Object.keys(readCacheServers())).toContain("alpha")

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.removed).toEqual(["alpha"])
		expect(outcome.unchanged).toEqual(["keep"])

		// Connection torn down and the server is gone from the live surface.
		const status = await session.gateway({})
		expect(status.details?.connectedCount).toBe(0)
		expect(textOf(status)).not.toContain("alpha")
		// Deferred catalog evicted from the persisted cache.
		expect(Object.keys(readCacheServers())).not.toContain("alpha")
	}, 60_000)

	it("disabled flip both ways: teardown keeps config + cache; re-enable reports added", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		openStubs.push(stubA)
		const base = { url: stubA.url, lifecycle: "lazy" as const }
		// One session; the provider flips the definition between reloads.
		let next: McpConfig["mcpServers"] = { alpha: base }
		const session = await createReloadableSession({
			config: { mcpServers: { alpha: base }, settings: { directTools: false, toolPrefix: "none" } },
			provider: async () => ({ mcpServers: next }),
		})

		await callTool(session.gateway, "alpha", "alpha_tool")
		expect(Object.keys(readCacheServers())).toContain("alpha")

		// disabled:false→true — surface teardown, entry + cache kept.
		next = { alpha: { ...base, disabled: true } }
		const disable = await session.reload()
		expect(disable.status).toBe("applied")
		expect(disable.changed).toEqual(["alpha"])
		expect((await session.gateway({})).details?.connectedCount).toBe(0)
		expect(Object.keys(readCacheServers())).toContain("alpha")

		// The disabled entry stays; a same-definition reload reports unchanged.
		const stillThere = await session.reload()
		expect(stillThere.unchanged).toEqual(["alpha"])

		// Re-enable — classified with the added path (lazy materialization).
		next = { alpha: base }
		const enable = await session.reload()
		expect(enable.status).toBe("applied")
		expect(enable.added).toEqual(["alpha"])
	}, 60_000)

	it("changed transport: eager reconnect — the next call hits the new definition", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({ mcpServers: { alpha: { url: stubB.url, lifecycle: "lazy" } } }),
		})

		await callTool(session.gateway, "alpha", "alpha_tool")

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.changed).toEqual(["alpha"])
		expect(outcome.needsAuth).toEqual([])

		// EAGER: the reconnect happened during apply — stubB saw an initialize.
		await vi.waitFor(
			() => {
				if (stubB.counts.initialize === 0) throw new Error("reconnect did not reach the new server yet")
			},
			{ timeout: 10_000, interval: 50 },
		)

		// The next call serves from the NEW definition.
		const call = await callTool(session.gateway, "alpha", "beta_tool")
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("beta_tool:hi")
	}, 60_000)

	it("changed exposure only: connection identity preserved, registry re-synced", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		openStubs.push(stubA)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy", description: "new description" } },
			}),
		})

		await callTool(session.gateway, "alpha", "alpha_tool")
		const initializesBefore = stubA.counts.initialize
		expect(initializesBefore).toBeGreaterThanOrEqual(1)

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.changed).toEqual(["alpha"])

		// No reconnect: the healthy connection survived (no new initialize).
		expect(stubA.counts.initialize).toBe(initializesBefore)
		expect((await session.gateway({})).details?.connectedCount).toBe(1)
	}, 60_000)

	it("blocked project server stays blocked on reload — trust gate preserved, never connected", async () => {
		const stubA = await startStubMcpServer("proj_tool")
		openStubs.push(stubA)
		// File-backed mode: the shared-project layer (.mcp.json, kind "project")
		// is what the adapter tracks for per-server trust (the .kimchi compat
		// layer loads as imports and is gated host-side in kimchi — covered by
		// the wrapper-level fail-closed test in index.test.ts). The project is
		// untrusted, so the adapter's own trust pass blocks proj at install and
		// must re-block it on every reload.
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { url: stubA.url } } }), "utf-8")
		const sharedConfigPath = join(agentDir, "mcp.json")
		writeFileSync(sharedConfigPath, JSON.stringify({ mcpServers: {} }), "utf-8")

		const session = await createReloadableSession({
			configPath: sharedConfigPath,
			ctxOverrides: { isProjectTrusted: () => false },
		})

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.blocked).toHaveLength(1)
		expect(outcome.blocked[0]?.name).toBe("proj")
		expect(outcome.blocked[0]?.blockedReason).toBeTruthy()

		// Never connected — not during apply, and not on touch.
		const status = await session.gateway({})
		expect(status.details?.connectedCount).toBe(0)
		// The blocked (disabled-by-trust) entry stays visible in the surface.
		expect(textOf(status)).toContain("proj")
		expect(textOf(status)).toContain("1 disabled")
		const call = await callTool(session.gateway, "proj", "proj_tool")
		expect(call.details?.error).toBeDefined()
	}, 60_000)

	it("runtime-registered servers survive a hot-apply — never classified removed", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubR = await startStubMcpServer("runtime_tool")
		openStubs.push(stubA, stubR)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
			}),
		})

		// Runtime-register the way pi.registerMcpServer / the built-in gateway
		// does: the entry lives only in state (the reload diff's config sides
		// never mention it) and the registration survives in runtimeServers.
		const request: { version: number; name: string; definition: Record<string, unknown>; result?: { ok: boolean } } = {
			version: 1,
			name: "runtime-one",
			definition: { url: stubR.url, lifecycle: "lazy" },
		}
		session.emitEvent("pi-mcp-adapter:runtime-register:v1", request)
		expect(request.result?.ok).toBe(true)

		// Materialize the connection so a buggy removal would have something to
		// tear down — and something to check for afterwards.
		const before = await callTool(session.gateway, "runtime-one", "runtime_tool")
		expect(before.details?.error).toBeUndefined()

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.removed).toEqual([])
		expect(outcome.unchanged).toEqual(expect.arrayContaining(["alpha", "runtime-one"]))

		// Connection kept; still callable after the reload.
		const after = await callTool(session.gateway, "runtime-one", "runtime_tool")
		expect(after.details?.error).toBeUndefined()
		expect(textOf(after)).toContain("runtime_tool:hi")
	}, 60_000)

	it("blocked path re-syncs the tool surface — previously-direct tools unregister in the same pass", async () => {
		const stubA = await startStubMcpServer("proj_tool")
		openStubs.push(stubA)
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { proj: { url: stubA.url, lifecycle: "lazy" } } }),
			"utf-8",
		)
		const sharedConfigPath = join(agentDir, "mcp.json")
		writeFileSync(
			sharedConfigPath,
			// user-global policy "allow" is what a trusted non-interactive session
			// needs for project-layer servers to be live (no per-server approval).
			JSON.stringify({ mcpServers: {}, settings: { directTools: true, toolPrefix: "auto", projectServers: "allow" } }),
			"utf-8",
		)
		let trusted = true
		const session = await createReloadableSession({
			configPath: sharedConfigPath,
			ctxOverrides: { isProjectTrusted: () => trusted },
		})

		// Live connection + registered direct tools while trusted.
		const call = await callTool(session.gateway, "proj", "proj_tool")
		expect(call.details?.error).toBeUndefined()
		await vi.waitFor(
			() => {
				if (!session.listTools().some((name) => name.includes("proj"))) {
					throw new Error("proj direct tool not registered yet")
				}
			},
			{ timeout: 10_000, interval: 50 },
		)

		// Revoke trust mid-session: the reload re-resolves trust, classifies proj
		// as blocked, and must drop its model-facing direct tools in the same pass.
		trusted = false
		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.blocked[0]?.name).toBe("proj")
		expect(session.listTools().filter((name) => name.includes("proj"))).toEqual([])
	}, 60_000)

	it("callerServers overlays survive base removal and are never disconnected", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			// The harness merges caller overlays into the config before install.
			config: {
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy" },
					beta: { url: stubB.url, lifecycle: "lazy" },
				},
				settings: { directTools: false, toolPrefix: "none" },
			},
			overlayServerNames: new Set(["beta"]),
			provider: async () => ({ mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } } }),
		})

		await callTool(session.gateway, "beta", "beta_tool")
		expect((await session.gateway({})).details?.connectedCount).toBe(1)

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		// The overlay is filtered from both diff sides: base config changes (here
		// the fresh selection no longer carries beta at all) never remove it, and
		// alpha itself is unchanged.
		expect(outcome.removed).toEqual([])
		expect([...outcome.unchanged].sort()).toEqual(["alpha", "beta"])

		// The overlay's connection survived and its config entry is intact.
		expect((await session.gateway({})).details?.connectedCount).toBe(1)
		expect(textOf(await session.gateway({}))).toContain("beta")
	}, 60_000)

	it("directToolsFrozen + tool-set-changing diff: refused with zero mutations", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none", freezeDirectTools: true },
			},
			provider: async () => ({
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy" },
					beta: { url: stubB.url, lifecycle: "lazy" },
				},
			}),
		})

		const outcome = await session.reload()
		expect(outcome.status).toBe("refused")
		expect(outcome.reason).toBe("direct_tools_frozen")

		// Zero mutations: beta was never registered.
		const status = await session.gateway({})
		expect(textOf(status)).not.toContain("beta")
		const call = await callTool(session.gateway, "beta", "beta_tool")
		expect(call.details?.error).toBeDefined()
	}, 60_000)

	it("directToolsFrozen + transport-only diff: applies (registry does not churn)", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stubA.url, lifecycle: "lazy" } },
				settings: { directTools: false, toolPrefix: "none", freezeDirectTools: true },
			},
			provider: async () => ({ mcpServers: { alpha: { url: stubB.url, lifecycle: "lazy" } } }),
		})

		await callTool(session.gateway, "alpha", "alpha_tool")

		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.changed).toEqual(["alpha"])
		await vi.waitFor(
			() => {
				if (stubB.counts.initialize === 0) throw new Error("reconnect did not reach the new server yet")
			},
			{ timeout: 10_000, interval: 50 },
		)
	}, 60_000)

	it("per-server failure: error bucket, other servers still apply", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const dying = await startStubMcpServer("dying_tool")
		openStubs.push(stubA, dying)
		const session = await createReloadableSession({
			config: {
				mcpServers: {
					good: { url: stubA.url, lifecycle: "lazy" },
					dying: { url: dying.url, lifecycle: "lazy" },
				},
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: {
					good: { url: stubA.url, lifecycle: "lazy", description: "changed" },
					// Transport-class change to a dead endpoint forces a failing eager reconnect.
					dying: { url: dying.url, lifecycle: "lazy", headers: { "X-Change": "transport" } },
				},
			}),
		})

		// Establish a live connection for `dying`, then kill its server so the
		// eager reconnect fails while `good` still applies.
		await callTool(session.gateway, "dying", "dying_tool")
		await closeStub(dying)

		const outcome = await session.reload()
		expect(outcome.status).toBe("error")
		expect(outcome.serverErrors.map((entry) => entry.name)).toEqual(["dying"])
		expect(outcome.changed).toContain("good")
	}, 60_000)

	it("servers scope: out-of-scope changes are untouched and unreported", async () => {
		const stubA = await startStubMcpServer("alpha_tool")
		const stubB = await startStubMcpServer("beta_tool")
		openStubs.push(stubA, stubB)
		const session = await createReloadableSession({
			config: {
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy" },
					beta: { url: stubB.url, lifecycle: "lazy" },
				},
				settings: { directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: {
					alpha: { url: stubA.url, lifecycle: "lazy", description: "changed" },
					beta: { url: stubB.url, lifecycle: "lazy", description: "also changed" },
				},
			}),
		})

		await callTool(session.gateway, "alpha", "alpha_tool")
		// Beta was discovery-connected at init; the scoped reload must add no new connects.
		const betaInitializesBefore = stubB.counts.initialize

		const outcome = await session.reload({ servers: ["alpha"] })
		expect(outcome.status).toBe("applied")
		expect(outcome.changed).toEqual(["alpha"])
		// Beta untouched: no reconnect, no diff entry.
		expect(stubB.counts.initialize).toBe(betaInitializesBefore)
	}, 60_000)

	it("needs-auth with a pending interactive flow: reconnect skipped, reported in needsAuth", async () => {
		const stub = await startStubMcpServer("alpha_tool", true)
		openStubs.push(stub)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stub.url, lifecycle: "lazy", auth: "oauth" } },
				settings: { autoAuth: false, directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: {
					alpha: { url: stub.url, lifecycle: "lazy", auth: "oauth", headers: { "X-Change": "transport" } },
				},
			}),
		})

		// First touch lands the connection in needs-auth (no token yet).
		await callTool(session.gateway, "alpha", "alpha_tool")

		// An interactive flow takes ownership (the gateway's auth-start path).
		const started = await session.gateway({ action: "auth-start", server: "alpha" })
		expect(started.details?.authorizationUrl).toBeTruthy()

		// Reload while the flow is pending: the reconnect is skipped, never raced.
		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.needsAuth).toEqual(["alpha"])

		// Complete the flow; the definition swap heals on the next touch (#1574).
		const consent = await fetch(started.details?.authorizationUrl as string, { redirect: "manual" })
		const redirectUrl = consent.headers.get("location")
		expect(redirectUrl).toContain("code=")
		const completed = await session.gateway({ action: "auth-complete", server: "alpha", args: { redirectUrl } })
		expect(completed.details?.error).toBeUndefined()
		const call = await callTool(session.gateway, "alpha", "alpha_tool")
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("alpha_tool:hi")
	}, 60_000)

	it("reload while a server sits in needs-auth completes and reports it (auth-heal companion)", async () => {
		const stub = await startStubMcpServer("alpha_tool", true)
		openStubs.push(stub)
		const session = await createReloadableSession({
			config: {
				mcpServers: { alpha: { url: stub.url, lifecycle: "lazy", auth: "oauth" } },
				settings: { autoAuth: false, directTools: false, toolPrefix: "none" },
			},
			provider: async () => ({
				mcpServers: {
					alpha: { url: stub.url, lifecycle: "lazy", auth: "oauth", headers: { "X-Change": "transport" } },
				},
			}),
		})

		// Server sits in needs-auth (no pending interactive flow — nobody owns it).
		await callTool(session.gateway, "alpha", "alpha_tool")

		// An out-of-band grant lands (the same store write auth-complete performs).
		const { updateMcpOAuthTokensForUrl } = await import("pi-mcp-adapter/oauth")
		await updateMcpOAuthTokensForUrl("alpha", stub.url, { accessToken: GOOD_TOKEN })

		// The reload's eager reconnect re-reads the shared credential store and succeeds.
		const outcome = await session.reload()
		expect(outcome.status).toBe("applied")
		expect(outcome.changed).toEqual(["alpha"])
		expect(outcome.needsAuth).toEqual([])

		// Connected and serving the fresh definition.
		const call = await callTool(session.gateway, "alpha", "alpha_tool")
		expect(call.details?.error).toBeUndefined()
		expect(textOf(call)).toContain("alpha_tool:hi")
	}, 60_000)
})
