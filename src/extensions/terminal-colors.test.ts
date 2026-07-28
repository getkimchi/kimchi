import type { ExtensionUIContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetSettingsWatcherForTest } from "../settings-watcher.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import terminalColorsExtension from "./terminal-colors.js"

const PROCESS_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly NodeJS.Signals[]

function setIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, isTTY: boolean): () => void {
	const original = Object.getOwnPropertyDescriptor(stream, "isTTY")
	Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY })
	return () => {
		if (original) Object.defineProperty(stream, "isTTY", original)
		else Reflect.deleteProperty(stream, "isTTY")
	}
}

afterEach(() => {
	vi.restoreAllMocks()
	__resetSettingsWatcherForTest()
})

describe("terminalColorsExtension", () => {
	it("does not query terminal colors after the interactive session has started", async () => {
		const restoreStdinTTY = setIsTTY(process.stdin, true)
		const restoreStdoutTTY = setIsTTY(process.stdout, true)
		const originalExitListeners = new Set(process.listeners("exit"))
		const originalSignalListeners = new Map(
			PROCESS_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]),
		)
		const originalAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		delete process.env.KIMCHI_CODING_AGENT_DIR
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

		try {
			const pi = createExtensionApi()
			terminalColorsExtension(pi.api)
			const ctx = createContext({
				ui: {
					setWidget: vi.fn(),
					theme: { name: "kimchi-minimal" } as ExtensionUIContext["theme"],
				},
			})

			await pi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

			expect(stdoutWrite).not.toHaveBeenCalled()

			await pi.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		} finally {
			for (const listener of process.listeners("exit")) {
				if (!originalExitListeners.has(listener)) process.removeListener("exit", listener)
			}
			for (const signal of PROCESS_SIGNALS) {
				const original = originalSignalListeners.get(signal)
				for (const listener of process.listeners(signal)) {
					if (!original?.has(listener)) process.removeListener(signal, listener)
				}
			}
			if (originalAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
			else process.env.KIMCHI_CODING_AGENT_DIR = originalAgentDir
			restoreStdinTTY()
			restoreStdoutTTY()
		}
	})
})
