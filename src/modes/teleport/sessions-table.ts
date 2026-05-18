import type { RemoteSessionStatus } from "../remote/types.js"

export type SessionRowState = "foreground" | "detached (this kimchi)" | "detached" | "active elsewhere"

export interface SessionRow {
	id: string
	name: string
	state: SessionRowState
	status?: RemoteSessionStatus
	createdAt?: Date
	lastActivityAt?: Date
}

const HEADERS = {
	state: "STATE",
	id: "ID",
	name: "NAME",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
}

const MIN_NAME_WIDTH = 8
const COLUMN_SEPARATORS = 5 // one space between each of the 6 columns
const DEFAULT_FALLBACK_WIDTH = 80
const TERMINAL_MARGIN = 1 // leave one char so pi-tui's chat padding doesn't wrap us

interface ResolvedWidths {
	marker: number
	state: number
	id: number
	name: number
	status: number
	lastActivity: number
}

/**
 * Resolve target render width: caller override → terminal columns (minus a
 * small margin so pi-tui's chat container doesn't wrap us) → 80 fallback.
 */
function resolveTotalWidth(override: number | undefined): number {
	if (typeof override === "number" && override > 0) return override
	const cols = process.stdout?.columns
	if (typeof cols === "number" && cols > 0) return Math.max(MIN_NAME_WIDTH + 20, cols - TERMINAL_MARGIN)
	return DEFAULT_FALLBACK_WIDTH
}

/**
 * Per-render column sizing. STATE / STATUS / LAST ACTIVITY shrink to fit
 * their actual content (capped at header width as a floor); NAME absorbs
 * whatever's left of the total width. NAME is never narrower than
 * MIN_NAME_WIDTH so a tiny terminal still shows something useful.
 */
function computeWidths(rows: SessionRow[], now: Date, totalWidth: number): ResolvedWidths {
	const stateContent = Math.max(HEADERS.state.length, ...rows.map((r) => r.state.length))
	// IDs are UUID-style and are what users feed back into /connect, /attach,
	// and /detach — render them in full. Auto-size to the widest id (or the
	// header label, whichever is wider).
	const idContent = Math.max(HEADERS.id.length, ...rows.map((r) => r.id.length))
	const statusContent = Math.max(HEADERS.status.length, ...rows.map((r) => (r.status ?? "-").length))
	const lastContent = Math.max(
		HEADERS.lastActivity.length,
		...rows.map((r) => (r.lastActivityAt ? formatRelativeTime(r.lastActivityAt, now) : "-").length),
	)

	const fixed = 1 /* marker */ + stateContent + idContent + statusContent + lastContent + COLUMN_SEPARATORS
	const name = Math.max(MIN_NAME_WIDTH, totalWidth - fixed)

	return {
		marker: 1,
		state: stateContent,
		id: idContent,
		name,
		status: statusContent,
		lastActivity: lastContent,
	}
}

export function renderSessionsTable(rows: SessionRow[], now: Date = new Date(), width?: number): string {
	const cols = computeWidths(rows, now, resolveTotalWidth(width))

	const header = [
		" ".repeat(cols.marker),
		pad(HEADERS.state, cols.state),
		pad(HEADERS.id, cols.id),
		pad(HEADERS.name, cols.name),
		pad(HEADERS.status, cols.status),
		HEADERS.lastActivity,
	].join(" ")

	const lines: string[] = [header]
	for (const row of rows) {
		const marker = row.state === "foreground" ? "*" : " "
		const id = row.id
		const name = truncate(row.name || "-", cols.name)
		const status = pad(row.status ?? "-", cols.status)
		const lastActivity = row.lastActivityAt ? formatRelativeTime(row.lastActivityAt, now) : "-"
		lines.push(
			[marker, pad(row.state, cols.state), pad(id, cols.id), pad(name, cols.name), status, lastActivity].join(" "),
		)
	}
	return lines.join("\n")
}

export function formatRelativeTime(d: Date, now: Date = new Date()): string {
	const diffMs = now.getTime() - d.getTime()
	if (diffMs < 0) return "just now"
	const sec = Math.floor(diffMs / 1000)
	if (sec < 60) return "just now"
	const min = Math.floor(sec / 60)
	if (min < 60) return `${min}m ago`
	const hr = Math.floor(min / 60)
	if (hr < 24) return `${hr}h ago`
	const days = Math.floor(hr / 24)
	if (days === 1) return "yesterday"
	return `${days}d ago`
}

function pad(s: string, width: number): string {
	if (s.length >= width) return s
	return s + " ".repeat(width - s.length)
}

function truncate(s: string, width: number): string {
	if (s.length <= width) return s
	if (width <= 1) return s.slice(0, width)
	return `${s.slice(0, width - 1)}…`
}
