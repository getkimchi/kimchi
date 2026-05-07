import type { ExtensionAPI, TurnEndEvent } from "@mariozechner/pi-coding-agent"
import type { ResultManifest } from "../../autonomous/result.js"
import { writeResult } from "../../autonomous/result.js"

export interface ResultWriterControl {
	markTimeout(): void
	markError(error: { message: string; stack?: string }): void
	flush(): void
	flushIfUnflushed(reason: ResultManifest["exit_reason"]): void
}

export interface ResultWriterHandle {
	extension: (pi: ExtensionAPI) => void
	control: ResultWriterControl
}

export function createResultWriter(options: { resultDir: string; logPath?: string }): ResultWriterHandle {
	const { resultDir, logPath } = options

	let startedAt: string | undefined
	let exitReason: "done" | "timeout" | "error" = "error"
	let lastMessage: string | undefined
	let errorDetail: { message: string; stack?: string } | undefined
	let flushed = false

	const control: ResultWriterControl = {
		markTimeout() {
			exitReason = "timeout"
			errorDetail = undefined
			if (!flushed) {
				control.flush()
			}
		},

		markError(error: { message: string; stack?: string }) {
			exitReason = "error"
			errorDetail = error
			if (!flushed) {
				control.flush()
			}
		},

		flush() {
			if (flushed) return
			flushed = true

			writeResult(resultDir, {
				exit_reason: exitReason,
				started_at: startedAt ?? new Date().toISOString(),
				ended_at: new Date().toISOString(),
				...(lastMessage !== undefined ? { last_message: lastMessage } : {}),
				...(logPath !== undefined ? { log_path: logPath } : {}),
				...(errorDetail !== undefined ? { error: errorDetail } : {}),
			})
		},

		flushIfUnflushed(reason: ResultManifest["exit_reason"]) {
			if (flushed) return
			exitReason = reason
			control.flush()
		},
	}

	function extension(pi: ExtensionAPI): void {
		pi.on("session_start", () => {
			startedAt = new Date().toISOString()
			exitReason = "done"
			lastMessage = undefined
			errorDetail = undefined
			flushed = false
		})

		pi.on("turn_end", (event: TurnEndEvent) => {
			const { message } = event
			if (message.role !== "assistant") return
			const textItems = message.content.filter((c) => c.type === "text")
			const combined = textItems.map((c) => (c.type === "text" ? c.text : "")).join("\n")

			if (combined.length > 0) {
				lastMessage = combined
			}
		})

		pi.on("session_shutdown", () => {
			control.flush()
		})
	}

	return { extension, control }
}
