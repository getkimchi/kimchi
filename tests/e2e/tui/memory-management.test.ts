import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { readMemoryFact, seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

test("memory info and metadata editing behave through the TUI and persist", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-management-info-edit",
			responses: [],
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.memory", KIMCHI_MEMORY_CAPTURE: "off" },
			enableMemoryEmbeddings: true,
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, [{ id: "e2e-fred", text: "the user's dog is named Fred" }])
			},
		},
		async (fixture, trace) => {
			terminal.submit("/memory list")
			await waitForText(terminal, "Memory — 1 fact")
			terminal.write("i")
			await waitForText(terminal, "Memory evidence — e2e-fred")
			expect(viewText(terminal)).toContain("kind=unclassified")
			trace.step("read exact fact evidence in the interactive panel")

			terminal.write("i")
			await waitForText(terminal, "the user's dog is named Fred")
			terminal.write("q")
			terminal.submit("/memory edit e2e-fred --confidence 0 --note reviewed unpin --scope personal --yes")
			await waitForText(terminal, "Edited memory e2e-fred")

			terminal.submit("/memory explain e2e-fred")
			await waitForText(terminal, "source=authored")
			await waitForText(terminal, "canonical=false")
			await waitForText(terminal, "confidence=0.00")
			trace.step("precise metadata edit confirmed on both management surfaces")

			const stored = readMemoryFact(fixture.homeDir, "e2e-fred")
			expect(stored.payload).toMatchObject({
				source: "authored",
				canonical: false,
				confidence: 0,
				attributes: { note: "reviewed" },
			})

			terminal.submit("/memory list")
			await waitForText(terminal, "Memory — 1 fact")
			terminal.write("i")
			await waitForText(terminal, "confidence=0.00")
			expect(viewText(terminal)).toContain("canonical=false")
			expect(viewText(terminal)).toContain("source=authored")
		},
	)
})
