import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SoundSettings } from "./done-sound.js"
import { getSoundSettings, playSound, resolveSoundFile, shouldPlaySound } from "./done-sound.js"

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: vi.fn() })),
}))

const GLASS = "/System/Library/Sounds/Glass.aiff"
const FREEDESKTOP = "/usr/share/sounds/freedesktop/stereo/complete.oga"

describe("shouldPlaySound", () => {
	it("never plays in off mode", () => {
		for (const tracking of [true, false]) {
			for (const focused of [true, false]) {
				expect(shouldPlaySound("off", tracking, focused)).toBe(false)
			}
		}
	})

	it("always plays in agent-end mode", () => {
		for (const tracking of [true, false]) {
			for (const focused of [true, false]) {
				expect(shouldPlaySound("agent-end", tracking, focused)).toBe(true)
			}
		}
	})

	it("without-focus plays only when focus is lost", () => {
		expect(shouldPlaySound("agent-end-without-focus", true, true)).toBe(false)
		expect(shouldPlaySound("agent-end-without-focus", true, false)).toBe(true)
	})

	it("without-focus plays when focus is undetectable (can't risk a silent miss)", () => {
		expect(shouldPlaySound("agent-end-without-focus", false, true)).toBe(true)
		expect(shouldPlaySound("agent-end-without-focus", false, false)).toBe(true)
	})
})

describe("getSoundSettings", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-sound-test-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function writeSettings(contents: string): string {
		const path = join(dir, "settings.json")
		writeFileSync(path, contents, "utf-8")
		return path
	}

	it("defaults to off with no file when settings.json is missing or unreadable", () => {
		expect(getSoundSettings(join(dir, "does-not-exist.json"))).toEqual({ mode: "off", file: undefined })
	})

	it("defaults to off when the file has invalid JSON", () => {
		expect(getSoundSettings(writeSettings("{ not json"))).toEqual({ mode: "off", file: undefined })
	})

	it("defaults to off when the sound key is absent or unknown", () => {
		expect(getSoundSettings(writeSettings('{ "rtk": false }'))).toEqual({ mode: "off", file: undefined })
		expect(getSoundSettings(writeSettings('{ "sound": "sometimes" }'))).toEqual({ mode: "off", file: undefined })
	})

	it("parses sound and soundFile independently", () => {
		const settings: SoundSettings = getSoundSettings(
			writeSettings(JSON.stringify({ sound: "agent-end-without-focus", soundFile: "~/work/ding.wav" })),
		)
		expect(settings).toEqual({ mode: "agent-end-without-focus", file: "~/work/ding.wav" })
	})

	it("ignores a non-string or blank soundFile", () => {
		expect(getSoundSettings(writeSettings('{ "sound": "agent-end", "soundFile": 42 }')).file).toBeUndefined()
		expect(getSoundSettings(writeSettings('{ "sound": "agent-end", "soundFile": "   " }')).file).toBeUndefined()
	})
})

describe("resolveSoundFile", () => {
	it("uses the custom file when set (trimmed)", () => {
		expect(resolveSoundFile("  /a/b.wav  ")).toBe("/a/b.wav")
	})

	it("falls back to the macOS default on darwin", () => {
		expect(resolveSoundFile(undefined, "darwin")).toBe(GLASS)
	})

	it("falls back to the freedesktop default on linux", () => {
		expect(resolveSoundFile(undefined, "linux")).toBe(FREEDESKTOP)
	})

	it("has no default on unsupported platforms", () => {
		expect(resolveSoundFile(undefined, "win32")).toBeUndefined()
	})
})

describe("playSound", () => {
	it("uses afplay with the resolved default on macOS", async () => {
		const { spawn } = await import("node:child_process")
		const spawnMock = vi.mocked(spawn)
		spawnMock.mockClear()
		const spawnImpl = vi.fn(() => ({ on: vi.fn() }))
		playSound(undefined, "darwin", spawnImpl as never)
		expect(spawnImpl).toHaveBeenCalledWith("afplay", [GLASS], { stdio: "ignore" })
	})

	it("uses the custom file when provided", () => {
		const spawnImpl = vi.fn(() => ({ on: vi.fn() }))
		playSound("/custom/ding.wav", "darwin", spawnImpl as never, () => true)
		expect(spawnImpl).toHaveBeenCalledWith("afplay", ["/custom/ding.wav"], { stdio: "ignore" })
	})

	it("tries paplay first on linux, advancing to the next player on ENOENT", () => {
		const players: Array<{ cmd: string; args: string[] }> = []
		const spawnImpl = vi.fn((cmd: string, args: string[]) => {
			players.push({ cmd, args })
			const child = { on: vi.fn((event: string, cb: () => void) => (event === "error" ? cb() : child)) }
			return child
		})
		playSound(undefined, "linux", spawnImpl as never, () => true)
		expect(players.map((p) => p.cmd)).toEqual(["paplay", "aplay", "ffplay", "mpv", "canberra-gtk-play", "play"])
		expect(players[0].args).toEqual([FREEDESKTOP])
	})

	it("plays via PowerShell beep on win32", () => {
		const spawnImpl = vi.fn(() => ({ on: vi.fn() }))
		playSound(undefined, "win32", spawnImpl as never)
		expect(spawnImpl).toHaveBeenCalledWith("powershell", ["-NoProfile", "-Command", "[console]::beep(880, 200)"], {
			stdio: "ignore",
		})
	})

	it("falls back to the terminal bell when the file is missing", () => {
		const spawnImpl = vi.fn(() => ({ on: vi.fn() }))
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		try {
			playSound(undefined, "darwin", spawnImpl as never, () => false)
			expect(spawnImpl).not.toHaveBeenCalled()
			expect(writeSpy).toHaveBeenCalledWith("\x07")
		} finally {
			writeSpy.mockRestore()
		}
	})

	it("falls back to the terminal bell on unsupported platforms", () => {
		const spawnImpl = vi.fn(() => ({ on: vi.fn() }))
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		try {
			playSound(undefined, "aix", spawnImpl as never, () => true)
			expect(spawnImpl).not.toHaveBeenCalled()
			expect(writeSpy).toHaveBeenCalledWith("\x07")
		} finally {
			writeSpy.mockRestore()
		}
	})
})
