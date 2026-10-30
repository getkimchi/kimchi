/**
 * Outcome-parity suite: `kimchi login` (CLI) and `/login` (TUI) drive the
 * same flow functions (src/extensions/login/flow.ts), so for equal choices
 * they must leave identical state behind. Each test runs both surfaces
 * against the same mocked seams (browser OAuth, models API, discovery) and
 * compares the persisted outcome: the in-memory config writes, and the
 * files in the agent dir (models.json, auth.json, settings.json, sidecars).
 *
 * Config writes go through spied config functions backed by an in-memory
 * state (KIMCHI_CONFIG_PATH is resolved at module load, so the real writer
 * must never run against the developer's config); the agent dir is a real
 * temp dir so syncPiAuth / syncOAuthCredentialToKimchiProviders /
 * applyOrganizationHeader / SettingsManager write real files.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initTheme, ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({
	spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
	select: vi.fn(),
	password: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	multiselect: vi.fn(),
	isCancel: () => false,
}))
vi.mock("../cli-auth/index.js", () => ({ authenticateViaBrowser: vi.fn() }))
vi.mock("../cli-auth/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../cli-auth/oauth.js")>()
	return { ...actual, loginWithCastAiOauth: vi.fn() }
})
vi.mock("../extensions/billing/status.js", () => ({ refreshBillingStatusFromConfig: vi.fn() }))
vi.mock("../self-hosted-discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../self-hosted-discovery.js")>()
	return { ...actual, fetchSelfHostedEndpoints: vi.fn() }
})
vi.mock("./login-prompts.js", () => ({
	promptLoginMethod: vi.fn(),
	promptLoginRegion: vi.fn(),
	promptSelfHostedConsoleEndpoints: vi.fn(),
	promptKimchiApiKey: vi.fn(),
	promptKimchiEndpoint: vi.fn(),
	createCliSsoCallbacks: vi.fn(() => ({})),
}))

import { authenticateViaBrowser } from "../cli-auth/index.js"
import { loginWithCastAiOauth } from "../cli-auth/oauth.js"
import * as configModule from "../config.js"
import { resetCredentialStalenessForTests } from "../credential-staleness.js"
import * as experimentalModule from "../extensions/experimental.js"
import {
	completeKimchiSsoLogin,
	installKimchiOAuth,
	type KimchiBrowserLoginHost,
	performKimchiApiKeyLogin,
	performKimchiBrowserLogin,
} from "../extensions/login/flow.js"
import { syncOAuthCredentialToKimchiProviders } from "../pi-auth.js"
import type { RegionId, SelfHostedEndpoints } from "../regions.js"
import { fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"
import { runLogin } from "./login.js"
import { promptKimchiApiKey, promptKimchiEndpoint, promptLoginMethod, promptLoginRegion } from "./login-prompts.js"

const INTERACTIVE = { isInteractive: () => true }

const DISCOVERED_ENDPOINTS: SelfHostedEndpoints = {
	api: "https://kimchi.example.com",
	console: "https://kimchi.example.com",
	llm: "https://llm.example.com",
}

/** Minimal ModelMetadata catalog entry (gateway response shape — see models.test.ts). */
const KIMI = {
	slug: "kimi-k3",
	display_name: "Kimi K3",
	provider: "ai-enabler",
	reasoning: true,
	input_modalities: ["text", "image"],
	is_serverless: true,
	limits: { context_window: 262144, max_output_tokens: 262144 },
	thinking_levels: ["low", "off", "max", "high"],
}

const SSO_CREDENTIAL = {
	type: "oauth" as const,
	access: "sso-access-token",
	refresh: "sso-refresh-token",
	// Fixed expiry: deterministic file contents on both surfaces.
	expires: 1_900_000_000_000,
	region: "eu",
	tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
	clientId: "sso-client-id",
	useIdToken: true,
	idToken: "sso-access-token",
	accessToken: "sso-access-token",
	orgId: "org-1",
	orgName: "Acme",
}

interface ConfigState {
	apiKey: string
	region: RegionId
	llmEndpoint?: string
	selfHostedEndpoints?: SelfHostedEndpoints
}

function freshConfigState(): ConfigState {
	return { apiKey: "", region: "us" }
}

/** Spy the config-module surface over the given in-memory state. */
function spyConfig(state: ConfigState): void {
	vi.spyOn(configModule, "loadConfig").mockImplementation(
		() =>
			({
				apiKey: state.apiKey,
				region: state.region,
				...(state.llmEndpoint ? { llmEndpoint: state.llmEndpoint } : {}),
				...(state.selfHostedEndpoints ? { selfHostedEndpoints: state.selfHostedEndpoints } : {}),
			}) as unknown as ReturnType<typeof configModule.loadConfig>,
	)
	// Mirror the real writeApiKey semantics: region travels with options, a
	// missing llmEndpoint clears the stored custom endpoint, and self-hosted
	// endpoints persist only when passed.
	vi.spyOn(configModule, "writeApiKey").mockImplementation((key, _path, options) => {
		state.apiKey = key
		if (options?.region) state.region = options.region
		if (options?.selfHostedEndpoints) state.selfHostedEndpoints = options.selfHostedEndpoints
		state.llmEndpoint = options?.llmEndpoint?.trim() || undefined
	})
	vi.spyOn(configModule, "writeRegion").mockImplementation((region) => {
		state.region = region
	})
	vi.spyOn(configModule, "clearApiKey").mockImplementation(() => {
		state.apiKey = ""
	})
}

interface SideResult {
	exit?: number
	agentDir: string
	configState: ConfigState
	writeApiKeyCalls: unknown[][]
	files: Record<string, string>
}

const tempDirs: string[] = []
function allocateAgentDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `kimchi-login-parity-${tag}-`))
	tempDirs.push(dir)
	return dir
}

/** restoreAllMocks clears module-factory implementations — re-arm the seams every side needs. */
function armSharedSeams(): void {
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "test-key" })
	vi.mocked(fetch).mockImplementation(
		async () => ({ ok: true, json: async () => ({ models: [KIMI] }) }) as unknown as Response,
	)
}

function slurpFiles(dir: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name)
		if (statSync(path).isFile()) out[name] = readFileSync(path, "utf-8")
	}
	return out
}

/**
 * prepare() runs AFTER the internal mock arm-up — module-factory mock
 * implementations (prompts, OAuth, discovery) must be set there, not in the
 * test body, because restoreAllMocks runs first.
 */
async function runCliSide(prepare: () => void, args: string[] = []): Promise<SideResult> {
	vi.restoreAllMocks()
	armSharedSeams()
	const agentDir = allocateAgentDir("cli")
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
	const configState = freshConfigState()
	spyConfig(configState)
	prepare()
	const exit = await runLogin(args, INTERACTIVE)
	return {
		exit,
		agentDir,
		configState,
		writeApiKeyCalls: [...vi.mocked(configModule.writeApiKey).mock.calls],
		files: slurpFiles(agentDir),
	}
}

/**
 * The TUI half: drive the same flow functions with a session-shaped host
 * (setModel persists via SettingsManager exactly like session.setModel
 * (…, { persist: true }); no prior model — the fresh-login case).
 */
async function runTuiSide(run: (host: KimchiBrowserLoginHost) => Promise<unknown>): Promise<SideResult> {
	vi.restoreAllMocks()
	armSharedSeams()
	const agentDir = allocateAgentDir("tui")
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
	const configState = freshConfigState()
	spyConfig(configState)
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	})
	// Mirror the TUI login extension (src/extensions/login/index.ts): it calls
	// pi.registerProvider("kimchi-dev", { oauth }) + per-sub-provider, which is
	// what activates OAuth-stored credentials for Kimchi providers on the
	// session runtime.
	installKimchiOAuth(runtime)
	const settings = SettingsManager.create(process.cwd(), agentDir)
	const host: KimchiBrowserLoginHost = {
		modelRegistry: new ModelRegistry(runtime),
		setModel: (model) => {
			settings.setDefaultModelAndProvider(model.provider, model.id)
		},
		getCurrentModel: () => undefined,
		showStatus: () => {},
		showError: () => {},
		addFeedback: () => {},
	}
	await run(host)
	return {
		agentDir,
		configState,
		writeApiKeyCalls: [...vi.mocked(configModule.writeApiKey).mock.calls],
		files: slurpFiles(agentDir),
	}
}

function expectSameOutcome(cli: SideResult, tui: SideResult): void {
	expect(cli.exit).toBe(0)
	expect(cli.configState).toEqual(tui.configState)
	expect(cli.writeApiKeyCalls).toEqual(tui.writeApiKeyCalls)
	expect(cli.files).toEqual(tui.files)
}

beforeAll(() => {
	initTheme("default")
})

beforeEach(() => {
	vi.clearAllMocks()
	experimentalModule.setExperimentalFeaturesEnabled(true)
	resetCredentialStalenessForTests()
	vi.stubEnv("KIMCHI_API_KEY", undefined)
	vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
	experimentalModule.setExperimentalFeaturesEnabled(false)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("CLI ↔ /login outcome parity", () => {
	it("Kimchi account login in a picked region (EU) leaves identical state", async () => {
		const cli = await runCliSide(() => {
			vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "account" })
			vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "eu" })
		})
		const tui = await runTuiSide((host) => performKimchiBrowserLogin(host, { region: "eu" }))

		expectSameOutcome(cli, tui)
		// The persisted config records the picked region alongside the key.
		expect(cli.writeApiKeyCalls).toEqual([["test-key", undefined, { region: "eu" }]])
		// And the catalog + credential + default model landed in the agent dir.
		expect(cli.files["models.json"]).toBeDefined()
		expect(cli.files["auth.json"]).toContain("test-key")
		expect(cli.files["settings.json"]).toContain("defaultProvider")
	})

	it("Kimchi API-key login leaves identical state", async () => {
		const cli = await runCliSide(() => {
			vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "api-key" })
			vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "us" })
			vi.mocked(promptKimchiApiKey).mockResolvedValue({ kind: "next", value: "castai_v1_key" })
			vi.mocked(promptKimchiEndpoint).mockResolvedValue({ kind: "next", value: "https://api.us.kimchi.dev" })
		})
		const tui = await runTuiSide((host) =>
			performKimchiApiKeyLogin(host, {
				apiKey: "castai_v1_key",
				endpoint: "https://api.us.kimchi.dev",
				region: "us",
			}),
		)

		expectSameOutcome(cli, tui)
		expect(cli.writeApiKeyCalls).toEqual([
			["castai_v1_key", undefined, { llmEndpoint: "https://api.us.kimchi.dev", region: "us" }],
		])
	})

	it("CAST AI SSO login leaves identical state", async () => {
		const cli = await runCliSide(() => {
			vi.mocked(loginWithCastAiOauth).mockResolvedValue({ ...SSO_CREDENTIAL })
			vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "sso" })
			vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "eu" })
		})
		// The TUI's extension-UI SSO tail: sync the credential out to every
		// Kimchi provider, then run the completion steps.
		const tui = await runTuiSide(async (host) => {
			const agentDir = process.env.KIMCHI_CODING_AGENT_DIR as string
			await syncOAuthCredentialToKimchiProviders(join(agentDir, "auth.json"), join(agentDir, "models.json"), {
				...SSO_CREDENTIAL,
			})
			await completeKimchiSsoLogin(host)
		})

		expectSameOutcome(cli, tui)
		// SSO persists its credential in auth.json (OAuth), not config.json.
		expect(cli.writeApiKeyCalls).toEqual([])
		expect(cli.files["auth.json"]).toContain("sso-refresh-token")
		expect(cli.files["models.json"]).toContain("org-1")
	})

	it("the self-hosted shortcut `kimchi login <console-url>` matches the /login self-hosted account path", async () => {
		const cli = await runCliSide(() => {
			vi.mocked(fetchSelfHostedEndpoints).mockResolvedValue({ status: "discovered", endpoints: DISCOVERED_ENDPOINTS })
		}, ["https://kimchi.example.com"])

		const tui = await runTuiSide((host) =>
			performKimchiBrowserLogin(host, { region: "self-hosted", selfHostedEndpoints: DISCOVERED_ENDPOINTS }),
		)

		// The browser flow targets the console (the SPA serving /cli-auth).
		expect(authenticateViaBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ webAppUrl: "https://kimchi.example.com" }),
		)
		// Region + discovered endpoints persist with the key on both surfaces.
		expect(cli.configState).toEqual({
			apiKey: "test-key",
			llmEndpoint: undefined,
			region: "self-hosted",
			selfHostedEndpoints: DISCOVERED_ENDPOINTS,
		})
		expect(cli.files).toEqual(tui.files)
	})
})
