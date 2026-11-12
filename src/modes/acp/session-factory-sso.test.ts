/**
 * Regression test for the SSO-only machine failure (LLM-4134): after an SSO
 * login the agent dir holds OAuth credentials and no API key. ACP session
 * creation must still resolve the settings default model — before the fix,
 * `createAgentSession` built a bare runtime whose providers lacked the OAuth
 * declaration, so the session fell back to pi's `unknown/unknown` placeholder
 * and newSession tripped the credential gate with
 * "no credentials configured for the selected model".
 *
 * The loader cases pin the same guarantee for `session/load` (both the
 * persisted-file branch and the empty-session recreate branch), and the
 * api-key case proves the OAuth pre-install does not regress API-key auth.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { defaultSessionFactory, defaultSessionLoader } from "./server.js"

const MODEL_ID = "sso-test-model"
const PROVIDER = "kimchi-dev"

/** Mirror of server.ts encodeCwdDir (the sessions directory layout pi uses). */
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

let agentDir: string

async function writeAgentStore(auth: { type: "oauth" } | { type: "api_key"; key: string }) {
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({
			[PROVIDER]:
				auth.type === "oauth"
					? {
							type: "oauth",
							access: "test-access-token",
							refresh: "test-refresh-token",
							expires: Date.now() + 3_600_000,
							orgId: "org-test",
							orgName: "Test Org",
						}
					: { type: "api_key", key: auth.key },
		}),
	)
	// The synced model catalog, as updateModelsConfig writes it: an api-key
	// placeholder config — OAuth activation comes from installKimchiOAuth.
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
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
		JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL_ID }),
	)
}

async function expectResolvedModel(session: { model?: { provider: string; id: string } }) {
	expect(session.model?.provider).toBe(PROVIDER)
	expect(session.model?.id).toBe(MODEL_ID)
}

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "acp-sso-factory-"))
	// SSO-shaped credential store: OAuth only, no api_key entry — written by
	// syncOAuthCredentialToKimchiProviders after an SSO settle.
	await writeAgentStore({ type: "oauth" })
})

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true })
})

describe("defaultSessionFactory on an SSO-only machine", () => {
	it("resolves the settings default model instead of pi's unknown placeholder", async () => {
		const factory = defaultSessionFactory({ extensionFactories: [], agentDir })
		const session = await factory({ cwd: agentDir, mcpServers: [] })
		await expectResolvedModel(session)
	})
})

describe("defaultSessionFactory with API-key auth", () => {
	it("still resolves the settings default model when OAuth providers are pre-installed", async () => {
		await writeAgentStore({ type: "api_key", key: "test-api-key" })
		const factory = defaultSessionFactory({ extensionFactories: [], agentDir })
		const session = await factory({ cwd: agentDir, mcpServers: [] })
		await expectResolvedModel(session)
	})
})

describe("defaultSessionLoader on an SSO-only machine", () => {
	it("recreating an unloaded empty session keeps the settings default model", async () => {
		const factory = defaultSessionFactory({ extensionFactories: [], agentDir })
		const created = await factory({ cwd: agentDir, mcpServers: [] })
		// Pi delays writing a new session until its first assistant response,
		// so loading this freshly-created id hits the recreate branch.
		const loader = defaultSessionLoader({ extensionFactories: [], agentDir })
		const loaded = await loader({ cwd: agentDir, mcpServers: [], sessionId: created.sessionId })
		expect(loaded.sessionId).toBe(created.sessionId)
		await expectResolvedModel(loaded)
	})

	it("loading a persisted session keeps the settings default model", async () => {
		const sessionId = "00000000-0000-4000-8000-000000000001"
		const sessionDir = join(agentDir, "sessions", encodeCwdDir(agentDir))
		await mkdir(sessionDir, { recursive: true })
		// Header-only JSONL as pi writes it: <isoTimestamp>_<sessionId>.jsonl.
		await writeFile(
			join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: agentDir,
			})}\n`,
		)
		const loader = defaultSessionLoader({ extensionFactories: [], agentDir })
		const loaded = await loader({ cwd: agentDir, mcpServers: [], sessionId })
		expect(loaded.sessionId).toBe(sessionId)
		await expectResolvedModel(loaded)
	})
})
