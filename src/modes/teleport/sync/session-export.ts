import { readFileSync, writeFileSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentSession } from "@earendil-works/pi-coding-agent"

export const TELEPORT_SESSION_FILE_NAME = "teleport-session-export.jsonl"

export interface ExportSessionOptions {
	/** The local AgentSession to export. */
	homeBase: AgentSession
	/** The local CWD used to derive the remote rsync destination. */
	localCwd: string
	/** The remote sandbox destination directory (e.g. "/home/sandbox/myproject/"). */
	sandboxDest: string
	/** Optional temp directory; defaults to os.tmpdir(). */
	tmpDir?: string
}

export interface ExportSessionResult {
	/** Path to the local temp directory containing the exported session file. */
	localDir: string
	/** Absolute path on the remote where the file should land after rsync. */
	remotePath: string
}

/**
 * Export the local agent session to a JSONL file whose header `cwd` has been
 * rewritten to match the remote filesystem.  This allows the remote server to
 * load it via `switch_session` without hitting `MissingSessionCwdError`.
 *
 * The exported file is placed in a temporary directory suitable for passing
 * directly to `runRsync` so it lands in the remote's pi-mono session directory.
 */
export function exportSessionForTeleport(opts: ExportSessionOptions): ExportSessionResult {
	// 1. Export via upstream's exportToJsonl (linearises the current branch).
	const localDir = join(opts.tmpDir ?? tmpdir(), `kimchi-session-export-${Date.now()}`)
	mkdirSync(localDir, { recursive: true })
	const localFile = join(localDir, TELEPORT_SESSION_FILE_NAME)

	const exportedPath = opts.homeBase.exportToJsonl(localFile)

	// 2. Read, mutate header cwd, write back.
	const raw = readFileSync(exportedPath, "utf-8")
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
	if (lines.length === 0) {
		throw new Error("exportToJsonl produced an empty file")
	}

	const header = JSON.parse(lines[0]) as Record<string, unknown>
	if (header.type !== "session") {
		throw new Error("Unexpected session export header type")
	}

	// Derive the remote CWD from sandboxDest (strip trailing slash).
	const remoteCwd = opts.sandboxDest.replace(/\/+$/, "")
	header.cwd = remoteCwd

	lines[0] = JSON.stringify(header)
	writeFileSync(exportedPath, `${lines.join("\n")}\n`, "utf-8")

	// 3. Compute the remote session directory path.
	// The remote agent runs in the sandbox; its CWD will be the sandboxDest.
	// We replicate getDefaultSessionDir logic manually to avoid creating dirs
	// on the local filesystem unnecessarily.
	const remoteAgentDir = "/home/sandbox/.pi/agent"
	const safeCwd = `--${remoteCwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`
	const remoteSessionDir = join(remoteAgentDir, "sessions", safeCwd)
	const remotePath = join(remoteSessionDir, TELEPORT_SESSION_FILE_NAME)

	return { localDir, remotePath }
}
