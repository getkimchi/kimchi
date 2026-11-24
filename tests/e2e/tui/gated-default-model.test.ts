import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import {
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import {
	createKimchiFixture,
	createKimchiSessionController,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
	type TuiScenarioTrace,
	writeTuiArtifact,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E for the catalog-driven default: organizations whose served
 * catalog carries no `auto` virtual model are gated — while no default is
 * saved, their default is the served flash model. The fake backend in this
 * file plays the gated catalog: `deepseek-v4-flash` is served, `auto` is not.
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

test("gated catalog (no auto) starts a fresh user on the served flash model", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "gated-default-install",
			providerId: "kimchi-dev",
			// No CLI model choice: the catalog-driven default is what decides.
			initialModel: false,
			models: GATED_MODELS,
			// No saved default, so the gated default is owed.
			responses: [{ stream: ["Gated reply."] }],
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			trace.step("session ready")

			terminal.submit("Hello")
			await waitForText(terminal, "Gated reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			// The active model indicator shows the gated default.
			expect(viewText(terminal)).toContain("deepseek-v4-flash")
			// Every chat request asks for the gated default model.
			const models = chatRequestModels(fixture)
			expect(models.length >= 1).toBe(true)
			expect(models.every((model) => model === "deepseek-v4-flash")).toBe(true)
			trace.step("requests go to the gated default model")
		},
	)
})

test("relaunches stay on the gated default and respect a later saved default", async ({ terminal }) => {
	// Relaunching over the same HOME must come up on the gated default silently,
	// and a default the user saves afterwards must win without a rollback.
	const artifactName = "gated-default-relaunch-keeps-default"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: false,
		models: GATED_MODELS,
		// No saved default, as in the install scenario.
		responses: [],
	})
	const session = createKimchiSessionController(terminal, fixture, { extraEnv: fixture.seedEnv })
	const steps: { label: string; at: string; view: string }[] = []
	const trace: TuiScenarioTrace = {
		step(label) {
			steps.push({ label, at: new Date().toISOString(), view: viewText(terminal) })
		},
	}

	const settings = () =>
		JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as {
			defaultProvider?: string
			defaultModel?: string
		}

	try {
		// First run comes up on the gated default.
		await session.start()
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		expect(viewText(terminal)).toContain("deepseek-v4-flash")
		trace.step("run 1: came up on the gated default")
		await session.quit()

		// Second run over the same HOME: still the gated default, no notice.
		await session.start()
		// Notifications lag the ready prompt; give any pending notice a moment
		// before asserting its absence.
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		const relaunchView = viewText(terminal)
		expect(relaunchView).not.toContain("New sessions start on")
		expect(relaunchView).toContain("deepseek-v4-flash")
		trace.step("run 2: still on the gated default, no notice")
		await session.quit()

		// A deliberate default pick afterwards wins: simulate the persisted
		// side effect of a /model selection (Enter persists the default), then
		// relaunch. The gated default applies only while no default is saved —
		// no rollback, no notice.
		const settingsPath = join(fixture.agentDir, "settings.json")
		writeFileSync(
			settingsPath,
			JSON.stringify({ ...settings(), defaultProvider: "kimchi-dev", defaultModel: "routine" }, null, "\t"),
		)
		await session.start()
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		const afterPickView = viewText(terminal)
		expect(afterPickView).not.toContain("New sessions start on")
		expect(afterPickView).not.toContain("deepseek-v4-flash")
		trace.step("run 3: deliberate default pick respected, no rollback to the gated default")
		expect(settings().defaultModel).toBe("routine")
	} catch (error) {
		try {
			await writeTuiArtifact({ name: artifactName, outcome: "fail", terminal, fixture, steps, error })
		} catch (writeError) {
			process.stderr.write(`[tui-e2e] failed to write fail artifact: ${String(writeError)}\n`)
		}
		throw error
	} finally {
		await session.quit().catch(() => {})
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
