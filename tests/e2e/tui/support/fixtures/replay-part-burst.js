import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export default function (pi) {
	pi.registerCommand("replay-part-burst", {
		description: "Fill a recording part without changing the terminal screen",
		handler: async (_args, ctx) => {
			const root = join(homedir(), ".config/kimchi/harness/terminal-recordings")
			const current = async () => {
				const entries = await Promise.all(
					(await readdir(root))
						.filter((name) => name.startsWith("slot-"))
						.map(async (name) => {
							try {
								return JSON.parse(await readFile(join(root, name, "metadata.json"), "utf8"))
							} catch {
								// A newly reserved slot may not have published its complete metadata yet.
								return undefined
							}
						}),
				)
				return entries.find((entry) => entry?.pid === process.pid && entry.status === "recording")
			}
			const deadline = Date.now() + 30000
			while (Date.now() < deadline) {
				const before = await current()
				if (before?.part > 1) {
					ctx.ui.notify("REPLAY_PART_TWO_READY", "info")
					return
				}
				if (!before) {
					// Rotation completes the old slot before publishing the next recording slot.
					await delay(5)
					continue
				}
				process.stdout.write("\x1b[0m".repeat(32000))
				// Pace the synthetic producer to committed chunks rather than overflowing the queue.
				while (Date.now() < deadline) {
					await delay(5)
					const after = await current()
					if (!after || after.id !== before.id || after.chunks > before.chunks) break
				}
			}
			throw new Error("Recording did not rotate within 30 seconds")
		},
	})
}
