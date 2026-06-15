import { Shell, expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { createKimchiFixture, launchKimchi, stopKimchi, writeTuiArtifact } from "./support/kimchi-fixture.js"

test.use({
	shell: Shell.Bash,
	rows: 40,
	columns: 120,
})

test("basic session lifecycle", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
	})

	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: 10_000 })

		terminal.submit("Say hello")

		await expect(terminal.getByText("Hello from fake Kimchi.", { full: true })).toBeVisible()
		expect(fixture.fake.requests.some((request) => request.url.startsWith("/openai/v1/chat/completions"))).toBe(true)
	} catch (error) {
		await writeTuiArtifact("basic-session-lifecycle.txt", fullText(terminal))
		throw error
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
})
