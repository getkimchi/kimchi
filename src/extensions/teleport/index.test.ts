import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import teleportExtension from "./index.js"

const { isInSandboxClusterMock, osTypeMock } = vi.hoisted(() => ({
	isInSandboxClusterMock: vi.fn(),
	osTypeMock: vi.fn(),
}))

vi.mock("node:os", () => ({
	default: { type: osTypeMock },
}))

vi.mock("../../utils/sandbox.js", () => ({
	isInSandboxCluster: isInSandboxClusterMock,
}))

vi.mock("../../config.js", () => ({
	loadConfig: vi.fn(() => ({ apiKey: "" })),
}))

vi.mock("./commands/teleport.js", () => ({ runTeleport: vi.fn() }))
vi.mock("./commands/terminal.js", () => ({ runTerminal: vi.fn() }))
vi.mock("./commands/sync.js", () => ({ runSync: vi.fn() }))
vi.mock("./commands/remote-sessions.js", () => ({ runRemoteSessions: vi.fn() }))
vi.mock("./commands/ssh-config.js", () => ({ runSshConfig: vi.fn() }))

function makePi() {
	return { registerCommand: vi.fn() } as unknown as ExtensionAPI
}

describe("teleportExtension", () => {
	beforeEach(() => {
		isInSandboxClusterMock.mockReturnValue(false)
		osTypeMock.mockReturnValue("Linux")
	})

	it("registers commands on Linux", () => {
		const pi = makePi()
		teleportExtension(pi)
		expect(pi.registerCommand).toHaveBeenCalledTimes(5)
	})

	it("registers commands on macOS", () => {
		osTypeMock.mockReturnValue("Darwin")
		const pi = makePi()
		teleportExtension(pi)
		expect(pi.registerCommand).toHaveBeenCalledTimes(5)
	})

	it("registers commands on WSL because WSL reports Linux", () => {
		// WSL returns "Linux" from os.type(), so it is treated as a Linux environment.
		osTypeMock.mockReturnValue("Linux")
		const pi = makePi()
		teleportExtension(pi)
		expect(pi.registerCommand).toHaveBeenCalledTimes(5)
	})

	it("does not register commands on Windows", () => {
		osTypeMock.mockReturnValue("Windows_NT")
		const pi = makePi()
		teleportExtension(pi)
		expect(pi.registerCommand).not.toHaveBeenCalled()
	})

	it("does not register commands inside a sandbox cluster", () => {
		isInSandboxClusterMock.mockReturnValue(true)
		const pi = makePi()
		teleportExtension(pi)
		expect(pi.registerCommand).not.toHaveBeenCalled()
	})
})
