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
import type { FakeModel } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * ChatGPT subscription models through the gateway.
 *
 * The stubbed gateway serves chatgpt rows in /v1/models/metadata and a
 * /openai/v1/codex/responses route. The ChatGPT browser login itself is not
 * stubbable, so "after ChatGPT login" seeds the stored openai-codex OAuth
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
				? { "openai-codex": { type: "oauth", access: chatgptJwt(), refresh: "", expires: 4_102_444_800_000 } }
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
			expect(picker).toContain("openai-codex")
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
			expect(picker).toMatch(/gpt-5\.4-codex\s+openai-codex/)
			trace.step("one entry per provider, labelled by instance name")
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
				// A previous session's feed (and pi's old hardcoded list) left an openai-codex block.
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
			expect(JSON.parse(readFileSync(authPath, "utf-8"))["openai-codex"]).toMatchObject({ type: "oauth" })
			trace.step("codex models gone, ChatGPT login still stored")
		},
	)
})
