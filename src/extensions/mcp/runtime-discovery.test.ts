import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpAdapter } from "pi-mcp-adapter"
import type { ServerEntry } from "pi-mcp-adapter/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createKimchiMcpAdapterExtension } from "./index.js"

type Method = "initialize" | "tools/list" | "tools/call" | "tasks/get"
type TextResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: { error?: string } }

async function startFixture(options: { tasks?: boolean } = {}) {
	const counts: Record<Method, number> = { initialize: 0, "tools/list": 0, "tools/call": 0, "tasks/get": 0 }
	let failInitialize = false
	let listGate: Promise<void> | undefined
	let releaseList: (() => void) | undefined
	let callGate: Promise<void> | undefined
	let releaseCall: (() => void) | undefined
	let taskGetDelayMs = 0
	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(405)
			res.end()
			return
		}
		let raw = ""
		for await (const chunk of req) raw += String(chunk)
		const body = JSON.parse(raw)
		const respond = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }))
		}
		if (body.method === "initialize") {
			counts.initialize++
			if (failInitialize) {
				res.writeHead(503)
				res.end()
				return
			}
			respond({
				protocolVersion: body.params.protocolVersion,
				capabilities: {
					tools: {},
					...(options.tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}),
				},
				serverInfo: { name: "gateway-discovery-fixture", version: "1.0.0" },
			})
		} else if (body.method === "notifications/initialized") {
			res.writeHead(202)
			res.end()
		} else if (options.tasks && body.method === "server/discover") {
			respond({
				supportedVersions: ["2026-07-28"],
				capabilities: {
					tools: {},
					...(options.tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}),
				},
			})
		} else if (body.method === "tools/list") {
			counts["tools/list"]++
			await listGate
			respond({
				...(options.tasks ? { resultType: "complete" as const, ttlMs: 0, cacheScope: "private" as const } : {}),
				tools: [
					{
						name: "atlassian_get_issue",
						description: "Get a Jira issue",
						inputSchema: { type: "object", properties: { key: { type: "string" } } },
					},
				],
			})
		} else if (body.method === "tools/call") {
			counts["tools/call"]++
			await callGate
			if (options.tasks) {
				const now = new Date().toISOString()
				respond({
					resultType: "task",
					taskId: "t-1",
					status: "working",
					createdAt: now,
					lastUpdatedAt: now,
					ttlMs: null,
					pollIntervalMs: 10,
				})
			} else {
				respond({ content: [{ type: "text", text: "PROJ-123" }], isError: false })
			}
		} else if (options.tasks && body.method === "tasks/get") {
			counts["tasks/get"]++
			if (taskGetDelayMs > 0) {
				const delay = taskGetDelayMs
				taskGetDelayMs = 0
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
			const now = new Date().toISOString()
			respond({
				resultType: "complete",
				taskId: "t-1",
				status: "completed",
				result: {
					resultType: "complete",
					ttlMs: 0,
					cacheScope: "private",
					content: [{ type: "text", text: "PROJ-123" }],
					isError: false,
				},
				createdAt: now,
				lastUpdatedAt: now,
				ttlMs: null,
			})
		} else {
			respond({})
		}
	})
	const url = await new Promise<string>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
		})
	})
	return {
		server,
		url,
		counts,
		failInitialize: () => {
			failInitialize = true
		},
		blockLists: () => {
			listGate = new Promise<void>((resolve) => {
				releaseList = resolve
			})
		},
		blockCalls: () => {
			callGate = new Promise<void>((resolve) => {
				releaseCall = resolve
			})
		},
		delayLists: (ms: number) => {
			listGate = new Promise<void>((resolve) => {
				releaseList = resolve
			})
			setTimeout(() => {
				releaseList?.()
				listGate = undefined
			}, ms)
		},
		delayCalls: (ms: number) => {
			callGate = new Promise<void>((resolve) => {
				releaseCall = resolve
			})
			setTimeout(() => {
				releaseCall?.()
				callGate = undefined
			}, ms)
		},
		delayTaskGets: (ms: number) => {
			taskGetDelayMs = ms
		},
		releaseLists: () => {
			releaseList?.()
			listGate = undefined
			releaseCall?.()
			callGate = undefined
			taskGetDelayMs = 0
		},
	}
}

// Discovery requests must finish inside DISCOVERY_TIMEOUT_MS, so it needs a wide
// margin on a loaded CI runner. Later requests are held for longer than that, so
// they only succeed when the normal timeout was restored after discovery.
const DISCOVERY_TIMEOUT_MS = 1_000
// Derived, so the delay can never drop to or below the discovery timeout.
const SLOWER_THAN_DISCOVERY_MS = DISCOVERY_TIMEOUT_MS + 500
const NORMAL_TIMEOUT_MS = 30_000
const SLOW_TEST_TIMEOUT_MS = 15_000

async function settle() {
	await new Promise((resolve) => setImmediate(resolve))
	await new Promise((resolve) => setImmediate(resolve))
}

describe("built-in gateway discovery", () => {
	let rootDir: string
	let fixture: Awaited<ReturnType<typeof startFixture>>
	let host: ReturnType<typeof createExtensionApi>
	let ctx: ReturnType<typeof createToolContext>

	beforeEach(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "kimchi-gateway-discovery-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", join(rootDir, "agent"))
		vi.stubEnv("HOME", rootDir)
		fixture = await startFixture()
		host = createExtensionApi()
		ctx = createToolContext({ cwd: rootDir, hasUI: false })
	})

	afterEach(async () => {
		fixture.releaseLists()
		await host.emit("session_shutdown", { type: "session_shutdown" }, ctx)
		fixture.server.closeAllConnections()
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
		vi.unstubAllEnvs()
		rmSync(rootDir, { recursive: true, force: true })
	})

	function installHost(lazyGatewayConnect = false, entryOverrides: Partial<ServerEntry> = {}) {
		const extension = createKimchiMcpAdapterExtension({
			cwd: rootDir,
			suppressWarnings: true,
			lazyGatewayConnect,
			builtinGateway: {
				name: "gateway",
				entry: {
					url: fixture.url,
					headers: { Authorization: "Bearer fixture-secret" },
					lifecycle: "keep-alive",
					...entryOverrides,
				},
			},
		})
		extension(host.api)
		return () => host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
	}

	function startHost(lazyGatewayConnect = false, entryOverrides: Partial<ServerEntry> = {}) {
		return installHost(lazyGatewayConnect, entryOverrides)()
	}

	function writeConfig(config: Record<string, unknown>) {
		mkdirSync(join(rootDir, "agent"), { recursive: true })
		writeFileSync(join(rootDir, "agent", "mcp.json"), JSON.stringify(config))
	}

	async function waitFor(method: Method) {
		await vi.waitFor(
			() => {
				expect(fixture.counts[method]).toBeGreaterThan(0)
			},
			{ timeout: 10_000, interval: 20 },
		)
	}

	async function search(server = "gateway") {
		const mcp = await vi.waitFor(() => host.getRegisteredTool("mcp"), { timeout: 10_000, interval: 20 })
		const result = (await mcp.execute(
			"gateway-search",
			{ search: "atlassian", server },
			undefined,
			undefined,
			ctx,
		)) as TextResult
		return result.content.map((entry) => entry.text).join("\n")
	}

	async function callFixtureTool() {
		const mcp = await vi.waitFor(() => host.getRegisteredTool("mcp"), { timeout: 10_000, interval: 20 })
		return (await mcp.execute(
			"gateway-call",
			{ tool: "atlassian_get_issue", server: "gateway", args: { key: "PROJ-123" } },
			undefined,
			undefined,
			ctx,
		)) as TextResult
	}

	it("keeps the main-session keep-alive registration converging before the model turn", async () => {
		await startHost()
		await host.emit("input", {}, ctx)
		expect(await search()).toContain("atlassian_get_issue")
		const result = await callFixtureTool()
		expect(result.isError).not.toBe(true)
		expect(fixture.counts["tools/call"]).toBe(1)
		expect(fixture.counts.initialize).toBe(1)
	}, 15_000)

	it("publishes a lazy child's catalog without explicit connect and closes discovery before tool use", async () => {
		await startHost(true)
		expect(await search()).toContain("atlassian_get_issue")
		expect(fixture.counts["tools/list"]).toBe(1)
		expect(host.getRegisteredTools().map((tool) => tool.name)).not.toContain("gateway_atlassian_get_issue")
		const result = await callFixtureTool()
		expect(result.isError).not.toBe(true)
		expect(fixture.counts["tools/call"]).toBe(1)
		expect(fixture.counts.initialize).toBe(2)
	})

	it("holds the lazy child's first input until deferred metadata discovery completes", async () => {
		fixture.blockLists()
		await startHost(true)
		await waitFor("tools/list")
		let inputSettled = false
		const input = host.emit("input", {}, ctx).finally(() => {
			inputSettled = true
		})
		await settle()
		expect(inputSettled).toBe(false)
		fixture.releaseLists()
		await input
		expect(await search()).toContain("atlassian_get_issue")
	})

	it("contains lazy discovery failure without preventing session start", async () => {
		fixture.failInitialize()
		await startHost(true)
		expect(await search()).toContain('Server "gateway" not available')
	})

	it("closes lazy discovery even when global idle timeout is zero", async () => {
		writeConfig({ mcpServers: {}, settings: { idleTimeout: 0 } })
		await startHost(true)
		expect(await search()).toContain("atlassian_get_issue")
		const result = await callFixtureTool()
		expect(result.isError).not.toBe(true)
		expect(fixture.counts.initialize).toBe(2)
	})

	it("rediscovers the lazy child's gateway despite a valid but empty cached catalog", async () => {
		await startHost()
		expect(await search()).toContain("atlassian_get_issue")
		const cachePath = join(rootDir, "agent", "mcp-cache.json")
		const cache = JSON.parse(readFileSync(cachePath, "utf8"))
		expect(cache.servers?.gateway?.tools?.length).toBeGreaterThan(0)
		cache.servers.gateway.tools = []
		writeFileSync(cachePath, JSON.stringify(cache))
		host = createExtensionApi()
		await startHost(true)
		expect(await search()).toContain("atlassian_get_issue")
	})

	it("contains a deferred discovery timeout inside the first-input wait", async () => {
		fixture.blockLists()
		await startHost(true, { requestTimeoutMs: 25 })
		await host.emit("input", {}, ctx)
		expect(await search()).toContain('Server "gateway" not available')
	})

	it("reloads file-backed config when a lazy child resumes", async () => {
		writeConfig({ mcpServers: {} })
		const start = installHost(true)
		await start()
		await host.emit("session_shutdown", { type: "session_shutdown" }, ctx)
		writeConfig({ mcpServers: { extra: { url: fixture.url } } })
		await start()
		expect(await search("extra")).toContain("atlassian_get_issue")
	})

	it("installs through file-backed config without persisting the runtime gateway or credentials", async () => {
		writeConfig({ mcpServers: {} })
		await startHost(true)
		const mcp = await vi.waitFor(() => host.getRegisteredTool("mcp"), { timeout: 10_000, interval: 20 })
		const result = (await mcp.execute(
			"gateway-install",
			{ action: "install", url: `${fixture.url}/other`, target: "global", server: "extra" },
			undefined,
			undefined,
			ctx,
		)) as TextResult
		expect(result.isError).not.toBe(true)
		const saved = readFileSync(join(rootDir, "agent", "mcp.json"), "utf8")
		expect(saved).toContain('"extra"')
		expect(saved).not.toContain('"gateway"')
		expect(saved).not.toContain("fixture-secret")
	})

	it(
		"restores normal request timeouts on resident initial runtime connections",
		async () => {
			createMcpAdapter({
				config: {
					mcpServers: {},
					settings: { autoAuth: false, directTools: false, requestTimeoutMs: NORMAL_TIMEOUT_MS },
				},
				initialRuntimeServers: { gateway: { url: fixture.url, lifecycle: "lazy", idleTimeout: 0 } },
				initialRuntimeDiscoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
			})(host.api)
			await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
			await host.emit("input", {}, ctx)
			fixture.delayCalls(SLOWER_THAN_DISCOVERY_MS)
			const result = await callFixtureTool()
			expect(result.details?.error).toBeUndefined()
			expect(result.content.some((entry) => entry.text?.includes("PROJ-123"))).toBe(true)
			expect(fixture.counts["tools/call"]).toBe(1)
		},
		SLOW_TEST_TIMEOUT_MS,
	)

	it(
		"restores normal task-channel timeouts on resident initial runtime connections",
		async () => {
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
			fixture = await startFixture({ tasks: true })
			createMcpAdapter({
				config: { mcpServers: {}, settings: { autoAuth: false, directTools: false } },
				defaultProtocolVersion: "2026-07-28",
				initialRuntimeServers: { gateway: { url: fixture.url, lifecycle: "lazy", idleTimeout: 0 } },
				initialRuntimeDiscoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
			})(host.api)
			await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
			await host.emit("input", {}, ctx)
			fixture.delayTaskGets(SLOWER_THAN_DISCOVERY_MS)
			const result = await callFixtureTool()
			expect(result.details?.error).toBeUndefined()
			expect(result.content.some((entry) => entry.text?.includes("PROJ-123"))).toBe(true)
			expect(fixture.counts["tasks/get"]).toBe(1)
		},
		SLOW_TEST_TIMEOUT_MS,
	)

	it(
		"does not apply runtime discovery timeout to a configured server with the same name",
		async () => {
			createMcpAdapter({
				config: {
					mcpServers: { gateway: { url: fixture.url, requestTimeoutMs: NORMAL_TIMEOUT_MS } },
					settings: { autoAuth: false, directTools: false },
				},
				initialRuntimeServers: { gateway: { url: `${fixture.url}/other` } },
				initialRuntimeDiscoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
			})(host.api)
			await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
			fixture.delayLists(SLOWER_THAN_DISCOVERY_MS)
			await host.emit("input", {}, ctx)
			expect(await search()).toContain("atlassian_get_issue")
		},
		SLOW_TEST_TIMEOUT_MS,
	)
})
