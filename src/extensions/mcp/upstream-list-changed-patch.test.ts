import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { describe, expect, it } from "vitest"

/**
 * Regression guard for the vendored `@modelcontextprotocol/client` patch
 * (patches/@modelcontextprotocol__client@2.3.1.patch): the SDK used to drop
 * `notifications/tools/list_changed` from servers that do not advertise the
 * `tools.listChanged` capability, so the harness never refreshed MCP tool
 * metadata for them (the real Studio slack-wrapper shape). The patch makes
 * handler registration independent of the advertised capability, so a received
 * notification is always consumed. If this test fails after a pnpm patch
 * rebase, the vendored gate was reintroduced.
 */

const serverScript = (advertiseCapability: boolean): string => `
	const advertise = ${advertiseCapability ? "true" : "false"}
	let phase = 0
	let buffer = ""
	const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
	const catalog = () =>
		phase === 0
			? [{ name: "tool_a", description: "phase one tool", inputSchema: { type: "object", properties: {} } }]
			: [
					{ name: "tool_a", description: "phase one tool", inputSchema: { type: "object", properties: {} } },
					{ name: "tool_b", description: "phase two tool", inputSchema: { type: "object", properties: {} } },
				]
	process.stdin.setEncoding("utf8")
	process.stdin.on("data", (chunk) => {
		buffer += chunk
		let index
		while ((index = buffer.indexOf("\\n")) !== -1) {
			const line = buffer.slice(0, index)
			buffer = buffer.slice(index + 1)
			if (!line.trim()) continue
			const message = JSON.parse(line)
			if (message.method === "initialize") {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: message.params.protocolVersion,
						capabilities: { tools: advertise ? { listChanged: true } : {} },
						serverInfo: { name: "list-changed-regression", version: "1.0.0" },
					},
				})
			} else if (message.method === "tools/list") {
				send({ jsonrpc: "2.0", id: message.id, result: { tools: catalog() } })
			} else if (message.method === "tools/call" && message.params?.name === "rotate") {
				phase = 1
				send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: { content: [{ type: "text", text: "catalog rotated" }] },
				})
			}
		}
	})
`

interface RefreshObservation {
	error: unknown
	tools: string[]
}

async function connectAndRotate(advertiseCapability: boolean): Promise<RefreshObservation> {
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-list-changed-"))
	const serverPath = join(workDir, "server.mjs")
	writeFileSync(serverPath, serverScript(advertiseCapability), "utf8")

	const observations: RefreshObservation[] = []
	const client = new Client(
		{ name: "list-changed-regression-client", version: "1.0.0" },
		{
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						observations.push({ error, tools: tools ? tools.map((tool) => tool.name) : [] })
					},
				},
			},
		},
	)
	try {
		const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] })
		await client.connect(transport)
		expect(client.getServerCapabilities()).toEqual({ tools: advertiseCapability ? { listChanged: true } : {} })

		const initial = await client.listTools()
		expect(initial.tools.map((tool) => tool.name)).toEqual(["tool_a"])

		await client.callTool({ name: "rotate", arguments: {} })

		const deadline = Date.now() + 5_000
		while (observations.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		expect(observations).toHaveLength(1)
		const observation = observations[0]
		expect(observation.error).toBeNull()
		return observation
	} finally {
		await client.close().catch(() => {})
		rmSync(workDir, { recursive: true, force: true })
	}
}

describe("MCP client consumes tools/list_changed", () => {
	it("refreshes tool metadata without the server advertising the listChanged capability", async () => {
		const observation = await connectAndRotate(false)
		expect(observation.tools).toEqual(["tool_a", "tool_b"])
	}, 15_000)

	it("keeps refreshing when the server does advertise the capability", async () => {
		const observation = await connectAndRotate(true)
		expect(observation.tools).toEqual(["tool_a", "tool_b"])
	}, 15_000)
})

/**
 * The gate removal covers prompts and resources too, not just tools — a
 * patch rebase that reintroduces the advertised-capability gate for those
 * list types alone would pass the tools-only tests silently. This variant
 * exercises prompts: the server emits notifications/prompts/list_changed
 * on the rotate call and never advertises prompts.listChanged.
 */
const promptsServerScript = (advertiseCapability: boolean): string => `
	const advertise = ${advertiseCapability ? "true" : "false"}
	let phase = 0
	let buffer = ""
	const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
	const promptCatalog = () =>
		phase === 0
			? [{ name: "prompt_a", description: "phase one prompt" }]
			: [
					{ name: "prompt_a", description: "phase one prompt" },
					{ name: "prompt_b", description: "phase two prompt" },
				]
	process.stdin.setEncoding("utf8")
	process.stdin.on("data", (chunk) => {
		buffer += chunk
		let index
		while ((index = buffer.indexOf("\\n")) !== -1) {
			const line = buffer.slice(0, index)
			buffer = buffer.slice(index + 1)
			if (!line.trim()) continue
			const message = JSON.parse(line)
			if (message.method === "initialize") {
				send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					capabilities: { prompts: advertise ? { listChanged: true } : {} },
					serverInfo: { name: "list-changed-prompts-regression", version: "1.0.0" },
				},
			})
			} else if (message.method === "prompts/list") {
				send({ jsonrpc: "2.0", id: message.id, result: { prompts: promptCatalog() } })
			} else if (message.method === "tools/call" && message.params?.name === "rotate") {
				phase = 1
				send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" })
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: { content: [{ type: "text", text: "prompt catalog rotated" }] },
				})
			}
		}
	})
`

describe("MCP client consumes prompts/list_changed", () => {
	it("refreshes prompt metadata without the server advertising the capability", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-list-changed-prompts-"))
		const serverPath = join(workDir, "server.mjs")
		writeFileSync(serverPath, promptsServerScript(false), "utf8")

		const observations: RefreshObservation[] = []
		const client = new Client(
			{ name: "list-changed-prompts-client", version: "1.0.0" },
			{
				listChanged: {
					prompts: {
						onChanged: (error, prompts) => {
							observations.push({ error, tools: prompts ? prompts.map((prompt) => prompt.name) : [] })
						},
					},
				},
			},
		)
		try {
			const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] })
			await client.connect(transport)
			expect(client.getServerCapabilities()).toEqual({ prompts: {} })

			const initial = await client.listPrompts()
			expect(initial.prompts.map((prompt) => prompt.name)).toEqual(["prompt_a"])

			await client.callTool({ name: "rotate", arguments: {} })
			const deadline = Date.now() + 5_000
			while (observations.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
			expect(observations).toHaveLength(1)
			expect(observations[0].error).toBeNull()
			expect(observations[0].tools).toEqual(["prompt_a", "prompt_b"])
		} finally {
			await client.close().catch(() => {})
			rmSync(workDir, { recursive: true, force: true })
		}
	}, 15_000)
})

/**
 * Modern-era (2026-07-28) connections: the sibling version-negotiation probe speaks
 * `server/discover`, and the negotiated connect registers handlers from the
 * listChanged config while the auto-opened `subscriptions/listen` subscription
 * stays gated on the advertised capability. The events file records every
 * request method the server processes, so the assertions can tell which
 * connect arm ran: `server/discover` (sibling probe) without `initialize`
 * means the modern arm; `subscriptions/listen` presence tracks the filter.
 */
const modernServerScript = (advertiseCapability: boolean): string => `
	import { appendFileSync } from "node:fs"
	const advertise = ${advertiseCapability ? "true" : "false"}
	const eventsPath = process.env.MCP_LIST_CHANGED_TEST_EVENTS
	let phase = 0
	let buffer = ""
	const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
	const record = (type, details = {}) => {
		if (!eventsPath) return
		appendFileSync(eventsPath, JSON.stringify({ type, ...details }) + "\\n", "utf8")
	}
	const catalog = () =>
		phase === 0
			? [{ name: "tool_a", description: "phase one tool", inputSchema: { type: "object", properties: {} } }]
			: [
					{ name: "tool_a", description: "phase one tool", inputSchema: { type: "object", properties: {} } },
					{ name: "tool_b", description: "phase two tool", inputSchema: { type: "object", properties: {} } },
				]
	process.stdin.setEncoding("utf8")
	process.stdin.on("data", (chunk) => {
		buffer += chunk
		let index
		while ((index = buffer.indexOf("\\n")) !== -1) {
			const line = buffer.slice(0, index)
			buffer = buffer.slice(index + 1)
			if (!line.trim()) continue
			const message = JSON.parse(line)
			if (message.method) record("request", { method: message.method })
			if (message.method === "server/discover") {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						ttlMs: 0,
						cacheScope: "private",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: advertise ? { listChanged: true } : {} },
					},
				})
			} else if (message.method === "initialize") {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-06-18",
						capabilities: { tools: advertise ? { listChanged: true } : {} },
						serverInfo: { name: "modern-regression", version: "1.0.0" },
					},
				})
			} else if (message.method === "subscriptions/listen") {
				send({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete" } })
			} else if (message.method === "tools/list") {
				send({
				jsonrpc: "2.0",
				id: message.id,
				result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: catalog() },
			})
			} else if (message.method === "tools/call" && message.params?.name === "rotate") {
				phase = 1
				send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: { resultType: "complete", content: [{ type: "text", text: "catalog rotated" }] },
				})
			}
		}
	})
`

interface ModernObservation {
	refreshedTools: string[]
	requestMethods: string[]
}

async function connectModernAndRotate(advertiseCapability: boolean): Promise<ModernObservation> {
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-list-changed-modern-"))
	const serverPath = join(workDir, "server.mjs")
	const eventsPath = join(workDir, "events.jsonl")
	writeFileSync(serverPath, modernServerScript(advertiseCapability), "utf8")

	const observations: RefreshObservation[] = []
	const client = new Client(
		{ name: "list-changed-modern-client", version: "1.0.0" },
		{
			// "auto" runs the sibling server/discover probe; the default mode is
			// "legacy", which skips the modern connect arm entirely.
			versionNegotiation: { mode: "auto" },
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						observations.push({ error, tools: tools ? tools.map((tool) => tool.name) : [] })
					},
				},
			},
		},
	)
	try {
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [serverPath],
			env: { ...process.env, MCP_LIST_CHANGED_TEST_EVENTS: eventsPath },
		})
		await client.connect(transport)

		const initial = await client.listTools()
		expect(initial.tools.map((tool) => tool.name)).toEqual(["tool_a"])

		await client.callTool({ name: "rotate", arguments: {} })
		const deadline = Date.now() + 5_000
		while (observations.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		expect(observations).toHaveLength(1)
		const observation = observations[0]
		expect(observation.error).toBeNull()

		const requestMethods = readFileSync(eventsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { method?: string }).method)
			.filter((method): method is string => method !== undefined)
		return { refreshedTools: observation.tools, requestMethods }
	} finally {
		await client.close().catch(() => {})
		rmSync(workDir, { recursive: true, force: true })
	}
}

describe("MCP client consumes tools/list_changed on modern connections", () => {
	it("refreshes without the advertised capability and never asks for a subscription", async () => {
		const observation = await connectModernAndRotate(false)
		// The sibling probe answered server/discover and the session adopted it —
		// no legacy initialize handshake ran.
		expect(observation.requestMethods).toContain("server/discover")
		expect(observation.requestMethods).not.toContain("initialize")
		// The subscriptions/listen filter keeps the advertised-capability gate:
		// a non-advertising server must not receive a subscription request.
		expect(observation.requestMethods).not.toContain("subscriptions/listen")
		expect(observation.refreshedTools).toEqual(["tool_a", "tool_b"])
	}, 20_000)

	it("opens the subscription and refreshes when the capability is advertised", async () => {
		const observation = await connectModernAndRotate(true)
		expect(observation.requestMethods).toContain("server/discover")
		expect(observation.requestMethods).not.toContain("initialize")
		expect(observation.requestMethods).toContain("subscriptions/listen")
		expect(observation.refreshedTools).toEqual(["tool_a", "tool_b"])
	}, 20_000)
})
