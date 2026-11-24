import { submitFinding, submitReply, submitSummary } from "./store.js"

const [tool, homeDir, serializedInput, crash] = process.argv.slice(2)
if (!tool || !homeDir || !serializedInput) throw new Error("submit-process requires tool, HOME, and input JSON")

const input = JSON.parse(serializedInput) as never
function notifyBeforeRename(): void {
	process.send?.({ type: "before_rename" })
}

async function interruptBeforeRename(): Promise<void> {
	if (crash === "kill-before-rename") {
		process.kill(process.pid, "SIGKILL")
		return
	}
	if (crash === "hold-before-rename") {
		notifyBeforeRename()
		await new Promise<void>((resolve) => process.once("message", resolve))
		return
	}
	if (crash === "stall-before-rename") {
		notifyBeforeRename()
		// Deliberately block this event loop past the retired two-second lease.
		// No liveness check may depend on a refresh timer surviving this stall.
		const resumeAt = Date.now() + 2_500
		while (Date.now() < resumeAt) {
			// Intentional synchronous test stall.
		}
	}
}

async function waitAtCheckpoint(type: string): Promise<void> {
	process.send?.({ type })
	await new Promise<void>((resolve) => process.once("message", resolve))
}

const context = {
	homeDir,
	writer: "final",
	now: () => new Date("2026-11-17T12:00:00Z"),
	beforeAcquire: crash === "hold-before-acquire" ? async () => waitAtCheckpoint("before_acquire") : undefined,
	beforeRename: crash === undefined || crash === "hold-before-acquire" ? undefined : interruptBeforeRename,
	beforeRelease: crash === "hold-before-release" ? async () => waitAtCheckpoint("before_release") : undefined,
}
const submit = tool === "submit_finding" ? submitFinding : tool === "submit_summary" ? submitSummary : submitReply
const result = await submit(input, context)
process.stdout.write(JSON.stringify(result))
