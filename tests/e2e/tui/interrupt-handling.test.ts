import { Shell, expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { createKimchiFixture, launchKimchi, stopKimchi, writeTuiArtifact } from "./support/kimchi-fixture.js"

test.use({
	shell: Shell.Bash,
	rows: 40,
	columns: 120,
})

test("ctrl-c clears draft input and aborts streaming response", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [
			{
				stream: ["first chunk ", "second chunk ", "third chunk "],
				delayMs: 500,
			},
		],
	})

	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: 10_000 })

		terminal.write("draft that should clear")
		await waitForText(terminal, "draft that should clear", { timeoutMs: 5_000 })
		terminal.keyCtrlC()
		await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: 5_000 })
		expect(viewText(terminal)).not.toContain("draft that should clear")

		terminal.submit("Stream slowly")
		await waitForText(terminal, "first chunk", { timeoutMs: 15_000 })
		terminal.keyCtrlC()
		await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: 15_000 })

		const chatRequest = fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chatRequest).toBeDefined()
	} catch (error) {
		await writeTuiArtifact("interrupt-handling.txt", fullText(terminal))
		throw error
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
})
