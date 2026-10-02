// Plays a completion sound when the agent finishes responding.
//
// Configured via ~/.config/kimchi/harness/settings.json (same mechanism as
// the RTK toggle in bash-collapse.ts):
//
//   { "sound": "off" }                    default — no sound
//   { "sound": "agent-end" }              play whenever the agent finishes
//   { "sound": "agent-end-without-focus" }
//                                         play only when the terminal lost
//                                         focus (or focus is undetectable —
//                                         Terminal.app / tmux — in which
//                                         case we play rather than risk a
//                                         silent miss)
//   { "soundFile": "/path/to/custom.wav" }
//                                         optional audio file; when unset,
//                                         a per-platform default is used
//
// Both settings are re-read on every agent_end, so edits apply live without
// a restart. Playback is best-effort with no new dependencies:
//   - macOS:  `afplay` with /System/Library/Sounds/Glass.aiff by default
//   - Linux:  paplay → aplay → ffplay → mpv → canberra-gtk-play → play, with
//             /usr/share/sounds/freedesktop/stereo/complete.oga by default
//   - Windows: PowerShell `[console]::beep` (not an official platform, but
//             degrades gracefully when running from source)
//   - fallback: terminal bell (\x07) when there's no player or the file is
//             missing

import { type SpawnOptions, spawn } from "node:child_process"
import { existsSync, readFileSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
	disableFocusTracking,
	hasTerminalFocus,
	installFocusTracking,
	isFocusTrackingEnabled,
} from "../terminal-focus.js"

export type SoundMode = "off" | "agent-end" | "agent-end-without-focus"

export interface SoundSettings {
	mode: SoundMode
	file: string | undefined
}

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

const DEFAULT_DARWIN_SOUND = "/System/Library/Sounds/Glass.aiff"
const DEFAULT_LINUX_SOUND = "/usr/share/sounds/freedesktop/stereo/complete.oga"

export function getSoundSettings(settingsPath: string = HARNESS_SETTINGS_PATH): SoundSettings {
	const fallback: SoundSettings = { mode: "off", file: undefined }
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
		if (!parsed || typeof parsed !== "object") return fallback
		const sound = parsed.sound
		const mode: SoundMode =
			sound === "off" || sound === "agent-end" || sound === "agent-end-without-focus" ? sound : "off"
		const file =
			typeof parsed.soundFile === "string" && parsed.soundFile.trim().length > 0 ? parsed.soundFile.trim() : undefined
		return { mode, file }
	} catch {
		// settings.json absent or unreadable — default to no sound.
		return fallback
	}
}

/**
 * Decision matrix for a single agent_end. `trackingEnabled`/`focused` come
 * from terminal-focus; when tracking isn't available we can't distinguish
 * "user is watching" from "user is away", so without-focus mode plays.
 */
export function shouldPlaySound(mode: SoundMode, trackingEnabled: boolean, focused: boolean): boolean {
	if (mode === "off") return false
	if (mode === "agent-end") return true
	return !trackingEnabled || !focused
}

/**
 * The audio file to play: the user's `soundFile` when set, otherwise a
 * platform default (none on platforms without a default).
 */
export function resolveSoundFile(
	customFile: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (customFile && customFile.trim().length > 0) return customFile.trim()
	if (platform === "darwin") return DEFAULT_DARWIN_SOUND
	if (platform === "linux") return DEFAULT_LINUX_SOUND
	return undefined
}

interface Player {
	cmd: string
	buildArgs: (file: string) => string[]
}

// First binary found on PATH wins; a missing binary (spawn ENOENT) advances
// to the next player. A player that exists but can't decode the file exits
// non-zero silently — acceptable for a best-effort notification.
const LINUX_PLAYERS: Player[] = [
	{ cmd: "paplay", buildArgs: (file) => [file] },
	{ cmd: "aplay", buildArgs: (file) => [file] },
	{ cmd: "ffplay", buildArgs: (file) => ["-nodisp", "-autoexit", file] },
	{ cmd: "mpv", buildArgs: (file) => ["--no-video", "--really-quiet", file] },
	{ cmd: "canberra-gtk-play", buildArgs: (file) => ["--file", file] },
	{ cmd: "play", buildArgs: (file) => [file] },
]

function bell(): void {
	process.stdout.write("\x07")
}

type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>

function tryNextPlayer(spawnImpl: SpawnFn, players: Player[], file: string, index: number): void {
	if (index >= players.length) {
		bell()
		return
	}
	const player = players[index]
	const child = spawnImpl(player.cmd, player.buildArgs(file), { stdio: "ignore" })
	child.on("error", () => tryNextPlayer(spawnImpl, players, file, index + 1))
}

/**
 * Play the completion sound, best-effort. Injected defaults keep this
 * testable: `platform`, `spawnImpl`, and `fileExists` can be overridden.
 */
export function playSound(
	file?: string,
	platform: NodeJS.Platform = process.platform,
	spawnImpl: SpawnFn = spawn,
	fileExists: (path: string) => boolean = existsSync,
): void {
	const resolved = resolveSoundFile(file, platform)
	if (resolved && !fileExists(resolved)) {
		bell()
		return
	}
	if (platform === "darwin" && resolved) {
		// stdio: "ignore" so afplay never touches the TUI's streams; spawn
		// errors (missing binary) fall back to the bell.
		spawnImpl("afplay", [resolved], { stdio: "ignore" }).on("error", () => bell())
		return
	}
	if (platform === "linux" && resolved) {
		tryNextPlayer(spawnImpl, LINUX_PLAYERS, resolved, 0)
		return
	}
	if (platform === "win32") {
		spawnImpl("powershell", ["-NoProfile", "-Command", "[console]::beep(880, 200)"], { stdio: "ignore" }).on(
			"error",
			() => bell(),
		)
		return
	}
	bell()
}

export default function doneSoundExtension(pi: ExtensionAPI): void {
	// Arm focus tracking eagerly so a mode flip via settings.json works
	// without restart. No-op when the terminal can't report focus.
	installFocusTracking()

	// Terminals keep reporting focus after we exit; a stray \x1b[I / \x1b[O
	// would otherwise land in the shell as input. Disable on exit — writeSync
	// to fd 1 bypasses TUI buffering and still flushes in exit handlers.
	process.on("exit", () => {
		disableFocusTracking((s) => writeSync(1, s))
	})

	pi.on("agent_end", () => {
		const { mode, file } = getSoundSettings()
		if (shouldPlaySound(mode, isFocusTrackingEnabled(), hasTerminalFocus())) {
			playSound(file)
		}
	})
}
