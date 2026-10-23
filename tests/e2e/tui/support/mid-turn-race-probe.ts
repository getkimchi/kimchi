// Regression probe for the mid-turn submit race (getkimchi/kimchi#1446).
//
// Reproduces the issue's monitor pattern: an extension-triggered turn
// (sendMessage + triggerTurn) fires while the user's own submit is still
// parked inside prompt()'s input-handler window. Without the interactive
// submit's streamingBehavior default, the runtime throws behaviorless
// ("Specify streamingBehavior") and the main loop's catch discards the text.
//
// Detection is timing-based and self-contained: the interactive input handler
// parks the submit for INPUT_DELAY_MS while the delivery fires at
// DELIVERY_DELAY_MS, so the run-active flag flips before the submit's own
// re-check — the exact interleaving that lost the message.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** How long the interactive submit stays parked inside its input handler. */
const INPUT_DELAY_MS = 800
/** When the monitor delivery fires, relative to the same input event. */
const DELIVERY_DELAY_MS = 300

export default function midTurnRaceProbe(pi: ExtensionAPI): void {
	let armed = false
	pi.on("input", async (event) => {
		if (event.source !== "interactive" || armed) return
		armed = true
		setTimeout(() => {
			void pi.sendMessage(
				{
					customType: "monitor_race",
					content: [{ type: "text", text: "monitor race ping: reply with the single word pong." }],
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			)
		}, DELIVERY_DELAY_MS)
		await new Promise((resolve) => setTimeout(resolve, INPUT_DELAY_MS))
	})
}
