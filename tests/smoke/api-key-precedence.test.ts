import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { startFakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")

const execFileAsync = promisify(execFile)

// The KIMCHI_API_KEY env override is session-only: it wins on the wire for the
// whole run and warns when it differs from the saved key, but nothing is
// persisted back to disk and the key is never exported into tool subprocesses.
// A rejected override must fail fast, before any request leaves the process.
it.each([false, true])("honors the environment override in headless mode (rejected=%s)", async (rejected) => {
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-ci-auth-"))
	const fake = await startFakeOpenAiServer({
		models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
		rejectedApiKeys: rejected ? ["ci-key"] : ["fake"],
		responses: [
			{
				toolCalls: [
					{
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command:
									"if printenv KIMCHI_API_KEY >/dev/null; then echo KIMCHI_KEY_PRESENT; else echo KIMCHI_KEY_ABSENT; fi",
							}),
						},
					},
				],
			},
			{ stream: ["CI authentication works."] },
		],
	})
	try {
		// Saved state: config.json and auth.json both hold the saved key "fake";
		// the override "ci-key" arrives only via KIMCHI_API_KEY.
		const configDir = join(homeDir, ".config", "kimchi")
		mkdirSync(join(configDir, "harness"), { recursive: true })
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({ apiKey: "fake", llmEndpoint: fake.baseUrl, skillPaths: [], migrationState: "done" }),
			{ mode: 0o600 },
		)
		const authPath = join(configDir, "harness", "auth.json")
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev/openai": { type: "api_key", key: "fake" } }), { mode: 0o600 })
		const originalAuth = readFileSync(authPath, "utf-8")
		const args = ["--print", "--provider", "kimchi-dev/openai", "--model", "ci-model", "--no-session", "Say hello"]
		const options = {
			cwd: homeDir,
			timeout: 12000,
			env: {
				PATH: process.env.PATH,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "ci-key",
				KIMCHI_PERMISSIONS: "yolo",
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
		}
		const run = execFileAsync(BINARY_PATH, args, options)
		run.child.stdin?.end()
		if (rejected) {
			// The override itself is invalid: fail fast before any request leaves.
			// The stderr message is a deliberate user-facing contract from cli.ts,
			// so it is pinned verbatim here.
			await expect(run).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining(
					"KIMCHI_API_KEY environment variable contains an invalid API key. Update or delete the environment variable, then restart Kimchi.",
				),
			})
			expect(fake.requests.some((request) => request.url.includes("chat/completions"))).toBe(false)
		} else {
			const { stdout, stderr } = await run
			expect(stdout).toContain("CI authentication works.")
			expect(stdout).not.toContain("KIMCHI_API_KEY differs")
			expect(stderr).toContain("Warning: KIMCHI_API_KEY differs from your saved key")
			// Every chat request must authenticate with the env key, never the
			// saved one, and tool subprocesses must not observe the override.
			const chats = fake.requests.filter((request) => request.url.includes("chat/completions"))
			expect(chats.every((request) => request.headers.authorization === "Bearer ci-key")).toBe(true)
			expect(chats.map((request) => request.body)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						messages: expect.arrayContaining([
							expect.objectContaining({ role: "tool", content: expect.stringContaining("KIMCHI_KEY_ABSENT") }),
						]),
					}),
				]),
			)
		}
		// The startup metadata refresh also authenticates with the env key, and
		// nothing learned from the override is persisted: config keeps the saved
		// key, auth.json stays byte-identical, and no models.json is written.
		const metadata = fake.requests.filter((request) => request.url.startsWith("/v1/models/metadata"))
		expect(metadata.length).toBeGreaterThan(0)
		expect(metadata.every((request) => request.headers.authorization === "Bearer ci-key")).toBe(true)
		const config = JSON.parse(readFileSync(join(homeDir, ".config", "kimchi", "config.json"), "utf-8"))
		expect(config.apiKey).toBe("fake")
		expect(readFileSync(authPath, "utf-8")).toBe(originalAuth)
		expect(existsSync(join(configDir, "harness", "models.json"))).toBe(false)
	} finally {
		await fake.stop()
		rmSync(homeDir, { recursive: true, force: true })
	}
})

/**
 * Scaffold for the stale-key scenarios below. The fake API rejects both
 * "expired-saved-key" (the key stored in config.json) and "expired-env-key"
 * (an optional env override). models.json defines a custom BYOK provider plus
 * a Kimchi provider, and auth.json stores a stale Kimchi credential beside the
 * custom one. The two tests then watch which key reaches the wire and which
 * files move on disk.
 */
async function startStaleKeyScenario() {
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-custom-provider-auth-"))
	const fake = await startFakeOpenAiServer({
		rejectedApiKeys: ["expired-saved-key", "expired-env-key"],
		responses: [{ stream: ["Custom provider authentication works."] }],
	})
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })
	const configPath = join(configDir, "config.json")
	writeFileSync(
		configPath,
		JSON.stringify({
			apiKey: "expired-saved-key",
			llmEndpoint: fake.baseUrl,
			skillPaths: [],
			migrationState: "done",
		}),
		{ mode: 0o600 },
	)
	const customProvider = {
		baseUrl: `${fake.baseUrl}/openai/v1`,
		apiKey: "custom-key",
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: "custom-model",
				name: "Custom Model",
				reasoning: false,
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	}
	const modelsPath = join(agentDir, "models.json")
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				custom: customProvider,
				"kimchi-dev/openai": { ...customProvider, apiKey: "$KIMCHI_API_KEY" },
			},
		}),
		{ mode: 0o600 },
	)
	const authPath = join(agentDir, "auth.json")
	const savedAuth = JSON.stringify({
		"kimchi-dev/openai": { type: "api_key", key: "valid-stored-kimchi-key" },
		custom: { type: "api_key", key: "custom-key" },
	})
	writeFileSync(authPath, savedAuth, { mode: 0o600 })
	return { homeDir, fake, configPath, modelsPath, authPath, savedAuth, customProvider }
}

/** Spawn the built binary headless (--print) against the scenario providers. */
function runHeadless(homeDir: string, provider: string, envKey: string) {
	const run = execFileAsync(
		BINARY_PATH,
		["--print", "--provider", provider, "--model", "custom-model", "--no-session", "Say hello"],
		{
			cwd: homeDir,
			timeout: 12000,
			env: {
				PATH: process.env.PATH,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: envKey,
				KIMCHI_PERMISSIONS: "yolo",
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
		},
	)
	// Headless stdin is never read; close it so the process cannot block on it.
	run.child.stdin?.end()
	return run
}

// A rejected env override is fatal regardless of the selected provider: the
// CLI exits before any chat/completions request is sent, and saved
// config/auth/models stay byte-identical — the run died before touching them.
it.each([
	"custom",
	"kimchi-dev/openai",
])("rejects an invalid environment key before any request leaves (provider=%s)", async (provider) => {
	const scenario = await startStaleKeyScenario()
	try {
		const run = runHeadless(scenario.homeDir, provider, "expired-env-key")
		// The message is a deliberate user-facing contract from cli.ts — pinned exactly.
		await expect(run).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining(
				"KIMCHI_API_KEY environment variable contains an invalid API key. Update or delete the environment variable, then restart Kimchi.",
			),
		})
		expect(scenario.fake.requests.some((request) => request.url.includes("chat/completions"))).toBe(false)
		// The rejected env override was still offered to the startup metadata refresh.
		const metadata = scenario.fake.requests.find((request) => request.url.startsWith("/v1/models/metadata"))
		expect(metadata?.headers.authorization).toBe("Bearer expired-env-key")
		expect(JSON.parse(readFileSync(scenario.configPath, "utf-8")).apiKey).toBe("expired-saved-key")
		expect(JSON.parse(readFileSync(scenario.modelsPath, "utf-8")).providers.custom).toEqual(scenario.customProvider)
		expect(readFileSync(scenario.authPath, "utf-8")).toBe(scenario.savedAuth)
	} finally {
		await scenario.fake.stop()
		rmSync(scenario.homeDir, { recursive: true, force: true })
	}
})

// With no env override, a stale saved Kimchi key must not break startup or
// other providers. The metadata refresh 401 falls back to the cached model
// list, and startup re-syncs the Kimchi credential in auth.json from
// config.json. A run routed to the custom BYOK provider still succeeds with its
// own key; a run routed to Kimchi fails at request time with exit code 1.
// Either way, the custom provider's files and credential survive untouched.
it.each([
	"custom",
	"kimchi-dev/openai",
])("preserves auth after a Kimchi 401 on the saved key (provider=%s)", async (provider) => {
	const scenario = await startStaleKeyScenario()
	try {
		const run = runHeadless(scenario.homeDir, provider, "")
		if (provider === "custom") {
			// BYOK auth is independent of the Kimchi 401: the run succeeds, and the
			// background refresh failure only surfaces as a stderr warning.
			const { stdout, stderr } = await run
			expect(stdout).toContain("Custom provider authentication works.")
			expect(stderr).toContain("401")
			const chat = scenario.fake.requests.find((request) => request.url.includes("chat/completions"))
			expect(chat?.headers.authorization).toBe("Bearer custom-key")
		} else {
			// Routed to Kimchi with the stale saved key: the API itself rejects the
			// request. Pin the exit code and the rejection loosely — the exact
			// provider-side wording is not a contract we own.
			await expect(run).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining('401 "Invalid API key"'),
			})
			expect(
				scenario.fake.requests
					.filter((request) => request.url.includes("chat/completions"))
					.map((request) => request.headers.authorization),
			).not.toContain("Bearer valid-stored-kimchi-key")
		}
		// Shared end-state: the metadata refresh authenticated with the saved key
		// and 401'd; config.json and the custom provider definition are intact;
		// auth.json now holds the config key for Kimchi (cli.ts syncPiAuth) with
		// the custom credential preserved.
		const metadata = scenario.fake.requests.find((request) => request.url.startsWith("/v1/models/metadata"))
		expect(metadata?.headers.authorization).toBe("Bearer expired-saved-key")
		expect(JSON.parse(readFileSync(scenario.configPath, "utf-8")).apiKey).toBe("expired-saved-key")
		expect(JSON.parse(readFileSync(scenario.modelsPath, "utf-8")).providers.custom).toEqual(scenario.customProvider)
		expect(JSON.parse(readFileSync(scenario.authPath, "utf-8"))).toEqual({
			"kimchi-dev/openai": { type: "api_key", key: "expired-saved-key" },
			custom: { type: "api_key", key: "custom-key" },
		})
	} finally {
		await scenario.fake.stop()
		rmSync(scenario.homeDir, { recursive: true, force: true })
	}
})
