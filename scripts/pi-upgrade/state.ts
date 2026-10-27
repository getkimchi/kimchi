import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { HOOKED_FILES } from "./hooks.ts"

/** GitHub caps issue bodies and comments at this many characters. */
export const GITHUB_TEXT_LIMIT = 65_536

/** Persisted in a bot comment on the rolling issue; the issue is the job's only storage. */
export interface State {
	v: 1
	/** Per-release digests keyed `"<from>..<to>"`. Facts about Pi, reused across runs. */
	digests: Record<string, unknown>
	lastRun?: { baseline: string; target: string; inputsHash: string; at: string }
	/** Target a human skipped by closing the issue; stays quiet until a newer one settles. */
	skippedTarget?: string
	/** The job closed the issue itself because we were up to date. */
	closedByJob?: boolean
}

const PLAIN = /<!-- pi-upgrade-state: ([\s\S]*?) -->/
const GZ = /<!-- pi-upgrade-state-gz: ([A-Za-z0-9+/=]+) -->/

export function emptyState(): State {
	return { v: 1, digests: {} }
}

export function parseState(body: string | undefined): State {
	if (!body) return emptyState()
	try {
		const gz = GZ.exec(body)
		if (gz) return JSON.parse(gunzipSync(Buffer.from(gz[1], "base64")).toString("utf8"))
		const plain = PLAIN.exec(body)
		if (plain) return JSON.parse(plain[1])
	} catch {
		// A hand-edited or truncated marker means "re-analyse", not "fail the run".
	}
	return emptyState()
}

export function serializeState(state: State, limit = GITHUB_TEXT_LIMIT): string {
	// `--` cannot appear inside an HTML comment; JSON never needs it unescaped.
	const json = JSON.stringify(state).replaceAll("--", "-\\u002d")
	const plain = `<!-- pi-upgrade-state: ${json} -->`
	if (plain.length <= limit) return plain
	const gz = `<!-- pi-upgrade-state-gz: ${gzipSync(JSON.stringify(state)).toString("base64")} -->`
	if (gz.length <= limit) return gz
	throw new Error(`pi-upgrade state is ${gz.length} chars compressed, exceeds the ${limit} limit`)
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? listFiles(path) : [path]
	})
}

/** Fingerprint of everything a report depends on besides src/ (refreshed weekly instead). */
export function inputsHash(repoRoot: string, baseline: string, target: string, files = HOOKED_FILES): string {
	const hash = createHash("sha256").update(`${baseline}\n${target}\n`)
	const paths = [...listFiles(join(repoRoot, "patches")), ...files.map((f) => join(repoRoot, f))]
		.filter((p) => existsSync(p))
		.sort()
	for (const path of paths) {
		hash.update(`${relative(repoRoot, path)}\n`).update(readFileSync(path))
	}
	return hash.digest("hex")
}
