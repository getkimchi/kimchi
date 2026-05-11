/**
 * Cross-platform clipboard image reading.
 *
 * This is a local re-implementation of upstream pi-coding-agent's clipboard
 * reading logic, avoiding the deep import that causes bun build failures.
 *
 * The upstream `@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js`
 * uses a deep import path not in the package's exports map, which bun cannot
 * resolve during `bun build --compile`. This module re-implements the needed
 * functionality using the harness's native clipboard addon loader.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getNativeClipboard } from "./clipboard-native-harness.js"

export type ClipboardImage = {
	bytes: Uint8Array
	mimeType: string
}

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

const DEFAULT_LIST_TIMEOUT_MS = 1000
const DEFAULT_READ_TIMEOUT_MS = 3000
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024

/**
 * Check if we're running in a Wayland session.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland"
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase()
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png"
		case "image/jpeg":
			return "jpg"
		case "image/webp":
			return "webp"
		case "image/gif":
			return "gif"
		default:
			return null
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }))

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred)
		if (match) {
			return match.raw
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"))
	return anyImage?.raw ?? null
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType)
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base)
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: options?.env,
	})

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) }
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) }
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined)

	return { ok: true, stdout }
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS })
	if (!list.ok) {
		return null
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean)

	const selectedType = selectPreferredImageMimeType(types)
	if (!selectedType) {
		return null
	}

	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"])
	if (!data.ok || data.stdout.length === 0) {
		return null
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) }
}

function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true
	}

	try {
		const release = readFileSync("/proc/version", "utf-8")
		return /microsoft|wsl/i.test(release)
	} catch {
		return false
	}
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`)

	try {
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS })
		if (!winPathResult.ok) {
			return null
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim()
		if (!winPath) {
			return null
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''")
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ")

		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		})
		if (!result.ok) {
			return null
		}

		const output = result.stdout.toString("utf-8").trim()
		if (output !== "ok") {
			return null
		}

		const bytes = readFileSync(tmpFile)
		if (bytes.length === 0) {
			return null
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" }
	} catch {
		return null
	} finally {
		try {
			unlinkSync(tmpFile)
		} catch {
			// Ignore cleanup errors.
		}
	}
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	})

	let candidateTypes: string[] = []
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean)
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES]

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"])
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) }
		}
	}

	return null
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	let nativeClipboard: unknown

	try {
		nativeClipboard = getNativeClipboard()?.clipboard
	} catch {
		return null
	}

	if (!nativeClipboard || typeof nativeClipboard !== "object") {
		return null
	}

	const hasImage = (nativeClipboard as { hasImage?: () => boolean }).hasImage
	const getImageBinary = (nativeClipboard as { getImageBinary?: () => Promise<Uint8Array> }).getImageBinary
	const availableFormats = (nativeClipboard as { availableFormats?: () => string[] }).availableFormats

	if (!hasImage?.() || !getImageBinary) {
		return null
	}

	// When a file is copied in Finder (Cmd+C), macOS puts a
	// "public.file-url" + a thumbnail on the pasteboard.
	// getImageBinary() returns the thumbnail/icon in this case.
	// Detect this and return null so clipboard-read.ts uses AppleScript
	// to read the actual file from disk.
	if (availableFormats) {
		const formats = availableFormats()
		if (formats.includes("public.file-url")) {
			return null
		}
	}

	const imageData = await getImageBinary()
	if (!imageData || imageData.length === 0) {
		return null
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData)
	return { bytes, mimeType: "image/png" }
}

/**
 * Read the most-recent image from the system clipboard.
 *
 * Handles:
 * - Linux: Wayland (wl-paste), X11 (xclip), WSL (PowerShell), native NAPI
 * - macOS: native NAPI
 * - Windows: native NAPI
 *
 * Returns `null` if no image is on the clipboard or it cannot be read.
 */
export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv
	platform?: NodeJS.Platform
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env
	const platform = options?.platform ?? process.platform

	if (env.TERMUX_VERSION) {
		return null
	}

	let image: ClipboardImage | null = null

	if (platform === "linux") {
		const wsl = isWSL(env)
		const wayland = isWaylandSession(env)

		if (wayland || wsl) {
			image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip()
		}

		if (!image && wsl) {
			image = readClipboardImageViaPowerShell()
		}

		if (!image && !wayland) {
			image = await readClipboardImageViaNativeClipboard()
		}
	} else {
		image = await readClipboardImageViaNativeClipboard()
	}

	if (!image) {
		return null
	}

	// Note: Photon-based format conversion (e.g., BMP→PNG) is omitted for
	// simplicity. The main use case (screenshots) already returns PNG/JPEG.

	if (!isSupportedImageMimeType(image.mimeType)) {
		return null
	}

	return image
}
