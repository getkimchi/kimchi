import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

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
	} catch (err) {
		console.warn("Failed to create annotated session copy:", err)
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
	/** Git anchor of the local repo at teleport time (undefined outside git repos). */
	git?: { headSha?: string; dirty: boolean }
	/** How the remote workspace was bootstrapped. */
	workspace:
		| { kind: "git-clone"; repo: string; branch?: string }
		| { kind: "rsync"; fileCount: number; syncedDotKimchi: boolean }
		| { kind: "none" }
	/** Whether a git identity (user.name/user.email) was pushed to the sandbox. */
	gitIdentityProvisioned: boolean
	/** Whether a git credential was provisioned. Contains ONLY the host — the
	 *  token itself is a secret and must never reach the session history, so
	 *  this type deliberately has no field for it. */
	gitCredential?: { host: string }
}

export function buildHandoffNote(input: HandoffNoteInput): string {
	let fromDescription = `Previous environment: ${input.fromPlatform}, cwd ${input.fromCwd}`
	if (input.git) {
		const parts: string[] = []
		if (input.git.headSha) parts.push(`local repo at ${input.git.headSha}`)
		if (input.git.dirty) parts.push("working tree dirty")
		if (parts.length > 0) fromDescription += ` (${parts.join(", ")})`
	}

	const lines: string[] = [
		"[Teleport] Environment handoff: this session was moved from a local machine to a remote sandbox.",
		"The conversation history above was produced in the previous environment — paths, tools, and artifacts it references may not exist here.",
		"",
		fromDescription,
		`Current environment: Linux sandbox${input.toCwd ? `, cwd ${input.toCwd}` : ""}`,
	]

	switch (input.workspace.kind) {
		case "git-clone": {
			let line = `Workspace provisioning: fresh git clone of ${input.workspace.repo}${input.workspace.branch ? ` (branch ${input.workspace.branch})` : ""} — uncommitted changes and gitignored content were NOT carried over.`
			if (input.git?.headSha) {
				line += ` The local repo was at commit ${input.git.headSha}, so history references to newer local commits or files may not resolve.`
			}
			lines.push("", line)
			break
		}
		case "rsync": {
			// The carried-over claim depends on what we actually know about the
			// local tree: assert it only for a confirmed dirty tree, state
			// cleanliness when confirmed clean, and stay silent when the local
			// git state is unknown (no anchor) — claiming carry-over we can't
			// verify mislabeled clean teleports.
			const carriedOver =
				input.git === undefined
					? ""
					: input.git.dirty
						? "uncommitted local changes were carried over. "
						: "the working tree was clean — no uncommitted changes existed to carry over. "
			const dotKimchi = input.workspace.syncedDotKimchi
				? "The project working state (.kimchi/ — ferment plans & runtime, transient docs) was synced."
				: "The project working state (.kimchi/ — ferment plans & runtime, transient docs) was NOT synced; do not expect ferment state or prior working documents to exist here."
			lines.push(
				"",
				`Workspace provisioning: rsync of the working tree (${input.workspace.fileCount} files) — ${carriedOver}Gitignored content (dependencies such as node_modules, build outputs, caches) was NOT. ${dotKimchi}`,
			)
			break
		}
		case "none":
			lines.push("", `Workspace provisioning: no workspace content was synced to the sandbox.`)
			break
	}

	lines.push(
		"",
		// gitCredential carries only the host — never the token itself (secret).
		`Git identity provisioned in sandbox: ${input.gitIdentityProvisioned ? "yes" : "no"}. Git credential: ${input.gitCredential ? `provisioned for ${input.gitCredential.host}` : "not provisioned"}.`,
		"",
		`History is not fully replayable here: earlier turns may show tools, files, or authenticated commands from the previous machine that would fail now. Verify tool availability with \`command -v <tool>\` and install missing tools via the sandbox package manager before relying on earlier results.`,
	)

	return lines.join("\n")
}

interface ParsedEntry {
	type?: string
	id?: string
}

function randomId(): string {
	return randomUUID()
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
	return `${[...base, noteLine].join("\n")}\n`
}
