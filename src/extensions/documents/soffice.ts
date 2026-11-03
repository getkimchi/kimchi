/**
 * LibreOffice (`soffice`) discovery and install hint, shared by every
 * optional LibreOffice feature (pptx `render`, pdf `dump-shapes`/`edit-draw`).
 *
 * Order: `KIMCHI_SOFFICE`, then PATH, then the per-OS install locations —
 * on macOS the app bundle is usually installed without `soffice` on PATH.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, win32 } from "node:path"
import { DocumentError, type DocumentFormat } from "./model.js"

export interface SofficeDeps {
	which: (cmd: string) => string | undefined
	fileExists: (path: string) => boolean
	env?: Record<string, string | undefined>
	platform?: NodeJS.Platform
	home?: string
	listdir?: (dir: string) => string[]
}

/** The calling feature, for the tool-missing message. */
export interface SofficeFeature {
	format: DocumentFormat
	/** e.g. "render" or "edit-draw/dump-shapes". */
	commands: string
	/** Commands that work without LibreOffice, e.g. "read/create/edit/check". */
	core: string
}

export function defaultWhich(cmd: string): string | undefined {
	const finder = process.platform === "win32" ? "where" : "which"
	const result = spawnSync(finder, [cmd], { encoding: "utf8" })
	// `where` can list several matches; the first one is what the shell would run.
	const path = result.status === 0 ? ((result.stdout ?? "").split(/\r?\n/)[0] ?? "").trim() : ""
	return path !== "" && existsSync(path) ? path : undefined
}

function safeListdir(listdir: (dir: string) => string[], dir: string): string[] {
	try {
		return listdir(dir)
	} catch {
		return []
	}
}

export function sofficeCandidates(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
	home: string,
	listdir: (dir: string) => string[],
): string[] {
	if (platform === "darwin") {
		return [
			"/Applications/LibreOffice.app/Contents/MacOS/soffice",
			join(home, "Applications/LibreOffice.app/Contents/MacOS/soffice"),
		]
	}
	if (platform === "win32") {
		const roots = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]
		// soffice.com is the console launcher: it waits for headless jobs and keeps stdio.
		return roots.flatMap((root) => [
			win32.join(root, "LibreOffice", "program", "soffice.com"),
			win32.join(root, "LibreOffice", "program", "soffice.exe"),
		])
	}
	const opt = safeListdir(listdir, "/opt")
		.filter((name) => name.startsWith("libreoffice"))
		.sort()
		.reverse()
		.map((name) => `/opt/${name}/program/soffice`)
	return [
		"/usr/lib/libreoffice/program/soffice",
		"/usr/bin/soffice",
		"/usr/local/bin/soffice",
		...opt,
		"/snap/bin/libreoffice",
		"/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",
		join(home, ".local/share/flatpak/exports/bin/org.libreoffice.LibreOffice"),
	]
}

export function libreOfficeInstallHint(platform: NodeJS.Platform): string {
	const install =
		platform === "darwin"
			? "`brew install --cask libreoffice`"
			: platform === "win32"
				? "`winget install TheDocumentFoundation.LibreOffice`"
				: "your distro's `libreoffice` package (e.g. `apt install libreoffice`)"
	return `Install it with ${install}, or set KIMCHI_SOFFICE to the soffice binary.`
}

export function findSoffice(deps: SofficeDeps, feature: SofficeFeature): string {
	const env = deps.env ?? process.env
	const platform = deps.platform ?? process.platform
	const override = env.KIMCHI_SOFFICE
	if (override) {
		if (deps.fileExists(override)) return override
		throw new DocumentError(
			"tool-missing",
			`KIMCHI_SOFFICE points at ${override}, which does not exist. Fix or unset it.`,
			feature.format,
		)
	}
	const onPath = deps.which("soffice")
	if (onPath) return onPath
	const candidates = sofficeCandidates(platform, env, deps.home ?? homedir(), deps.listdir ?? readdirSync)
	for (const candidate of candidates) {
		if (deps.fileExists(candidate)) return candidate
	}
	throw new DocumentError(
		"tool-missing",
		`${feature.commands} need${feature.commands.includes("/") ? "" : "s"} LibreOffice (soffice). ${libreOfficeInstallHint(platform)} ${feature.core} never need it.`,
		feature.format,
	)
}
