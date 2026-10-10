import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("native notifications can be enabled and disabled from the terminal", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "native-notifications-toggle", responses: [{ stream: ["Notifications stayed off."] }] },
		async (fixture, trace) => {
			terminal.submit("/notifications")
			await waitForText(terminal, "Native notifications off. Usage:")
			terminal.submit("/notifications on")
			await waitForText(terminal, "Native notifications on.")
			const settingsPath = join(fixture.agentDir, "settings.json")
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).nativeNotifications).toBe(true)
			trace.step("notifications enabled and saved")

			terminal.submit("/notifications off")
			await waitForText(terminal, /Native notifications off\.\s*$/m)
			expect(JSON.parse(readFileSync(settingsPath, "utf8")).nativeNotifications).toBe(false)
			terminal.submit("Return the requested status.")
			await waitForText(terminal, "Notifications stayed off.")
			trace.step("notifications disabled and the conversation still works")
		},
	)
})
