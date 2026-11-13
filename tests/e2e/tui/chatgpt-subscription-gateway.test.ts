import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel, FakeResponseRequest } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * ChatGPT subscription models through the gateway.
 *
 * The stubbed gateway serves chatgpt rows in /v1/models/metadata and a
 * /openai/v1/codex/responses route. The ChatGPT browser login itself is not
 * stubbable, so "after ChatGPT login" seeds the stored kimchi-dev/openai-codex OAuth
 * credential the login would have written.
 */

const GLM: FakeModel = {
	slug: "glm-5.3",
	displayName: "GLM 5.3",
	provider: "ai-enabler",
	reasoning: true,
	input: ["text"],
	contextWindow: 202_752,
	maxTokens: 8_192,
}

const CODEX_ONLY: FakeModel = {
	slug: "gpt-5.4-codex",
	displayName: "GPT 5.4 Codex",
	provider: "chatgpt",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	metadata: { provider_name: "Team Codex" },
}

const SHARED_CHATGPT: FakeModel = {
	slug: "gpt-5.5",
	displayName: "GPT 5.5",
	provider: "chatgpt",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	metadata: { provider_name: "Team Codex" },
}

const SHARED_OPENAI: FakeModel = {
	slug: "gpt-5.5",
	displayName: "GPT 5.5",
	provider: "openai",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	metadata: { provider_name: "OpenAI prod" },
}

const WITH_CHATGPT = [GLM, CODEX_ONLY, SHARED_CHATGPT, SHARED_OPENAI]
const WITHOUT_CHATGPT = [GLM, SHARED_OPENAI]

// Stored ChatGPT login: pi's codex provider reads the account id from the JWT.
function chatgptJwt(): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
	return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_e2e" } })}.sig`
}

function seedAuth(homeDir: string, options: { kimchi: boolean; chatgpt: boolean }): void {
	writeFileSync(
		join(homeDir, ".config", "kimchi", "harness", "auth.json"),
		JSON.stringify({
			...(options.kimchi ? { "kimchi-dev": { type: "api_key", key: "kimchi-e2e-key" } } : {}),
			...(options.chatgpt
				? {
						"kimchi-dev/openai-codex": { type: "oauth", access: chatgptJwt(), refresh: "", expires: 4_102_444_800_000 },
					}
				: {}),
		}),
	)
}

async function openSubscriptionMenu(terminal: Parameters<typeof waitForText>[0]): Promise<void> {
	terminal.write("/login")
	await waitForText(terminal, "/login", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.submit("")
	await waitForText(terminal, "Use a subscription", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.keyDown(3)
	terminal.submit("")
}

test("OpenAI Codex is offered under Use a subscription when the feed has chatgpt entries", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-menu-offered",
			responses: [],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: false }),
		},
		async (_fixture, trace) => {
			await openSubscriptionMenu(terminal)
			await waitForText(terminal, "OpenAI Codex", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("(legacy)")
			trace.step("OpenAI Codex offered without the legacy suffix")
		},
	)
})

test("OpenAI Codex is hidden under Use a subscription when the feed has no chatgpt entries", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-menu-hidden-no-feed",
			responses: [],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITHOUT_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: false }),
		},
		async (_fixture, trace) => {
			await openSubscriptionMenu(terminal)
			await waitForText(terminal, "No subscription providers available", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("OpenAI Codex")
			trace.step("OpenAI Codex hidden when the feed has no chatgpt entries")
		},
	)
})

test("OpenAI Codex is hidden when signed out of Kimchi", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-menu-hidden-signed-out",
			responses: [],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => {
				seedAuth(homeDir, { kimchi: false, chatgpt: true })
				// A stored ChatGPT login alone must not surface Codex without a Kimchi sign-in.
				const configPath = join(homeDir, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
				config.apiKey = undefined
				writeFileSync(configPath, JSON.stringify(config))
			},
		},
		async (_fixture, trace) => {
			await openSubscriptionMenu(terminal)
			await waitForText(terminal, "No subscription providers available", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("OpenAI Codex")
			trace.step("OpenAI Codex hidden when signed out")
		},
	)
})

async function selectModel(terminal: Parameters<typeof waitForText>[0], filter: string, rowText: string) {
	terminal.write("/model")
	await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.submit("")
	await waitForText(terminal, "PROVIDER", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.write(filter)
	await waitForText(terminal, rowText, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
	terminal.submit("")
	await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
}

async function ask(
	terminal: Parameters<typeof waitForText>[0],
	fixture: { fake: { requests: { length: number } } },
	text: string,
	expectedReply: string,
) {
	const before = fixture.fake.requests.length
	terminal.write(text)
	terminal.submit("")
	await waitForText(terminal, expectedReply, { timeoutMs: STREAM_TIMEOUT_MS })
	await waitForTurnToSettle(fixture.fake.requests)
	return before
}

const bashTrue = { id: "call_true", function: { name: "bash", arguments: JSON.stringify({ command: "true" }) } }

/** Matches a request whose last Responses input item contains `text`. */
function lastInputIncludes(text: string): (request: FakeResponseRequest) => boolean {
	return (request) => {
		const input = (request.body as { input?: unknown[] } | undefined)?.input
		return JSON.stringify(input?.at(-1) ?? "").includes(text)
	}
}

function codexTurnMetadata(request: { headers: Record<string, string | string[] | undefined> }) {
	return JSON.parse(String(request.headers["x-codex-turn-metadata"])) as Record<string, unknown>
}

test("after ChatGPT login the picker lists the feed's chatgpt models and a Codex request carries both credentials over SSE", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-codex-request",
			responses: [{ stream: ["codex says hi"] }],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: true }),
		},
		async (fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "gpt-5.4-codex", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const picker = viewText(terminal)
			expect(picker).toContain("kimchi-dev/openai-codex")
			// Pi's hardcoded codex list must not leak in next to the feed's models.
			expect(picker).not.toContain("gpt-5.3-codex")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("picker lists the feed's chatgpt models")

			await selectModel(terminal, "5.4-codex", "gpt-5.4-codex")
			await ask(terminal, fixture, "hello codex", "codex says hi")
			const codexRequests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/codex/responses"))
			expect(codexRequests).toHaveLength(1)
			const [request] = codexRequests
			expect(request.headers.authorization).toBe(`Bearer ${chatgptJwt()}`)
			expect(request.headers["x-api-key"]).toBe("fake")
			expect(request.headers.accept).toBe("text/event-stream")
			expect(request.headers["user-agent"]).toMatch(/^kimchi\//)
			expect((request.body as { model: string }).model).toBe("gpt-5.4-codex")
			trace.step("codex request sent with both credentials over SSE")
		},
	)
})

test("Codex requests carry thread, window and turn ids that follow the session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-correlation",
			// Scripts are matched on the request, not queued in order: the harness may add a hidden
			// follow-up request after a text-only reply, and that one must not shift the replies.
			responses: [
				{ match: lastInputIncludes('"text":"one"'), toolCalls: [bashTrue] },
				{ match: lastInputIncludes("call_true"), stream: ["reply one"] },
				{ match: lastInputIncludes('"text":"two"'), stream: ["reply two"] },
				{ match: (r) => JSON.stringify(r.body).includes("context summarization assistant"), stream: ["SUMMARY"] },
				{ match: lastInputIncludes('"text":"three"'), stream: ["reply three"] },
				{ match: lastInputIncludes("Do not repeat your previous answer"), stream: ["<done>"] },
				{ match: lastInputIncludes("Do not repeat your previous answer"), stream: ["<done>"] },
			],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => {
				seedAuth(homeDir, { kimchi: true, chatgpt: true })
				// A tiny kept tail so /compact has something to summarize in a short session.
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
				settings.compaction = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 }
				writeFileSync(settingsPath, JSON.stringify(settings))
			},
		},
		async (fixture, trace) => {
			await selectModel(terminal, "5.4-codex", "gpt-5.4-codex")
			await ask(terminal, fixture, "one", "reply one")
			await ask(terminal, fixture, "two", "reply two")
			terminal.submit("/compact")
			await waitForText(terminal, "Compacted from", { timeoutMs: STREAM_TIMEOUT_MS })
			await ask(terminal, fixture, "three", "reply three")

			const codex = fixture.fake.requests.filter(
				(r) => r.method === "POST" && r.url.startsWith("/openai/v1/codex/responses"),
			)
			const kindOf = (request: FakeResponseRequest) => codexTurnMetadata(request).request_kind
			const compactionRequests = codex.filter((r) => kindOf(r) === "compaction")
			expect(compactionRequests).toHaveLength(1)
			const [compaction] = compactionRequests
			const byInput = (text: string) => codex.filter(lastInputIncludes(text))
			const [toolCall] = byInput('"text":"one"')
			const [replyOne] = byInput("call_true")
			const [replyTwo] = byInput('"text":"two"')
			const [replyThree] = byInput('"text":"three"')
			const sessionId = String(toolCall.headers["thread-id"])
			expect(sessionId).not.toBe("undefined")

			for (const request of codex) {
				const metadata = codexTurnMetadata(request)
				expect(request.headers.originator).toBe("kimchi")
				expect(request.headers["thread-id"]).toBe(sessionId)
				expect(Object.keys(metadata).sort()).toEqual(
					["request_kind", "session_id", "thread_id", "turn_id", "window_id", "window_number"].sort(),
				)
				expect(metadata.thread_id).toBe(sessionId)
				const clientMetadata = (request.body as { client_metadata: Record<string, string> }).client_metadata
				expect(Object.keys(clientMetadata).sort()).toEqual(
					["session_id", "thread_id", "turn_id", "x-codex-window-id"].sort(),
				)
				expect(clientMetadata.thread_id).toBe(sessionId)
				expect(clientMetadata.turn_id).toBe(metadata.turn_id)
			}
			trace.step("every Codex request carries the originator, thread id and exact metadata keys")

			// One prompt with a tool loop is one turn; the next prompt is a new turn.
			expect(codexTurnMetadata(toolCall).turn_id).toBe(codexTurnMetadata(replyOne).turn_id)
			expect(codexTurnMetadata(replyTwo).turn_id).not.toBe(codexTurnMetadata(replyOne).turn_id)
			for (const request of [toolCall, replyOne, replyTwo]) {
				expect(codexTurnMetadata(request)).toMatchObject({ request_kind: "turn", window_number: 0 })
				expect(request.headers["x-codex-window-id"]).toBe(`${sessionId}:0`)
			}
			trace.step("a tool loop shares one turn id and the next prompt gets a new one")

			// pi sends a random session id on compaction; it must still land on this session.
			expect(compaction.headers["thread-id"]).toBe(sessionId)
			expect(compaction.headers["x-codex-window-id"]).toBe(`${sessionId}:0`)
			expect(codexTurnMetadata(compaction)).toMatchObject({ request_kind: "compaction", window_number: 0 })
			trace.step("the compaction request carries the session's thread id and kind compaction")

			expect(codexTurnMetadata(replyThree)).toMatchObject({ request_kind: "turn", window_number: 1 })
			expect(replyThree.headers["x-codex-window-id"]).toBe(`${sessionId}:1`)
			expect(codexTurnMetadata(replyThree).turn_id).not.toBe(codexTurnMetadata(replyTwo).turn_id)
			trace.step("the turn after compaction is in window 1 with a new turn id")
		},
	)
})

test("a kimchi-dev request after ChatGPT login carries only the Kimchi key", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-kimchi-key-only",
			responses: [{ stream: ["glm says hi"] }],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: true }),
		},
		async (fixture, trace) => {
			await ask(terminal, fixture, "hello glm", "glm says hi")
			const chat = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
			expect(chat).toHaveLength(1)
			expect(chat[0].headers.authorization).toMatch(/^Bearer (fake|kimchi-e2e-key)$/)
			expect(chat[0].headers["x-api-key"]).toBeUndefined()
			expect(chat[0].headers["chatgpt-account-id"]).toBeUndefined()
			expect(chat[0].headers.originator).toBeUndefined()
			expect(chat[0].headers["thread-id"]).toBeUndefined()
			expect(Object.keys(chat[0].headers).filter((h) => h.startsWith("x-codex-"))).toEqual([])
			trace.step("kimchi-dev request has only the Kimchi key")
		},
	)
})

test("a model on the chatgpt row and another row shows as two labelled entries", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-duplicate-labels",
			responses: [],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: true }),
		},
		async (_fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "gpt-5.5 (Team Codex, subscription)", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const picker = viewText(terminal)
			expect(picker).toContain("gpt-5.5 (OpenAI prod)")
			expect(picker).toMatch(/glm-5\.3\s+kimchi-dev\s/)
			expect(picker).toMatch(/gpt-5\.4-codex\s+kimchi-dev\/openai-codex/)
			trace.step("one entry per provider, labelled by instance name")
		},
	)
})

test("picking each labelled gpt-5.5 entry routes to the provider it names", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-duplicate-routing",
			responses: [{ stream: ["from subscription"] }, { stream: ["from api key"] }],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: true }),
		},
		async (fixture, trace) => {
			// The picker filter matches id, provider and name, not the label.
			await selectModel(terminal, "5.5 kimchi-dev/openai-codex", "gpt-5.5 (Team Codex, subscription)")
			const first = await ask(terminal, fixture, "via subscription", "from subscription")
			const modelRequest = (r: { method: string; url: string }) =>
				r.method === "POST" && /^\/openai\/v1\/(codex\/responses|responses|chat\/completions)/.test(r.url)
			const [codex] = fixture.fake.requests.slice(first).filter(modelRequest)
			expect(codex.url.split("?")[0]).toBe("/openai/v1/codex/responses")
			expect(codex.headers.authorization).toBe(`Bearer ${chatgptJwt()}`)
			expect(codex.headers["x-api-key"]).toBe("fake")
			expect((codex.body as { model: string }).model).toBe("gpt-5.5")
			trace.step("subscription entry went to the Codex route with both credentials")

			await selectModel(terminal, "5.5 kimchi-dev/openai", "gpt-5.5 (OpenAI prod)")
			const second = await ask(terminal, fixture, "via api key", "from api key")
			const [openai] = fixture.fake.requests.slice(second).filter(modelRequest)
			expect(openai.url.split("?")[0]).toBe("/openai/v1/responses")
			expect(openai.headers.authorization).toMatch(/^Bearer (fake|kimchi-e2e-key)$/)
			expect(openai.headers["x-api-key"]).toBeUndefined()
			expect(openai.headers["x-provider-type"]).toBe("openai")
			expect((openai.body as { model: string }).model).toBe("gpt-5.5")
			trace.step("OpenAI prod entry went to the gateway with only the Kimchi key")
		},
	)
})

test("one session switches Codex model, GLM 5.3, Codex model and every request succeeds", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-switching",
			responses: [{ stream: ["first codex"] }, { stream: ["glm between"] }, { stream: ["second codex"] }],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITH_CHATGPT,
			seedHome: (homeDir) => seedAuth(homeDir, { kimchi: true, chatgpt: true }),
		},
		async (fixture, trace) => {
			await selectModel(terminal, "5.4-codex", "gpt-5.4-codex")
			await ask(terminal, fixture, "one", "first codex")
			await selectModel(terminal, "glm-5.3", "glm-5.3")
			await ask(terminal, fixture, "two", "glm between")
			await selectModel(terminal, "5.4-codex", "gpt-5.4-codex")
			await ask(terminal, fixture, "three", "second codex")
			const routes = fixture.fake.requests
				.filter((r) => r.method === "POST" && /^\/openai\/v1\/(codex\/responses|chat\/completions)/.test(r.url))
				.map((r) => r.url.split("?")[0])
			expect(routes).toEqual([
				"/openai/v1/codex/responses",
				"/openai/v1/chat/completions",
				"/openai/v1/codex/responses",
			])
			trace.step("codex, glm and codex requests all answered")
		},
	)
})

test("a feed without chatgpt entries removes the Codex models on refresh and keeps the stored login", async ({
	terminal,
}) => {
	let authPath = ""
	let modelsPath = ""
	await runKimchiSession(
		terminal,
		{
			artifactName: "chatgpt-gateway-feed-refresh",
			responses: [],
			providerId: "kimchi-dev",
			initialModel: "glm-5.3",
			models: WITHOUT_CHATGPT,
			seedHome: (homeDir) => {
				authPath = join(homeDir, ".config", "kimchi", "harness", "auth.json")
				modelsPath = join(homeDir, ".config", "kimchi", "harness", "models.json")
				seedAuth(homeDir, { kimchi: true, chatgpt: true })
				// A previous session's feed (and pi's old hardcoded list) left a block under pi's own openai-codex id.
				writeFileSync(
					modelsPath,
					JSON.stringify({
						providers: {
							"openai-codex": {
								baseUrl: "https://stale.invalid/openai/v1",
								api: "openai-codex-responses",
								models: [
									{
										id: "gpt-5.4-codex",
										name: "GPT 5.4 Codex",
										reasoning: true,
										input: ["text"],
										contextWindow: 1,
										maxTokens: 1,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									},
								],
							},
						},
					}),
				)
			},
		},
		async (_fixture, trace) => {
			terminal.write("/model")
			await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "PROVIDER", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("openai-codex")
			expect(JSON.parse(readFileSync(modelsPath, "utf-8")).providers["openai-codex"]).toBeUndefined()
			expect(JSON.parse(readFileSync(authPath, "utf-8"))["kimchi-dev/openai-codex"]).toMatchObject({ type: "oauth" })
			trace.step("codex models gone, ChatGPT login still stored")
		},
	)
})
