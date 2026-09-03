import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import type { McpConfig, McpSettings, OAuthConfig, ServerEntry } from "../../../../src/extensions/mcp-adapter/types.js"

const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../../", import.meta.url))
const FIXTURE_SERVER_PATH = resolve(REPO_ROOT, "tests/e2e/mcp/fixture-server.mjs")

interface McpFixtureEventBase {
	at: string
	pid: number
	scenario: string
}

interface McpFixtureEventDetails {
	initialized: Record<string, never>
	tools_listed: Record<string, never>
	resources_listed: Record<string, never>
	resource_read: { uri: string }
	tool_called: { name: string; arguments: Record<string, unknown> }
	disconnect_started: Record<string, never>
	slow_call_started: Record<string, never>
	slow_call_cancelled: Record<string, never>
	slow_call_completed: Record<string, never>
	http_malformed_response: { method?: string }
	sse_streamable_rejected: { method?: string }
	sse_session_initialized: { sessionId: string }
	sse_session_closed: { sessionId: string }
	sse_message: { sessionId: string }
	oauth_resource_metadata_requested: { path: string }
	oauth_server_metadata_requested: Record<string, never>
	oauth_client_registered: { redirectUris?: string[] }
	oauth_authorization_denied: { redirectUri: string }
	oauth_authorized: { redirectUri: string; state: string; codeChallengeMethod: string }
	oauth_token_issued: { grantType: string; expiresIn: number; pkceVerified?: boolean }
	oauth_token_rejected: { grantType?: string }
	oauth_browser_opened: Record<string, never>
	oauth_browser_completed: { status: number }
	http_request: {
		method?: string
		path: string
		sessionId?: string
		authorized: boolean
		testHeader?: string
	}
	http_unauthorized: { method?: string; path: string }
	http_session_initialized: { sessionId: string }
	http_session_closed: { sessionId?: string }
	http_error: { message: string }
	http_listening: { url: string }
	process_started: { transport: "stdio" | "http" | "sse" }
	process_stopping: { signal: string }
	process_exited: { code: number }
	ui_browser_opened: Record<string, never>
	ui_host_loaded: { status: number }
}

export type McpFixtureEventType = keyof McpFixtureEventDetails
export type McpFixtureEventOf<T extends McpFixtureEventType> = McpFixtureEventBase & {
	type: T
} & McpFixtureEventDetails[T]
export type McpFixtureEvent = {
	[T in McpFixtureEventType]: McpFixtureEventOf<T>
}[McpFixtureEventType]

type McpFixtureEventWhere<T extends McpFixtureEventType> = Partial<
	Omit<McpFixtureEventOf<T>, keyof McpFixtureEventBase | "type">
>

interface WaitForMcpFixtureEventOptions<T extends McpFixtureEventType> {
	where?: McpFixtureEventWhere<T>
	predicate?: (event: McpFixtureEventOf<T>) => boolean
	after?: number
	timeoutMs?: number
	description?: string
}

export type McpFixtureScenario =
	| "basic"
	| "startup-failure"
	| "http-malformed"
	| "oauth-deny"
	| "oauth-token-failure"
	| "oauth-expiring"
	| "ui-app"

export interface McpServerFixtureOptions {
	serverName?: string
	scenario?: McpFixtureScenario
	directTools?: boolean | string[]
	lifecycle?: "keep-alive" | "lazy" | "eager"
	idleTimeout?: number
	toolPrefix?: McpSettings["toolPrefix"]
	autoAuth?: boolean
}

export interface McpUiFixture {
	waitForTarget(): Promise<string>
	request(path: string, params: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>
	post(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
	waitForClosed(): Promise<void>
}

export interface McpServerFixture {
	serverName: string
	serverDefinition: ServerEntry
	configPath: string
	eventPath: string
	readEvents(): McpFixtureEvent[]
	eventsOfType<T extends McpFixtureEventType>(type: T): McpFixtureEventOf<T>[]
	hasEvent<T extends McpFixtureEventType>(type: T, where?: McpFixtureEventWhere<T>): boolean
	checkpoint(): number
	waitForOAuthTokenExpiry(event: McpFixtureEventOf<"oauth_token_issued">): Promise<void>
	waitForEvent<T extends McpFixtureEventType>(
		type: T,
		options?: WaitForMcpFixtureEventOptions<T>,
	): Promise<McpFixtureEventOf<T>>
}

export interface McpFixtureOptions extends McpServerFixtureOptions {
	transport?: "stdio" | "http" | "oauth" | "sse"
	/** Additional stdio servers written into the same production MCP config. */
	additionalStdioServers?: Record<string, Omit<McpServerFixtureOptions, "serverName">>
	/** Configure an already-running HTTP server instead of spawning the repository fixture. */
	externalUrl?: string
	headers?: Record<string, string>
	/** Require this static token at the HTTP fixture and configure Kimchi to send it. */
	bearerToken?: string
	/** OAuth settings used by automatic-auth and conformance scenarios. */
	oauth?: OAuthConfig
}

export interface McpFixture extends McpServerFixture {
	transport: "stdio" | "http" | "oauth" | "sse"
	url?: string
	env: Record<string, string>
	ui?: McpUiFixture
	servers: Record<string, McpServerFixture>
	server(name: string): McpServerFixture
	stop(): Promise<void>
}

function eventMatches<T extends McpFixtureEventType>(
	event: McpFixtureEventOf<T>,
	where: McpFixtureEventWhere<T> | undefined,
): boolean {
	if (!where) return true
	return Object.entries(where).every(([key, value]) =>
		isDeepStrictEqual(event[key as keyof McpFixtureEventOf<T>], value),
	)
}

function createEventReader(
	eventPath: string,
): Pick<
	McpServerFixture,
	"readEvents" | "eventsOfType" | "hasEvent" | "checkpoint" | "waitForOAuthTokenExpiry" | "waitForEvent"
> {
	const readEvents = (): McpFixtureEvent[] => {
		if (!existsSync(eventPath)) return []
		const contents = readFileSync(eventPath, "utf-8")
		const lines = contents.split("\n")
		if (!contents.endsWith("\n")) lines.pop()
		return lines.filter(Boolean).map((line) => JSON.parse(line) as McpFixtureEvent)
	}
	const eventsOfType = <T extends McpFixtureEventType>(type: T): McpFixtureEventOf<T>[] =>
		readEvents().filter((event): event is McpFixtureEventOf<T> => event.type === type)
	const hasEvent = <T extends McpFixtureEventType>(type: T, where?: McpFixtureEventWhere<T>): boolean =>
		eventsOfType(type).some((event) => eventMatches(event, where))

	return {
		readEvents,
		eventsOfType,
		hasEvent,
		checkpoint: () => readEvents().length,
		async waitForOAuthTokenExpiry(event) {
			const remainingMs = Date.parse(event.at) + event.expiresIn * 1_000 - Date.now()
			if (remainingMs > 0) await delay(remainingMs + 100)
		},
		async waitForEvent(type, waitOptions = {}) {
			const timeoutMs = waitOptions.timeoutMs ?? 10_000
			const startedAt = Date.now()
			while (Date.now() - startedAt < timeoutMs) {
				const events = readEvents().slice(waitOptions.after ?? 0)
				const event = eventsOfTypeFrom(events, type).find(
					(candidate) => eventMatches(candidate, waitOptions.where) && (waitOptions.predicate?.(candidate) ?? true),
				)
				if (event) return event
				await delay(25)
			}
			const description = waitOptions.description ?? `${type} MCP fixture event`
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for ${description}. Events: ${JSON.stringify(readEvents())}`,
			)
		},
	}
}

function eventsOfTypeFrom<T extends McpFixtureEventType>(events: McpFixtureEvent[], type: T): McpFixtureEventOf<T>[] {
	return events.filter((event): event is McpFixtureEventOf<T> => event.type === type)
}

function configuredServerFields(options: McpServerFixtureOptions): ServerEntry {
	return {
		...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
		...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
		...(options.directTools === undefined ? {} : { directTools: options.directTools }),
	}
}

function writeMcpConfig(
	agentDir: string,
	serverDefinitions: Record<string, ServerEntry>,
	options: McpServerFixtureOptions,
): string {
	const configPath = resolve(agentDir, "mcp.json")
	const config: McpConfig = {
		mcpServers: serverDefinitions,
		...(options.toolPrefix === undefined && options.autoAuth === undefined
			? {}
			: {
					settings: {
						...(options.toolPrefix === undefined ? {} : { toolPrefix: options.toolPrefix }),
						...(options.autoAuth === undefined ? {} : { autoAuth: options.autoAuth }),
					},
				}),
	}
	writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf-8")
	return configPath
}

export function seedMcpStdioFixture(agentDir: string, options: McpFixtureOptions = {}): McpFixture {
	const serverName = options.serverName ?? "fixture"
	const allOptions: Array<[string, McpServerFixtureOptions]> = [
		[serverName, options],
		...Object.entries(options.additionalStdioServers ?? {}).map(
			([name, serverOptions]): [string, McpServerFixtureOptions] => [name, { ...serverOptions, serverName: name }],
		),
	]
	const seeded = allOptions.map(([name, serverOptions]) => seedStdioServer(agentDir, name, serverOptions))
	const configPath = writeMcpConfig(
		agentDir,
		Object.fromEntries(seeded.map((server) => [server.serverName, server.serverDefinition])),
		options,
	)
	const servers = Object.fromEntries(
		seeded.map((server) => [server.serverName, { ...server, configPath } satisfies McpServerFixture]),
	)
	const primary = servers[serverName]
	if (!primary) throw new Error(`Primary MCP fixture ${serverName} was not seeded`)
	const uiDriver = options.scenario === "ui-app" ? createUiBrowserDriver(agentDir, primary.eventPath) : undefined

	return {
		...primary,
		transport: "stdio",
		env: uiDriver?.env ?? {},
		ui: uiDriver?.ui,
		servers,
		server(name) {
			const fixture = servers[name]
			if (!fixture) throw new Error(`MCP fixture server ${name} is not configured`)
			return fixture
		},
		async stop() {},
	}
}

function seedStdioServer(
	agentDir: string,
	serverName: string,
	options: McpServerFixtureOptions,
): Omit<McpServerFixture, "configPath"> {
	const scenario = options.scenario ?? "basic"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	writeFileSync(eventPath, "", "utf-8")
	return {
		serverName,
		serverDefinition: {
			command: process.execPath,
			args: [FIXTURE_SERVER_PATH],
			env: {
				KIMCHI_MCP_FIXTURE_EVENTS: eventPath,
				KIMCHI_MCP_FIXTURE_SCENARIO: scenario,
			},
			...configuredServerFields(options),
		},
		eventPath,
		...createEventReader(eventPath),
	}
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))
	child.kill("SIGTERM")
	const graceful = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])
	if (graceful) return
	child.kill("SIGKILL")
	await exited
}

export async function createMcpFixture(agentDir: string, options: McpFixtureOptions = {}): Promise<McpFixture> {
	if (options.additionalStdioServers && (options.externalUrl || (options.transport ?? "stdio") !== "stdio")) {
		throw new Error("additionalStdioServers is currently supported only by the stdio MCP fixture")
	}
	if (options.externalUrl) return seedExternalHttpFixture(agentDir, options)
	if ((options.transport ?? "stdio") === "stdio") return seedMcpStdioFixture(agentDir, options)

	const serverName = options.serverName ?? "fixture"
	const scenario = options.scenario ?? "basic"
	const oauth = options.transport === "oauth"
	const transport = options.transport === "sse" ? "sse" : "http"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	writeFileSync(eventPath, "", "utf-8")

	const child = spawn(process.execPath, [FIXTURE_SERVER_PATH], {
		env: {
			...process.env,
			KIMCHI_MCP_FIXTURE_EVENTS: eventPath,
			KIMCHI_MCP_FIXTURE_SCENARIO: scenario,
			KIMCHI_MCP_FIXTURE_TRANSPORT: transport,
			...(oauth ? { KIMCHI_MCP_FIXTURE_OAUTH: "1" } : {}),
			...(oauth && options.oauth?.grantType ? { KIMCHI_MCP_FIXTURE_OAUTH_GRANT_TYPE: options.oauth.grantType } : {}),
			...(oauth && options.oauth?.clientId ? { KIMCHI_MCP_FIXTURE_OAUTH_CLIENT_ID: options.oauth.clientId } : {}),
			...(oauth && options.oauth?.clientSecret
				? { KIMCHI_MCP_FIXTURE_OAUTH_CLIENT_SECRET: options.oauth.clientSecret }
				: {}),
			...(oauth
				? { KIMCHI_MCP_FIXTURE_BEARER_TOKEN: "kimchi-e2e-oauth-access-token" }
				: options.bearerToken
					? { KIMCHI_MCP_FIXTURE_BEARER_TOKEN: options.bearerToken }
					: {}),
		},
		stdio: ["ignore", "ignore", "inherit"],
	})
	const eventReader = createEventReader(eventPath)
	try {
		const listening = await eventReader.waitForEvent("http_listening", {
			description: "HTTP MCP fixture to listen",
		})
		const serverDefinition: ServerEntry = {
			url: listening.url,
			...(options.headers === undefined ? {} : { headers: options.headers }),
			...(oauth ? { auth: "oauth" as const, oauth: options.oauth ?? { scope: "mcp:tools" } } : {}),
			...(!oauth && options.bearerToken ? { auth: "bearer" as const, bearerToken: options.bearerToken } : {}),
			...configuredServerFields(options),
		}
		const configPath = writeMcpConfig(agentDir, { [serverName]: serverDefinition }, options)
		const browserEnv = oauth ? createOAuthBrowserDriver(agentDir, eventPath) : {}
		const serverFixture: McpServerFixture = { serverName, serverDefinition, configPath, eventPath, ...eventReader }

		return {
			...serverFixture,
			transport: oauth ? "oauth" : transport,
			url: listening.url,
			env: browserEnv,
			servers: { [serverName]: serverFixture },
			server(name) {
				if (name !== serverName) throw new Error(`MCP fixture server ${name} is not configured`)
				return serverFixture
			},
			async stop() {
				await stopChild(child)
			},
		}
	} catch (error) {
		await stopChild(child)
		throw error
	}
}

function seedExternalHttpFixture(agentDir: string, options: McpFixtureOptions): McpFixture {
	const serverName = options.serverName ?? "fixture"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	writeFileSync(eventPath, "", "utf-8")
	const serverDefinition: ServerEntry = {
		url: options.externalUrl,
		...(options.headers === undefined ? {} : { headers: options.headers }),
		...(options.transport === "oauth"
			? { auth: "oauth" as const, oauth: options.oauth ?? { scope: "mcp:tools" } }
			: {}),
		...configuredServerFields(options),
	}
	const configPath = writeMcpConfig(agentDir, { [serverName]: serverDefinition }, options)
	const browserEnv = options.transport === "oauth" ? createOAuthBrowserDriver(agentDir, eventPath) : {}
	const serverFixture: McpServerFixture = {
		serverName,
		serverDefinition,
		configPath,
		eventPath,
		...createEventReader(eventPath),
	}
	return {
		...serverFixture,
		transport: options.transport === "oauth" ? "oauth" : "http",
		url: options.externalUrl,
		env: browserEnv,
		servers: { [serverName]: serverFixture },
		server(name) {
			if (name !== serverName) throw new Error(`MCP fixture server ${name} is not configured`)
			return serverFixture
		},
		async stop() {},
	}
}

function createUiBrowserDriver(agentDir: string, eventPath: string): { env: Record<string, string>; ui: McpUiFixture } {
	const browserBinDir = resolve(agentDir, "mcp-ui-browser")
	const browserPath = resolve(browserBinDir, "open")
	const targetPath = resolve(agentDir, "mcp-ui-target.json")
	mkdirSync(browserBinDir, { recursive: true })
	writeFileSync(
		browserPath,
		`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs"
const eventPath = ${JSON.stringify(eventPath)}
const targetPath = ${JSON.stringify(targetPath)}
const target = process.argv.find((argument) => argument.startsWith("http://") || argument.startsWith("https://"))
if (!target) throw new Error("MCP UI browser driver did not receive an HTTP URL")
writeFileSync(targetPath, JSON.stringify({ target }), "utf-8")
appendFileSync(eventPath, JSON.stringify({ type: "ui_browser_opened", at: new Date().toISOString(), pid: process.pid, scenario: "ui-app" }) + "\\n")
const response = await fetch(target)
appendFileSync(eventPath, JSON.stringify({ type: "ui_host_loaded", at: new Date().toISOString(), pid: process.pid, scenario: "ui-app", status: response.status }) + "\\n")
if (!response.ok) throw new Error(\`MCP UI browser driver received HTTP \${response.status}\`)
`,
		"utf-8",
	)
	chmodSync(browserPath, 0o755)

	const waitForTarget = async (): Promise<string> => {
		const startedAt = Date.now()
		while (Date.now() - startedAt < 10_000) {
			if (existsSync(targetPath)) {
				const parsed = JSON.parse(readFileSync(targetPath, "utf-8")) as { target?: unknown }
				if (typeof parsed.target === "string") return parsed.target
			}
			await delay(25)
		}
		throw new Error("Timed out waiting for the MCP UI browser target")
	}
	const request = async (
		path: string,
		params: Record<string, unknown>,
	): Promise<{ status: number; body: Record<string, unknown> }> => {
		const target = new URL(await waitForTarget())
		const token = target.searchParams.get("session")
		if (!token) throw new Error("MCP UI target did not contain a session token")
		const response = await fetch(new URL(path, target.origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, params }),
		})
		return { status: response.status, body: (await response.json()) as Record<string, unknown> }
	}
	const post = async (path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const response = await request(path, params)
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`MCP UI request failed (${response.status}): ${JSON.stringify(response.body)}`)
		}
		return response.body
	}
	const waitForClosed = async (): Promise<void> => {
		const target = new URL(await waitForTarget())
		const startedAt = Date.now()
		while (Date.now() - startedAt < 5_000) {
			try {
				await fetch(target)
			} catch {
				return
			}
			await delay(25)
		}
		throw new Error("Timed out waiting for the MCP UI host to close")
	}

	return {
		env: {
			BROWSER: browserPath,
			PATH: `${browserBinDir}:${process.env.PATH ?? ""}`,
			MCP_UI_VIEWER: "browser",
		},
		ui: {
			waitForTarget,
			request,
			post,
			waitForClosed,
		},
	}
}

function createOAuthBrowserDriver(agentDir: string, eventPath: string): Record<string, string> {
	const browserBinDir = resolve(agentDir, "mcp-oauth-browser")
	const browserPath = resolve(browserBinDir, "open")
	mkdirSync(browserBinDir, { recursive: true })
	writeFileSync(
		browserPath,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const eventPath = ${JSON.stringify(eventPath)}
const target = process.argv.find((argument) => argument.startsWith("http://") || argument.startsWith("https://"))
if (!target) throw new Error("OAuth browser driver did not receive an HTTP URL")
appendFileSync(eventPath, JSON.stringify({ type: "oauth_browser_opened", at: new Date().toISOString(), pid: process.pid, scenario: "oauth" }) + "\\n")
const response = await fetch(target, { redirect: "follow" })
appendFileSync(eventPath, JSON.stringify({ type: "oauth_browser_completed", at: new Date().toISOString(), pid: process.pid, scenario: "oauth", status: response.status }) + "\\n")
if (!response.ok) throw new Error(\`OAuth browser driver received HTTP \${response.status}\`)
`,
		"utf-8",
	)
	chmodSync(browserPath, 0o755)
	return {
		BROWSER: browserPath,
		PATH: `${browserBinDir}:${process.env.PATH ?? ""}`,
	}
}
