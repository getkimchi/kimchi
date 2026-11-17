import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { KIMCHI_PROVIDER_ID } from "../../kimchi-provider.js"
import { createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

vi.mock("../../config.js", () => ({
	getEnvironmentApiKey: () => undefined,
	readApiKeyFromConfigFile: () => undefined,
	resolveEndpoints: () => ({ castApiUrl: "https://gateway.invalid" }),
}))

vi.mock("../../resources/store.js", () => ({
	isResourceEnabled: () => true,
}))

const FIRST_TOKEN = "first-provider-token"
const ROTATED_TOKEN = "rotated-provider-token"
const ORG_ID = "provider-org"

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let body = ""
	for await (const chunk of req) body += String(chunk)
	return JSON.parse(body) as Record<string, unknown>
}

interface CapturedHeaders {
	authorization: string | undefined
	organizationId: string | undefined
}

function startMcpServer(): Promise<{ server: Server; url: string; toolCalls: CapturedHeaders[] }> {
	const toolCalls: CapturedHeaders[] = []
	const server = createServer(async (req, res: ServerResponse) => {
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" })
			res.end()
			return
		}
		const body = await readJsonBody(req)
		const id = (body.id as string | number | null) ?? null
		const respond = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
		}
		if (body.method === "initialize") {
			respond({
				protocolVersion: (body.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "provider-auth-fixture", version: "1.0.0" },
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
						name: "echo",
						description: "Return the supplied text.",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			})
			return
		}
		if (body.method === "tools/call") {
			toolCalls.push({
				authorization: req.headers.authorization,
				organizationId: req.headers["x-castai-organization-id"] as string | undefined,
			})
			const args = (body.params as { arguments?: { text?: string } } | undefined)?.arguments
			respond({ content: [{ type: "text", text: args?.text ?? "" }], isError: false })
			return
		}
		respond({})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({ server, url: `http://127.0.0.1:${port}/mcp`, toolCalls })
		})
	})
}

describe("org-gateway provider authentication", () => {
	let rootDir: string
	let cwd: string
	let stub: Awaited<ReturnType<typeof startMcpServer>>

	beforeAll(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-provider-auth-"))
		cwd = join(rootDir, "project")
		const agentDir = join(rootDir, "agent")
		mkdirSync(cwd)
		mkdirSync(agentDir)
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ [KIMCHI_PROVIDER_ID]: { type: "oauth", access: FIRST_TOKEN, refresh: "r", orgId: ORG_ID } }),
		)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
		vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory")
		stub = await startMcpServer()
	})

	afterAll(async () => {
		vi.unstubAllEnvs()
		stub.server.closeAllConnections()
		await new Promise<void>((resolve) => stub.server.close(() => resolve()))
		rmSync(rootDir, { recursive: true, force: true })
	})

	it("resolves the current provider token on each request and retains the organization header", async () => {
		const { buildBuiltinGatewayServer, GATEWAY_SERVER_NAME } = await import("./gateway.js")
		const gateway = buildBuiltinGatewayServer()
		if (!gateway) throw new Error("expected the built-in gateway entry")
		const { createMcpAdapter } = await import("pi-mcp-adapter")
		let currentToken = FIRST_TOKEN
		const providerToken = vi.fn(async (provider: string) => {
			expect(provider).toBe(KIMCHI_PROVIDER_ID)
			return currentToken
		})
		const ctx = createToolContext({
			cwd,
			hasUI: false,
			ui: undefined,
			modelRegistry: { getApiKeyForProvider: providerToken },
		})
		const host = createExtensionApi()
		createMcpAdapter({
			config: {
				mcpServers: {
					[gateway.name]: { ...gateway.entry, url: stub.url },
				},
				settings: { autoAuth: false, directTools: false, toolPrefix: "none" },
			},
		})(host.api)
		await host.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
		const mcp = await vi.waitFor(
			() => {
				if (!host.getActiveToolNames().includes("mcp")) throw new Error("gateway tool not registered yet")
				return host.getRegisteredTool("mcp")
			},
			{ timeout: 10_000, interval: 50 },
		)
		const call = async (text: string) =>
			(await mcp.execute(
				`provider-auth-${text}`,
				{ tool: "echo", server: GATEWAY_SERVER_NAME, args: { text } },
				undefined,
				undefined,
				ctx,
			)) as { content: Array<{ type: string; text?: string }> }

		const first = await call("first")
		expect(first.content[0]?.text).toBe("first")
		currentToken = ROTATED_TOKEN
		const rotated = await call("rotated")
		expect(rotated.content[0]?.text).toBe("rotated")

		expect(stub.toolCalls).toEqual([
			{ authorization: `Bearer ${FIRST_TOKEN}`, organizationId: ORG_ID },
			{ authorization: `Bearer ${ROTATED_TOKEN}`, organizationId: ORG_ID },
		])
		expect(providerToken.mock.calls.length).toBeGreaterThanOrEqual(2)

		await host.emit("session_shutdown", { type: "session_shutdown" }, ctx)
	}, 30_000)
})
