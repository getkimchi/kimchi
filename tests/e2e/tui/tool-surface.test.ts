/**
 * Tool-surface invariance: toggling ferment on/off must change only ferment's
 * own tools, never unrelated surfaces like codemode or tool_search.
 *
 * Regression context: every chat turn used to apply the "idle" tool profile,
 * which unioned the full registered-tool registry into the model's surface.
 * With ferment enabled (the default), that idle snapshot activated upstream's
 * default-inactive extension tools (`codemode`, `tool_search`) even when the
 * user never configured them — while a ferment-disabled session skipped the
 * snapshot and correctly kept them out. The idle profile now derives from the
 * active surface upstream maintains, so both toggles behave identically.
 *
 * Baseline update (#1756): the guided codemode extension is now default-active
 * by design, so `codemode` belongs on the wire in every chat session; the idle
 * profile must additionally NOT cause its default-off state to flip back.
 * `tool_search` remains default-inactive upstream and must stay out in all
 * four scenarios (it is the name that still witnesses the registry-union bug).
 *
 * The test asserts the real wire surface: the `tools` array of the requests
 * the harness sends the provider.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { RecordedRequest } from "./support/fake-openai-server.js"
import { harnessSettingsPath, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Edit the fixture-seeded harness settings.json from seedHome. */
function patchHarnessSettings(homeDir: string, patch: Record<string, unknown>): void {
	const path = harnessSettingsPath(homeDir)
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	const { resources, ...root } = patch
	Object.assign(settings, root)
	if (resources) {
		const current = (settings.resources ?? {}) as Record<string, unknown>
		settings.resources = { ...current, ...(resources as Record<string, unknown>) }
	}
	writeFileSync(path, JSON.stringify(settings, null, "\t"))
}

/** Union of tool names across every recorded provider request. */
function recordedToolNames(requests: RecordedRequest[]): string[] {
	expect(requests.length).toBeGreaterThan(0)
	const names = new Set<string>()
	for (const request of requests) {
		// Non-chat requests (api-key verify, settings resolve, ...) carry no body.
		const body = request.body as { tools?: Array<{ function?: { name?: string } }> } | undefined
		for (const tool of body?.tools ?? []) {
			if (tool.function?.name) names.add(tool.function.name)
		}
	}
	return [...names]
}

for (const fermentEnabled of [true, false]) {
	test(`ferment ${fermentEnabled ? "enabled" : "disabled"}: default-off tools stay out of the chat surface`, async ({
		terminal,
	}) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `tool-surface-ferment-${fermentEnabled ? "on" : "off"}-no-defaulttools`,
				responses: [{ stream: ["Hello."] }],
				seedHome(homeDir) {
					patchHarnessSettings(homeDir, { resources: { "extensions.ferment": fermentEnabled } })
				},
			},
			async (fixture, trace) => {
				terminal.submit("Hello, just say hi.")
				trace.step("prompt submitted")
				await waitForText(terminal, "Hello.", { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("answer streamed")

				const tools = recordedToolNames(fixture.fake.requests)
				expect(tools).toContain("bash")
				expect(tools).toContain("read")
				expect(tools).toContain("write")
				expect(tools).toContain("codemode")
				expect(tools).not.toContain("tool_search")
				expect(tools.includes("list_ferments")).toBe(fermentEnabled)
				trace.step("wire surface checked")
			},
		)
	})

	for (const { setting, tool, expected } of [
		{ setting: "-codemode", tool: "codemode", expected: false },
		{ setting: "+tool_search", tool: "tool_search", expected: true },
	] as const) {
		test(`ferment ${fermentEnabled ? "enabled" : "disabled"}: defaultTools ${setting} survives`, async ({
			terminal,
		}) => {
			await runKimchiSession(
				terminal,
				{
					artifactName: `tool-surface-ferment-${fermentEnabled ? "on" : "off"}-${setting === "-codemode" ? "minus-codemode" : "plus-tool-search"}`,
					responses: [{ stream: ["Hello."] }],
					seedHome(homeDir) {
						patchHarnessSettings(homeDir, {
							resources: { "extensions.ferment": fermentEnabled },
							defaultTools: [setting],
						})
					},
				},
				async (fixture, trace) => {
					terminal.submit("Hello, just say hi.")
					trace.step("prompt submitted")
					await waitForText(terminal, "Hello.", { timeoutMs: STREAM_TIMEOUT_MS })
					trace.step("answer streamed")

					const tools = recordedToolNames(fixture.fake.requests)
					const counterparty = tool === "codemode" ? "tool_search" : "codemode"
					expect(tools.includes(tool)).toBe(expected)
					if (tool === "codemode") expect(tools).not.toContain(counterparty)
					trace.step("wire surface checked")
				},
			)
		})
	}
}
