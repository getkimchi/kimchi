/**
 * Session directory encoding shared between the ACP server, the TUI resume
 * picker, and worktree session listing.
 *
 * Mirrors pi's getDefaultSessionDir (core/session-manager.js): sessions are
 * stored one directory per encoded cwd — `<agentDir>/sessions/<encoded-cwd>/`.
 * Encoding is a public on-disk format; drift surfaces as "no sessions found"
 * rather than silent corruption.
 */

import { join } from "node:path"

/** <cwd> → the on-disk dir suffix that names the session folder. */
export function encodeSessionCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

/** The session directory holding a given cwd's persisted sessions. */
export function sessionDirForCwd(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", encodeSessionCwdDir(cwd))
}
