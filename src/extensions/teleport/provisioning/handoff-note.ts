import { basename, join } from "node:path"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

/**
 * Teleport environment-handoff note.
 *
 * When a local session file is uploaded to a remote sandbox, the conversation
 * history still claims facts about the *local* environment (cwd, OS, artifacts
 * produced by earlier commands). The remote agent can easily get confused when
 * those files/tools do not exist. This module builds a transparency note and
 * appends it to an annotated COPY of the session JSONL (the user's local
 * session file is never mutated) so the resumed agent — and the user reading
 * the transcript — sees exactly what happened: new environment, how the
 * workspace was provisioned, and which heuristics were used.
 *
 */

/**
 * Write an annotated COPY of the session file to a temp dir: read the local
 * session JSONL and save it with the handoff note appended. The user's local
 * session file is never mutated.
 *
 * A real file is required because session upload is a multipart POST that
 * streams from a path on disk (`createSession(..., { sessionFile: path })`);
 * there is no in-memory upload variant.
 *
 * Returns the copy's path, or undefined on any failure (callers then fall
 * back to uploading the original file). The copy sits at the root of its own
 * temp dir — callers are responsible for calling removeTempDir(dirname(path))
 * once the upload has finished.
 */
export function copySessionFileAndAddHandoffNote(sessionFile: string, note: string): string | undefined {
	try {
		const src = readFileSync(sessionFile, "utf8")
		const annotated = addHandoffNoteToSessionJsonl(src, note)
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-teleport-"))
		const filePath = join(tempDir, basename(sessionFile))
		writeFileSync(filePath, annotated, "utf8")
		return filePath
	} catch {
		return undefined
	}
}

/** Best-effort removal of the temp dir produced by copySessionFileAndAddHandoffNote. */
export function removeTempDir(tempDir: string): void {
	try {
		rmSync(tempDir, { recursive: true, force: true })
	} catch {
		// best effort
	}
}

export interface HandoffNoteInput {
	/** OS of the machine the session was running on (e.g. "darwin"). */
	fromPlatform: string
	/** Local working directory the history was generated in. */
	fromCwd: string
	/** Working directory the remote session will start in, if known. */
	toCwd?: string
	/** How the remote workspace was bootstrapped. */
	workspace:
		| { kind: "git-clone"; repo: string; branch?: string }
		| { kind: "rsync"; fileCount: number; bytes: number }
		| { kind: "none" }
	/** Whether a git identity (user.name/user.email) was pushed to the sandbox. */
	gitIdentityProvisioned: boolean
	/** Whether a git credential was provisioned. Contains ONLY the host — the
	 *  token itself is a secret and must never reach the session history, so
	 *  this type deliberately has no field for it. */
	gitCredential?: { host: string }
}

export function buildHandoffNote(input: HandoffNoteInput): string {
	const lines: string[] = [
		"[Teleport] Environment handoff: this session was moved from a local machine to a remote sandbox.",
		`The conversation history above was produced in the previous environment — paths, tools, and artifacts it references may not exist here.`,
		``,
		`Previous environment: ${input.fromPlatform}, cwd ${input.fromCwd}`,
		`Current environment: Linux sandbox${input.toCwd ? `, cwd ${input.toCwd}` : ""}`,
	]

	switch (input.workspace.kind) {
		case "git-clone":
			lines.push(
				"",
				`Workspace provisioning: the remote workspace is a fresh git clone of ${input.workspace.repo}${input.workspace.branch ? ` (branch ${input.workspace.branch})` : ""}. Local uncommitted changes were NOT carried over.`,
			)
			break
		case "rsync":
			lines.push(
				"",
				`Workspace provisioning: the workspace was synced with rsync using a git-based include-list heuristic (${input.workspace.fileCount} files). Only git-tracked files and untracked non-ignored files were copied. Gitignored content such as dependencies (node_modules), build outputs, and local caches may be missing.`,
			)
			break
		case "none":
			lines.push(
				"",
				`Workspace provisioning: no workspace content was synced to the sandbox.`,
			)
			break
	}

	lines.push(
		"",
		// gitCredential carries only the host — never the token itself (secret).
		`Git identity provisioned in sandbox: ${input.gitIdentityProvisioned ? "yes" : "no"}. Git credential: ${input.gitCredential ? `provisioned for ${input.gitCredential.host}` : "not provisioned"}.`,
		"",
		`Do not assume tools or file artifacts from the previous machine exist here — verify availability with \`command -v <tool>\` before relying on earlier results, and install missing tools via the sandbox's package manager if needed.`,
	)

	return lines.join("\n")
}

interface ParsedEntry {
	type?: string
	id?: string
}

function randomId(): string {
	return (Math.random() * 0xffffffff + 0x100000000).toString(16).slice(-8)
}

function stringifyEntry(entry: Record<string, unknown>): string {
	return JSON.stringify(entry)
}

/**
 * Find the id of the last entry in a session JSONL line list, to chain
 * parentId from. Scans from the end and stops at the last non-empty line:
 * malformed trailing content returns null rather than being skipped past.
 */
function findLastMessageId(lines: string[]): string | null {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]) continue
		try {
			const entry = JSON.parse(lines[i]) as ParsedEntry
			if (entry && typeof entry.id === "string") return entry.id
			return null
		} catch {
			return null
		}
	}
	return null
}

/**
 * Append a teleport transparency note (as a user message) to session JSONL.
 * Malformed lines are preserved verbatim; the note is chained to the last
 * entry via parentId.
 */
export function addHandoffNoteToSessionJsonl(sessionJsonl: string, note: string): string {
	const lines = sessionJsonl.split("\n")
	const now = Date.now()
	const lastId = findLastMessageId(lines)

	const noteLine = stringifyEntry({
		type: "message",
		id: randomId(),
		parentId: lastId,
		timestamp: new Date(now).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text: note }],
			timestamp: now,
		},
	})

	// Drop a trailing empty line (from a trailing newline) so the appended
	// line stays properly delimited, then re-add the trailing newline.
	const base = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines
	return [...base, noteLine].join("\n") + "\n"
}
