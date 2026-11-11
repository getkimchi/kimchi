/**
 * Regression test for the SSO-only machine failure (LLM-4134): after an SSO
 * login the agent dir holds OAuth credentials and no API key. ACP session
 * creation must still resolve the settings default model — before the fix,
 * `createAgentSession` built a bare runtime whose providers lacked the OAuth
 * declaration, so the session fell back to pi's `unknown/unknown` placeholder
 * and newSession tripped the credential gate with
 * "no credentials configured for the selected model".
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { defaultSessionFactory } from "./server.js"

const MODEL_ID = "sso-test-model"

let agentDir: string

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "acp-sso-factory-"))
	// SSO-shaped credential store: OAuth only, no api_key entry — written by
	// syncOAuthCredentialToKimchiProviders after an SSO settle.
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"kimchi-dev": {
				type: "oauth",
				access: "test-access-token",
				refresh: "test-refresh-token",
				expires: Date.now() + 3_600_000,
				orgId: "org-test",
				orgName: "Test Org",
			},
		}),
	)
	// The synced model catalog, as updateModelsConfig writes it: an api-key
	// placeholder config — OAuth activation comes from installKimchiOAuth.
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"kimchi-dev": {
					baseUrl: "https://llm.example.invalid/openai/v1",
					apiKey: "$KIMCHI_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: MODEL_ID,
							name: "SSO Test Model",
							reasoning: false,
							input: ["text"],
							contextWindow: 128_000,
							maxTokens: 8_192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	)
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "kimchi-dev", defaultModel: MODEL_ID }),
	)
})

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true })
})

describe("defaultSessionFactory on an SSO-only machine", () => {
	it("resolves the settings default model instead of pi's unknown placeholder", async () => {
		const factory = defaultSessionFactory({ extensionFactories: [], agentDir })
		const session = await factory({ cwd: agentDir, mcpServers: [] })
		expect(session.model?.provider).toBe("kimchi-dev")
		expect(session.model?.id).toBe(MODEL_ID)
	})
})
