import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// kimchi force-disables pi's install telemetry (PI_TELEMETRY=0 plus a
// reportInstallTelemetry no-op, see src/pi-telemetry-patch.ts), and the
// pi-coding-agent patch removes the "Install telemetry" toggle from the
// /settings list. The list scrolls (a window of rows with an "(n/total)"
// counter), so absence is only meaningful if every row has been on screen:
// walk the whole list and check each frame.
test("/settings omits the Install telemetry toggle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "settings-panel-omits-install-telemetry",
			responses: [],
		},
		async (_fixture, trace) => {
			trace.step("startup")
			terminal.write("/settings")
			await waitForText(terminal, "/settings", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Auto-compact", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("settings panel open")

			let seen = ""
			let reachedEnd = false
			for (let step = 0; step < 80; step += 1) {
				const frame = viewText(terminal)
				seen += `\n${frame}`
				const counter = frame.match(/\((\d+)\/(\d+)\)/)
				if (counter && counter[1] === counter[2]) {
					reachedEnd = true
					break
				}
				terminal.keyDown()
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
			trace.step("walked the full settings list")

			// The walk covered the whole list, including the rows that used to
			// flank the removed toggle.
			expect(reachedEnd).toBe(true)
			expect(seen).toContain("Quiet startup")
			expect(seen).toContain("Default project trust")
			expect(seen).not.toContain("Install telemetry")
		},
	)
})
