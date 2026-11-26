import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { acquireReviewOperation } from "./active-runs.js"
import { currentReviewOwnerIdentity } from "./owner-identity.js"

const [root, id, mode] = process.argv.slice(2)
if (!root || !id) throw new Error("active-runs-process requires root and session id")
const lockPath = join(root, "active-review.json")
const ctx = {
	cwd: root,
	hasUI: false,
	sessionManager: { getSessionId: () => `process-${id}` },
} as unknown as ExtensionCommandContext

function notify(message: Record<string, unknown>): void {
	process.send?.({ ...message, id })
}

try {
	const operation = await acquireReviewOperation(
		ctx,
		join(root, id),
		{ runDir: join(root, "runs", id), lockPath },
		currentReviewOwnerIdentity,
		undefined,
		{
			afterGuardedRead:
				mode === "stall"
					? async () => {
							notify({ type: "before_stale_rename" })
							await new Promise<void>((resolve) => process.once("message", resolve))
						}
					: undefined,
		},
	)
	const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }
	notify({ type: "acquired", token: lock.token })
	await new Promise<void>((resolve) => process.once("message", resolve))
	await operation.finish()
	notify({ type: "finished" })
} catch (error) {
	notify({
		type: "error",
		code: (error as { code?: string }).code ?? "unknown_error",
		message: error instanceof Error ? error.message : String(error),
	})
}
process.disconnect()
