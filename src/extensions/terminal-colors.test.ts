import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

	it("reads oscFg/oscBg from theme vars and emits OSC 10/11 on theme change", async () => {
		const restoreStdinTTY = setIsTTY(process.stdin, true)
		const restoreStdoutTTY = setIsTTY(process.stdout, true)
		const originalExitListeners = new Set(process.listeners("exit"))
		const originalSignalListeners = new Map(
			PROCESS_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]),
		)
		const originalAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		const originalTermProgram = process.env.TERM_PROGRAM
		delete process.env.TERM_PROGRAM // force the standard OSC 10/11 path (not iTerm2's 1337)
		const agentDir = mkdtempSync(join(tmpdir(), "kimchi-osc-test-"))
		mkdirSync(join(agentDir, "themes"), { recursive: true })
		// upstream pi's theme schema forbids non-THEME_TOKENS keys under `colors`;
		// kimchi's terminal fg/bg overrides live in `vars`.
		writeFileSync(
			join(agentDir, "themes", "osc-theme.json"),
			JSON.stringify({ name: "osc-theme", vars: { oscFg: "#A1A1A1", oscBg: "#1A1818" }, colors: {} }),
		)
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

		try {
			const pi = createExtensionApi()
			terminalColorsExtension(pi.api)
			let widgetFactory: (() => { invalidate(): void; render(): string[] }) | undefined
			const ctx = createContext({
				ui: {
					setWidget: vi.fn((_key: string, content: unknown) => {
						if (typeof content === "function") widgetFactory = content as unknown as typeof widgetFactory
					}) as unknown as ExtensionUIContext["setWidget"],
					theme: { name: "kimchi-minimal" } as ExtensionUIContext["theme"],
				},
			})

			await pi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
			expect(stdoutWrite).not.toHaveBeenCalled()

			// Sensor widget fires on TUI.invalidate() after setTheme(); simulate the
			// user switching to a theme whose vars declare oscFg/oscBg.
			// ExtensionUIContext.theme is read-only to extensions; the test simulates the swap.
			;(ctx.ui as { theme: ExtensionUIContext["theme"] }).theme = { name: "osc-theme" } as ExtensionUIContext["theme"]
			widgetFactory?.().invalidate()

			const written = stdoutWrite.mock.calls.map((call) => String(call[0]))
			expect(written).toContain("\x1b]10;rgb:A1/A1/A1\x07")
			expect(written).toContain("\x1b]11;rgb:1A/18/18\x07")

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
			rmSync(agentDir, { recursive: true, force: true })
			if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM
			else process.env.TERM_PROGRAM = originalTermProgram
			restoreStdinTTY()
			restoreStdoutTTY()
		}
	})
})
