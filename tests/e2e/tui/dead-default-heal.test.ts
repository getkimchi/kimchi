import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E for the dead-default self-heal: a saved defaultModel that the
 * served catalog no longer carries (sunset, de-list, rename) is re-derived
 * on the next fresh launch instead of silently falling back on every start.
 * The fake backend plays the post-sunset catalog: `retired-flash` is gone,
 * `deepseek-v4-flash` is the served heir, `auto` is not served.
 */

const POST_SUNSET_MODELS: FakeModel[] = [
	{
		slug: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	},
]

test("a saved default removed from the catalog is healed to the served heir with a notice", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "dead-default-heal",
			providerId: "kimchi-dev",
			initialModel: false,
			models: POST_SUNSET_MODELS,
			responses: [{ stream: ["Healed reply."] }],
			seedHome: (homeDir) => {
				// Post-migration state from the gated default: a concrete default
				// with multiModel=false, whose model has since left the catalog.
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "retired-flash" }),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			// The heal is announced: the dead model is named and the new default stated.
			await waitForText(terminal, 'Default model "retired-flash" is no longer served and has been replaced.', {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("dead-default heal announced")

			terminal.submit("Hello")
			await waitForText(terminal, "Healed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			// The request goes to the served heir, not upstream's silent fallback.
			const chatModels = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) =>
					request.body && typeof request.body === "object" && "model" in request.body ? request.body.model : undefined,
				)
			expect(chatModels.length >= 1).toBe(true)
			expect(chatModels.every((model) => model === "deepseek-v4-flash")).toBe(true)
			trace.step("requests go to the healed default")

			// The persisted default points at the heir, so the next launch heals nothing.
			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
				defaultModel?: string
				multiModel?: boolean
			}
			expect(settings.defaultModel).toBe("deepseek-v4-flash")
			// Multi-model is never re-enabled by the heal — it stays off for good.
			expect(settings.multiModel).not.toBe(true)
			trace.step("settings.json default healed to the served model")
		},
	)
})

test("a metadata-declared replacement outranks catalog order when healing a dead default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "dead-default-heal-successor",
			providerId: "kimchi-dev",
			initialModel: false,
			// Catalog order would pick the flash model; the backend's declared
			// replacement (sidecar) must win instead.
			models: [
				{
					slug: "deepseek-v4-flash",
					displayName: "DeepSeek V4 Flash",
					provider: "ai-enabler",
					input: ["text"],
					contextWindow: 1_000_000,
					maxTokens: 8_192,
				},
				{
					slug: "kimi-k3",
					displayName: "Kimi K3",
					provider: "ai-enabler",
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 16_384,
				},
			],
			responses: [{ stream: ["Successor reply."] }],
			seedHome: (homeDir) => {
				const harnessDir = join(homeDir, ".config", "kimchi", "harness")
				const settingsPath = join(harnessDir, "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "retired-flash" }),
				)
				// The backend metadata sidecar: the dead model's declared replacement.
				writeFileSync(
					join(harnessDir, "model-deprecations.json"),
					JSON.stringify({
						"retired-flash": {
							replacement_model: "kimi-k3",
							deprecation_note: "https://docs.kimchi.dev/deprecations/retired-flash",
						},
					}),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			await waitForText(terminal, 'Default model "retired-flash" is no longer served and has been replaced.', {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			// The declared successor wins over catalog order, and the note rides along.
			await waitForText(terminal, "https://docs.kimchi.dev/deprecations/retired-flash", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("metadata-successor heal announced with the deprecation note")

			terminal.submit("Hello")
			await waitForText(terminal, "Successor reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			const chatModels = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) =>
					request.body && typeof request.body === "object" && "model" in request.body ? request.body.model : undefined,
				)
			expect(chatModels.length >= 1).toBe(true)
			expect(chatModels.every((model) => model === "kimi-k3")).toBe(true)
			trace.step("requests go to the metadata-declared successor")

			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
				defaultModel?: string
			}
			expect(settings.defaultModel).toBe("kimi-k3")
			trace.step("settings.json default healed to the declared successor")
		},
	)
})
