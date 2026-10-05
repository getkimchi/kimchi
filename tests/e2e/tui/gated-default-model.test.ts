import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E for the catalog-driven default: organizations whose served
 * catalog carries no `auto` virtual model are gated — their default is the
 * served flash model instead of multi-model, and settings.json `multiModel`
 * is overwritten to false (a seeded default, not a user choice). The fake
 * backend in this file plays the gated catalog: `deepseek-v4-flash` is
 * served, `auto` is not.
 *
 * The multi-model deprecation label is likewise pinned here: the virtual row
 * renders "Deprecated — replaced by Auto." in the /model picker, mirroring
 * the ACP surface's description.
 */

const GATED_MODELS: FakeModel[] = [
	{
		slug: "routine",
		displayName: "Fake Routine",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	},
	{
		slug: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		provider: "ai-enabler",
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	},
]

function chatRequestModels(fixture: { fake: { requests: { url: string; body: unknown }[] } }): unknown[] {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) =>
			request.body && typeof request.body === "object" && "model" in request.body ? request.body.model : undefined,
		)
}

test("gated catalog (no auto) installs the served flash model as the default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "gated-default-install",
			providerId: "kimchi-dev",
			// No CLI model choice: the catalog-driven default is what decides.
			initialModel: false,
			models: GATED_MODELS,
			responses: [{ stream: ["Gated reply."] }],
			seedHome: (homeDir) => {
				// A concrete saved default as login persists one; without it the
				// session has no starting model to roll away from.
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				writeFileSync(
					settingsPath,
					JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "routine" }, null, "\t"),
				)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			// Mirroring the Auto rollback, the install is announced once per
			// fresh session with the escape hatch named.
			await waitForText(terminal, "New sessions start on DeepSeek V4 Flash (the default).", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("gated default install announced")

			terminal.submit("Hello")
			await waitForText(terminal, "Gated reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			// The active model indicator shows the freshly installed default.
			expect(viewText(terminal)).toContain("deepseek-v4-flash")
			// Every chat request asks for the gated default model.
			const models = chatRequestModels(fixture)
			expect(models.length >= 1).toBe(true)
			expect(models.every((model) => model === "deepseek-v4-flash")).toBe(true)
			trace.step("requests go to the gated default model")

			// The seeded global multi-model default is overwritten for gated
			// organizations.
			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
				multiModel?: boolean
			}
			expect(settings.multiModel).toBe(false)
			trace.step("settings.json multiModel overwritten to false")
		},
	)
})

test("the /model picker labels multi-model deprecated", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "gated-multimodel-deprecated-label",
			providerId: "kimchi-dev",
			initialModel: "routine",
			models: GATED_MODELS,
			responses: [],
			seedHome: (homeDir) => {
				// The virtual multi-model row is injected only when the
				// orchestrator role's model exists in the picker list; the
				// default orchestrator is not in this catalog.
				const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(path, "utf-8"))
				settings.modelRoles = { ...settings.modelRoles, orchestrator: "kimchi-dev/routine" }
				writeFileSync(path, JSON.stringify(settings))
			},
		},
		async (_fixture, trace) => {
			terminal.submit("/model")
			await waitForText(terminal, "Only showing models from configured providers", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			const picker = viewText(terminal)
			expect(picker).toContain("multi-model")
			expect(picker).toContain("Deprecated — replaced by Auto.")
			trace.step("picker labels multi-model deprecated")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})
