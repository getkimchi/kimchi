// Review JSON must share the print host's raw-stdout queue. A separate writer
// can reorder or truncate JSON lines when the host already has writes queued.
import * as guard from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js"

if (typeof guard.writeRawStdout !== "function" || typeof guard.flushRawStdout !== "function") {
	throw new Error("The print host output guard is missing writeRawStdout or flushRawStdout.")
}

export const writeRawStdout = guard.writeRawStdout
export const flushRawStdout = guard.flushRawStdout
