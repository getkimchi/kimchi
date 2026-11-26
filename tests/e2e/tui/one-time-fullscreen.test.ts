import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import { createKimchiFixture, createKimchiSessionController, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a regular development TUI automatically switches to fullscreen once", async ({ terminal }) => {
	const fixture = await createKimchiFixture({ responses: [{ stream: ["Use the LRU cache."] }] })
	const session = createKimchiSessionController(terminal, fixture)

	try {
		await session.start()
		terminal.submit("/btw Which cache?")
		await waitForText(
			terminal,
			(text) => text.includes("Side chat · Which cache?") || text.includes("Side chat needs the fullscreen TUI mode"),
			{ full: false },
		)
		expect(viewText(terminal)).toContain("Side chat · Which cache?")
		await waitForText(terminal, "Use the LRU cache.", { full: false })

		const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>
		expect(settings.tuiMode).toBe("fullscreen")
		expect(existsSync(join(fixture.agentDir, "one-time-fullscreen.json"))).toBe(true)

		// Close the side editor before quitting so /quit reaches main rather than
		// being submitted as another side-chat prompt.
		terminal.submit("/close")
		await poll(() => !viewText(terminal).includes("Side chat · Which cache?"), 100, 5_000).then((closed) => {
			expect(closed).toBe(true)
		})
		// The migrated setting is now fullscreen. Simulate the user deliberately
		// choosing regular again before starting the next session.
		settings.tuiMode = "regular"
		writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify(settings))
		await session.restart()
		terminal.submit("/btw Are we regular again?")
		await waitForText(terminal, "Side chat needs the fullscreen TUI mode", { full: false })
		expect(viewText(terminal)).not.toContain("Side chat · Are we regular again?")
	} finally {
		await session.quit()
		await fixture.stop()
	}
})
