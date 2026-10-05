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
 * catalog carries no `auto` virtual model are gated — their default is the
 * served flash model instead of multi-model, and settings.json `multiModel`
 * is overwritten to false (a seeded default, not a user choice). The fake
 * backend in this file plays the gated catalog: `deepseek-v4-flash` is
 * served, `auto` is not.
 *
 * The multi-model deprecation label is likewise pinned here: the virtual row
 * renders "[to be deprecated]" in the /model picker, mirroring
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

test("a relaunch keeps the installed gated default without re-announcing it", async ({ terminal }) => {
	// The install notice is a one-time announcement per fresh-session-after-switch;
	// a plain relaunch over the same HOME must come up on the persisted default
	// silently. Guards the seeded-default flow against notice spam and against
	// any writer that could shadow the installed default between runs.
	const artifactName = "gated-default-relaunch-keeps-default"
	const fixture = await createKimchiFixture({
		providerId: "kimchi-dev",
		initialModel: false,
		models: GATED_MODELS,
		responses: [],
		seedHome: (homeDir) => {
			// Same "login persisted a concrete default" seed as the install scenario.
			const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
			writeFileSync(
				settingsPath,
				JSON.stringify({ ...settings, defaultProvider: "kimchi-dev", defaultModel: "routine" }, null, "\t"),
			)
		},
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
			multiModel?: boolean
		}

	try {
		// First run installs and announces the gated default.
		await session.start()
		await waitForText(terminal, "New sessions start on DeepSeek V4 Flash (the default).", {
			timeoutMs: INPUT_TIMEOUT_MS,
			full: false,
		})
		trace.step("run 1: gated default install announced")

		await session.quit()
		const afterRunOne = settings()
		expect(afterRunOne.defaultProvider).toBe("kimchi-dev")
		expect(afterRunOne.defaultModel).toBe("deepseek-v4-flash")
		expect(afterRunOne.multiModel).toBe(false)
		trace.step("run 1 exit: default persisted, multiModel seeded false")

		// Second run over the same HOME: the persisted default must hold and the
		// install must not be re-announced.
		await session.start()
		// Notifications lag the ready prompt; give any pending notice a moment
		// before asserting its absence.
		await new Promise((resolve) => setTimeout(resolve, 2_000))
		const relaunchView = viewText(terminal)
		expect(relaunchView).not.toContain("New sessions start on")
		expect(relaunchView).toContain("deepseek-v4-flash")
		trace.step("run 2: came up on the persisted default, notice not repeated")
		expect(settings().defaultModel).toBe("deepseek-v4-flash")
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
			expect(picker).toContain("[to be deprecated]")
			trace.step("picker labels multi-model deprecated")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		},
	)
})
