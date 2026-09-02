import { spawnSync } from "node:child_process"
import type { NativeClipboard } from "./clipboard-native-harness.js"

function isWayland(): boolean {
	return Boolean(process.env.WAYLAND_DISPLAY)
}

function runAvailableFormats(): string[] {
	try {
		const result = isWayland()
			? spawnSync("wl-paste", ["--list-types"], { encoding: "utf8", timeout: 2000 })
			: spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
					encoding: "utf8",
					timeout: 2000,
				})
		if (result.status !== 0 || !result.stdout) return []
		return result.stdout
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && s !== "TARGETS")
	} catch {
		return []
	}
}

export function createLinuxClipboard(): NativeClipboard {
	return {
		availableFormats(): string[] {
			return runAvailableFormats()
		},

		hasImage(): boolean {
			return runAvailableFormats().some((f) => /^image\//i.test(f))
		},

		async getImageBinary(): Promise<number[]> {
			const formats = runAvailableFormats()
			const imageType = formats.find((f) => /^image\/(png|jpeg|jpg|gif|webp|bmp)/i.test(f)) ?? "image/png"
			try {
				const result = isWayland()
					? spawnSync("wl-paste", ["--type", imageType], {
							timeout: 5000,
							encoding: "buffer",
							maxBuffer: 50 * 1024 * 1024,
						})
					: spawnSync("xclip", ["-selection", "clipboard", "-t", imageType, "-o"], {
							timeout: 5000,
							encoding: "buffer",
							maxBuffer: 50 * 1024 * 1024,
						})
				if (result.status !== 0 || !result.stdout) return []
				return Array.from(result.stdout)
			} catch {
				return []
			}
		},
	}
}
