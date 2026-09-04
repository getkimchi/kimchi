import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCommandHook } from "./adapter.js"

// This suite uses the REAL child_process.spawn (no vi.mock), because the
// behaviour under test only appears with a real child process and a real pipe.
//
// The hook runner writes the event payload to the child's stdin with
// child.stdin.end(input). If the hook command ignores its stdin and exits
// immediately while a large payload is still being flushed, the OS tears down
// the read end of the pipe and the write fails with EPIPE ("broken pipe").
// That error arrives asynchronously on the stdin stream. The runner attaches
// an error handler to the ChildProcess (child.on("error")) but not to the
// stdin stream, so the stream error has no handler and surfaces as a
// process-level unhandled error, which can take down the process.
//
// Payload size matters: the write only backs up once it exceeds the OS pipe
// buffer (about 64 KB on macOS), so a small payload never exposes the bug. We
// use ~1 MB to make the broken-pipe write reliable.
const LARGE_PAYLOAD_BYTES = 1_000_000

let dir: string

describe("hook adapter stdin write reliability", () => {
	beforeEach(() => {
		dir = join(tmpdir(), `kimchi-hook-epipe-${process.pid}-${Math.random().toString(16).slice(2)}`)
		mkdirSync(dir, { recursive: true })
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("does not raise an unhandled stream error when a hook ignores a large stdin payload", async () => {
		// A hook command that never reads stdin and exits immediately with success.
		const hook = { command: "true", async: false, timeoutMs: 5000 }
		const payload = {
			hook_event_name: "PostToolUse",
			// A big tool result is a realistic way for a hook event to carry a
			// payload larger than the OS pipe buffer.
			tool_output: "x".repeat(LARGE_PAYLOAD_BYTES),
		}

		// Capture any process-level unhandled error that the stdin write triggers.
		// We temporarily take over the process handlers so a captured EPIPE does
		// not crash the test worker, then restore the originals afterwards.
		const captured: string[] = []
		const onUncaught = (err: NodeJS.ErrnoException) => {
			captured.push(`uncaughtException:${err?.code ?? err?.message ?? err}`)
		}
		const onRejection = (reason: unknown) => {
			const err = reason as NodeJS.ErrnoException
			captured.push(`unhandledRejection:${err?.code ?? err?.message ?? String(reason)}`)
		}
		const prevUncaught = process.listeners("uncaughtException")
		const prevRejection = process.listeners("unhandledRejection")
		process.removeAllListeners("uncaughtException")
		process.removeAllListeners("unhandledRejection")
		process.on("uncaughtException", onUncaught)
		process.on("unhandledRejection", onRejection)

		try {
			const result = await runCommandHook(hook, payload, dir)
			// The broken-pipe error arrives after the child closes, so give the
			// event loop time to deliver it before asserting.
			await new Promise((resolve) => setTimeout(resolve, 250))

			expect(captured, `unhandled stream error(s): ${captured.join(", ")}`).toEqual([])
			// A hook that exits 0 with no output yields an empty result.
			expect(result).toEqual({})
		} finally {
			process.removeListener("uncaughtException", onUncaught)
			process.removeListener("unhandledRejection", onRejection)
			for (const listener of prevUncaught) process.on("uncaughtException", listener as never)
			for (const listener of prevRejection) process.on("unhandledRejection", listener as never)
		}
	})
})
