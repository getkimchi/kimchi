import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import { PLAN_DIR } from "../../shared/planning/plan-markdown.js"

const PREFIX = "Read the Kimchi objective file at "
const SUFFIX = " before continuing."
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-objective\.md$/

function objectiveDirectory(cwd: string): string {
	return join(realpathSync(cwd), PLAN_DIR)
}

/** Recognize only our generated reference, including when its target is missing. */
export function objectiveFilePath(objective: string, cwd: string): string | undefined {
	if (!objective.startsWith(PREFIX)) return undefined
	try {
		if (!objective.endsWith(SUFFIX)) throw new Error("invalid reference suffix")
		const path: unknown = JSON.parse(objective.slice(PREFIX.length, -SUFFIX.length))
		if (
			typeof path !== "string" ||
			!FILE_NAME.test(basename(path)) ||
			path !== join(objectiveDirectory(cwd), basename(path)) ||
			objective !== `${PREFIX}${JSON.stringify(path)}${SUFFIX}`
		) {
			throw new Error("reference is not a generated file in this project's plan directory")
		}
		return path
	} catch (error) {
		throw new Error("Invalid Kimchi objective file reference.", { cause: error })
	}
}

export function objectiveText(objective: string, cwd: string): string {
	const path = objectiveFilePath(objective, cwd)
	if (!path) return objective
	try {
		if (realpathSync(path) !== path) throw new Error("objective file must not redirect outside its managed path")
		// The plans directory is project-scoped: while the project is
		// untrusted, a shipped objective file must not steer a guided
		// workflow — treat it as unreadable, exactly like a deleted file.
		if (!isProjectScopeAllowed(cwd)) throw new Error("project plans are not trusted")
		const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))
		if (!text.trim()) throw new Error("objective file is empty")
		return text
	} catch (error) {
		throw new Error(`Could not read Kimchi objective file ${JSON.stringify(path)}.`, { cause: error })
	}
}

/**
 * Publish a new revision's complete text before its reference is journaled.
 *
 * The plans directory is project-scoped: while the project is untrusted, the
 * file is NOT written (writing would both modify a repo the user declined to
 * trust and arm the trust prompt on the next launch via the .kimchi/plans
 * scan entry) — the raw text is returned as the objective instead, which
 * objectiveText/objectiveFilePath treat as a plain (non-file) objective.
 */
export function saveObjectiveFile(text: string, cwd: string): string {
	if (!text.trim()) throw new Error("Ferment V2 objective cannot be empty.")
	if (!isProjectScopeAllowed(cwd)) {
		return text
	}
	let path: string | undefined
	let created = false
	try {
		const directory = objectiveDirectory(cwd)
		mkdirSync(directory, { recursive: true })
		if (realpathSync(directory) !== directory) throw new Error("objective directory must not redirect")
		path = join(directory, `${randomUUID()}-objective.md`)
		const fd = openSync(path, "wx", 0o600)
		created = true
		try {
			writeFileSync(fd, text, "utf8")
		} finally {
			closeSync(fd)
		}
		return `${PREFIX}${JSON.stringify(path)}${SUFFIX}`
	} catch (error) {
		if (created && path) {
			try {
				unlinkSync(path)
			} catch {}
		}
		throw new Error("Could not save Kimchi objective file.", { cause: error })
	}
}
