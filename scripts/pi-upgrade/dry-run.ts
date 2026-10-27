import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type RunConfig, readJson, writeJson } from "./config.ts"
import { PACKAGES, pkgDir } from "./fetch.ts"
import type { SettleResult } from "./settle.ts"

export interface HunkResult {
	file: string
	hunk: number
	/** Exact context at any line offset (`git apply --check`). */
	strict: "ok" | "fail"
	/** Context drift tolerated (`patch --fuzz=3`). Strict fail + fuzz ok = mechanical rebase. */
	fuzz: "ok" | "fail"
	missingFile?: boolean
}

export interface PatchResult {
	patch: string
	pkg: string
	hunks: HunkResult[]
	appliesStrict: boolean
	appliesFuzz: boolean
}

interface Hunk {
	file: string
	hunk: number
	/** A complete single-hunk patch: the file header plus this hunk only. */
	text: string
}

/**
 * Splits a (pnpm-style, `a/`/`b/`-prefixed) patch into one patch per hunk, so each hunk is
 * judged on its own by exit code — GNU and BSD `patch` word per-hunk messages differently.
 */
export function splitHunks(patch: string): Hunk[] {
	const hunks: Hunk[] = []
	for (const section of patch.split(/^(?=diff --git )/m)) {
		if (!section.startsWith("diff --git ")) continue
		const file = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? /^diff --git a\/(\S+)/.exec(section)?.[1] ?? "?"
		const firstHunk = section.search(/^@@ /m)
		if (firstHunk < 0) continue
		const header = section.slice(0, firstHunk)
		const bodies = section.slice(firstHunk).split(/^(?=@@ )/m)
		bodies.forEach((body, i) => {
			hunks.push({ file, hunk: i + 1, text: header + body })
		})
	}
	return hunks
}

function run(cmd: string, args: string[], cwd: string, input?: string): boolean {
	// The ceiling keeps `git apply` from discovering an enclosing repository (outDir sits inside one).
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) }
	return spawnSync(cmd, args, { cwd, input, env, stdio: ["pipe", "ignore", "ignore"] }).status === 0
}

export function checkPatch(patchFile: string, targetPkgDir: string): Omit<PatchResult, "patch" | "pkg"> {
	const tmp = mkdtempSync(join(tmpdir(), "pi-upgrade-hunk-"))
	try {
		const hunkFile = join(tmp, "hunk.patch")
		const work = join(tmp, "work")
		const hunks = splitHunks(readFileSync(patchFile, "utf8")).map((h): HunkResult => {
			const source = join(targetPkgDir, h.file)
			if (!existsSync(source)) {
				return { file: h.file, hunk: h.hunk, strict: "fail", fuzz: "fail", missingFile: true }
			}
			// Check against a copy with a trailing newline: npm dist files often lack one while our
			// stored patches don't carry the "\ No newline" marker, and pnpm's patcher ignores that.
			rmSync(work, { recursive: true, force: true })
			mkdirSync(dirname(join(work, h.file)), { recursive: true })
			const content = readFileSync(source, "utf8")
			writeFileSync(join(work, h.file), content.endsWith("\n") ? content : `${content}\n`)
			writeFileSync(hunkFile, h.text)
			const strict = run("git", ["apply", "--check", "-p1", hunkFile], work) ? "ok" : "fail"
			const fuzz =
				strict === "ok" || run("patch", ["-p1", "--dry-run", "--batch", "--fuzz=3", "-i", hunkFile], work)
					? "ok"
					: "fail"
			return { file: h.file, hunk: h.hunk, strict, fuzz }
		})
		return {
			hunks,
			appliesStrict: hunks.every((h) => h.strict === "ok"),
			appliesFuzz: hunks.every((h) => h.fuzz === "ok"),
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

/** `patches/@earendil-works__<pkg>@<baseline>.patch` for every tracked package that has one. */
export function piPatches(repoRoot: string, baseline: string): Array<{ pkg: string; file: string }> {
	const dir = join(repoRoot, "patches")
	const names = new Set(readdirSync(dir))
	return PACKAGES.map((pkg) => ({ pkg, name: `@earendil-works__${pkg}@${baseline}.patch` }))
		.filter(({ name }) => names.has(name))
		.map(({ pkg, name }) => ({ pkg, file: join(dir, name) }))
}

export async function runDryRun(cfg: RunConfig): Promise<PatchResult[]> {
	const { target } = readJson<SettleResult>(cfg, "settle")
	if (!target) throw new Error("no target version: nothing to dry-run")
	const results = piPatches(cfg.repoRoot, cfg.baseline).map(({ pkg, file }) => ({
		patch: file.split("/").pop() ?? file,
		pkg,
		...checkPatch(file, pkgDir(cfg, pkg, target)),
	}))
	writeJson(cfg, "dry-run", results)
	return results
}
