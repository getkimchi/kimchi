import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForRequest, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

test("detached memory retrieval shows only the ordinary working spinner", async ({ terminal }) => {
	let releaseEmbedding: (() => void) | undefined
	let releaseAnswer: (() => void) | undefined
	const embeddingHold = new Promise<void>((resolve) => {
		releaseEmbedding = resolve
	})
	const answerHold = new Promise<void>((resolve) => {
		releaseAnswer = resolve
	})

	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-recall-hidden",
			responses: [{ stream: ["First turn complete."] }, { holdUntil: answerHold, stream: ["Follow-up complete."] }],
			enableMemoryEmbeddings: true,
			memoryEmbeddingHold: { inputIncludes: "what should I bake today?", until: embeddingHold },
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.memory", KIMCHI_MEMORY_DECISION_GATE: "off" },
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, [{ id: "e2e-fred", text: "the user's dog is named Fred" }])
			},
		},
		async (fixture, trace) => {
			terminal.submit("tell me about my dog")
			await waitForText(terminal, "First turn complete.")
			trace.step("initial memory lookup completed")

			terminal.submit("what should I bake today?")
			try {
				await waitForRequest(
					fixture.fake.requests,
					(request) =>
						request.url.endsWith("/embeddings") && JSON.stringify(request.body).includes("what should I bake today?"),
					"detached memory embedding",
				)
				expect(viewText(terminal)).toMatch(/(Stirring|Marinating|Chopping|Cooking)/)
				expect(viewText(terminal)).not.toContain("Recalling memory")
				trace.step("detached retrieval stayed hidden while its embedding was held")
			} finally {
				releaseEmbedding?.()
				releaseAnswer?.()
			}

			await waitForText(terminal, "Follow-up complete.")
			expect(viewText(terminal)).not.toMatch(/(Stirring|Marinating|Chopping|Cooking)/)
		},
	)
})
