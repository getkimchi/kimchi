/**
 * In-place PDF text editing via LibreOffice Draw (the only engine that can
 * edit positioned text runs; pdf-lib cannot modify content streams). The
 * actual editing runs as a Python macro *inside* soffice — LibreOffice's
 * bundled interpreter is killed standalone (macOS code signing) — using a
 * throwaway profile so the user's real one is never touched.
 *
 * Proven pitfalls encoded here (each cost a debugging round):
 * - loading a PDF without FilterName="draw_pdf_import" hangs forever
 * - a stale `.lock` in the profile (after any killed soffice) makes every
 *   later run hang; removed before each run
 * - always edit a copy via storeToURL, never `store` in place
 * - soffice may outlive the caller's patience: bounded by a timeout
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DocumentError } from "./model.js"
import { defaultWhich, findSoffice } from "./soffice.js"

const SOFFICE_TIMEOUT_MS = 120_000

export interface LoDrawDeps {
	which?: (cmd: string) => string | undefined
	fileExists?: (p: string) => boolean
	run?: (
		cmd: string,
		args: string[],
		env: Record<string, string>,
	) => { code: number; stderr: string; signal?: NodeJS.Signals }
	mkdtemp?: (prefix: string) => string
	readFile?: (path: string) => string
	writeFile?: (path: string, data: string) => void
	rmdir?: (dir: string) => void
	unlink?: (path: string) => void
	/** Absolute directory containing lodraw_edit.py; auto-resolved otherwise. */
	scriptDir?: string
}

export interface LoDrawResult {
	/** Status parsed from the macro: pages seen, edits applied, per-edit failures. */
	status: { ok: boolean; pages?: number; applied?: number; error?: string; errors?: string[] }
}

function excerpt(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.slice(0, 3)
	return lines.join("; ").slice(0, 300)
}

function resolveScriptDir(deps: Required<LoDrawDeps>): string {
	const scriptName = "lodraw_edit.py"
	const candidates: string[] = []
	if (deps.scriptDir !== "") candidates.push(deps.scriptDir)
	// Bundled/dev runs: the script sits next to this module's compiled output.
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	candidates.push(moduleDir)
	// Dev runs (bun src/.../pdf-cli.ts): the script lives in the repo resources tree.
	candidates.push(resolve(moduleDir, "../../../resources/skills/pdf/scripts"))
	candidates.push(resolve(process.cwd(), "resources/skills/pdf/scripts"))
	for (const dir of candidates) {
		if (deps.fileExists(join(dir, scriptName))) return dir
	}
	throw new DocumentError(
		"corrupt",
		"lodraw_edit.py not found next to the pdf CLI or in the skill resources — reinstall the pdf skill",
		"pdf",
	)
}

export async function runLoDraw(
	mode: "dump" | "apply",
	inputPath: string,
	outPath: string,
	loDeps?: LoDrawDeps,
	mapPath?: string,
): Promise<LoDrawResult> {
	const deps: Required<LoDrawDeps> = {
		which: loDeps?.which ?? defaultWhich,
		fileExists: loDeps?.fileExists ?? existsSync,
		run: loDeps?.run ?? defaultRun,
		mkdtemp: loDeps?.mkdtemp ?? ((prefix) => mkdtempSync(prefix)),
		readFile: loDeps?.readFile ?? ((p) => readFileSync(p, "utf8")),
		writeFile: loDeps?.writeFile ?? ((p, data) => writeFileSync(p, data)),
		rmdir: loDeps?.rmdir ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
		unlink: loDeps?.unlink ?? ((p) => unlinkSync(p)),
		scriptDir: loDeps?.scriptDir ?? "",
	}
	const soffice = findSoffice(deps, {
		format: "pdf",
		commands: "edit-draw/dump-shapes",
		core: "read/info/create/merge/split/fill-form",
	})
	const scriptDir = resolveScriptDir(deps)

	const profileDir = deps.mkdtemp(join(tmpdir(), "pdf-lo-profile-"))
	const statusPath = join(profileDir, "lo-status.json")
	try {
		const scriptsDest = join(profileDir, "user", "Scripts", "python")
		mkdirSync(scriptsDest, { recursive: true })
		// Copy via the injected reader/writer so tests can stage fake script trees.
		deps.writeFile(join(scriptsDest, "lodraw_edit.py"), deps.readFile(join(scriptDir, "lodraw_edit.py")))
		// A stale .lock (from any previously killed soffice) blocks every later
		// run on this profile — remove it before invoking. Fresh profiles have
		// none; absence is fine.
		const lockPath = join(profileDir, ".lock")
		if (deps.fileExists(lockPath)) deps.unlink(lockPath)
		const env: Record<string, string> = {
			LO_MODE: mode,
			LO_PDF: inputPath,
			LO_OUT: outPath,
			LO_STATUS: statusPath,
			...(mapPath !== undefined ? { LO_MAP: mapPath } : {}),
		}
		const conversion = deps.run(
			soffice,
			[
				"--headless",
				"--norestore",
				"--nolockcheck",
				`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
				"vnd.sun.star.script:lodraw_edit.py$main?language=Python&location=user",
			],
			env,
		)
		if (conversion.signal) {
			throw new DocumentError(
				"timeout",
				`LibreOffice did not finish within ${SOFFICE_TIMEOUT_MS / 1000}s. Retry once; if it stalls again, inspect the PDF with read/info instead.`,
				"pdf",
			)
		}
		let status: LoDrawResult["status"] = {
			ok: false,
			error: `soffice exited ${conversion.code}: ${excerpt(conversion.stderr) || "(no stderr)"}`,
		}
		if (deps.fileExists(statusPath)) {
			try {
				status = JSON.parse(deps.readFile(statusPath))
			} catch {
				// keep the default soffice-exit error
			}
			deps.unlink(statusPath)
		}
		if (!status.ok) {
			throw new DocumentError("corrupt", `LibreOffice edit failed: ${status.error ?? "(no status)"}`, "pdf")
		}
		if (!deps.fileExists(outPath)) {
			throw new DocumentError("corrupt", `LibreOffice reported success but produced no file at ${outPath}`, "pdf")
		}
		return { status }
	} finally {
		deps.rmdir(profileDir)
	}
}

function defaultRun(
	cmd: string,
	args: string[],
	env: Record<string, string>,
): { code: number; stderr: string; signal?: NodeJS.Signals } {
	const result = spawnSync(cmd, args, {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: SOFFICE_TIMEOUT_MS,
	})
	return {
		code: result.status ?? 1,
		stderr: result.stderr ?? result.error?.message ?? "",
		signal: result.signal ?? undefined,
	}
}
