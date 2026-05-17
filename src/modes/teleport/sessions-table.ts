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

const COL = {
	marker: 1,
	state: 22,
	id: 8,
	name: 16,
	status: 9,
	lastActivity: 14,
}

const HEADERS = {
	state: "STATE",
	id: "ID",
	name: "NAME",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
}

export function renderSessionsTable(rows: SessionRow[], now: Date = new Date()): string {
	const header = [
		" ".repeat(COL.marker),
		pad(HEADERS.state, COL.state),
		pad(HEADERS.id, COL.id),
		pad(HEADERS.name, COL.name),
		pad(HEADERS.status, COL.status),
		HEADERS.lastActivity,
	].join(" ")

	const lines: string[] = [header]
	for (const row of rows) {
		const marker = row.state === "foreground" ? "*" : " "
		const id = row.id.slice(0, COL.id)
		const name = truncate(row.name || "-", COL.name)
		const status = pad(row.status ?? "-", COL.status)
		const lastActivity = row.lastActivityAt ? formatRelativeTime(row.lastActivityAt, now) : "-"
		lines.push(
			[marker, pad(row.state, COL.state), pad(id, COL.id), pad(name, COL.name), status, lastActivity].join(" "),
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
