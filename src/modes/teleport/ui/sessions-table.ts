import type { RemoteSessionStatus } from "../types.js"

export type SessionRowState = "foreground" | "detached (this kimchi)" | "detached" | "active elsewhere"

export interface SessionRow {
	id: string
	host?: string
	name: string
	state: SessionRowState
	status?: RemoteSessionStatus
	createdAt?: Date
	lastActivityAt?: Date
}

const HEADERS = {
	id: "ID",
	host: "HOST",
	name: "NAME",
	status: "STATUS",
	lastActivity: "LAST ACTIVITY",
}

const MIN_NAME_WIDTH = 8

export function renderSessionsTable(
	rows: SessionRow[],
	now: Date = new Date(),
	width: number = process.stdout.columns || 120,
): string {
	const idWidth = Math.max(HEADERS.id.length, ...rows.map((r) => r.id.length))
	const hostWidth = Math.max(HEADERS.host.length, ...rows.map((r) => (r.host ? r.host.split(".")[0] : "-").length))
	const statusWidth = Math.max(HEADERS.status.length, ...rows.map((r) => (r.status ?? "-").length))
	const lastWidth = HEADERS.lastActivity.length

	// Layout: <marker> <id> <host> <name> <status> <last>
	// Inter-column separator: one space. Marker is 1 char + 1 space.
	const fixed = 1 /* marker */ + 1 + idWidth + 1 + hostWidth + 1 + statusWidth + 1 + lastWidth
	const longestName = Math.max(HEADERS.name.length, ...rows.map((r) => (r.name || "-").length))
	const available = Math.max(MIN_NAME_WIDTH, width - fixed - 2)
	const nameWidth = Math.min(longestName, available)

	const header = [
		" ", // marker column header
		pad(HEADERS.id, idWidth),
		pad(HEADERS.host, hostWidth),
		pad(HEADERS.name, nameWidth),
		pad(HEADERS.status, statusWidth),
		HEADERS.lastActivity,
	].join(" ")

	const lines: string[] = [header]
	for (const row of rows) {
		const marker = row.state === "foreground" ? "*" : " "
		const id = pad(row.id, idWidth)
		const hostPrefix = row.host ? row.host.split(".")[0] : "-"
		const host = pad(hostPrefix, hostWidth)
		const name = pad(truncate(row.name || "-", nameWidth), nameWidth)
		const status = pad(row.status ?? "-", statusWidth)
		const lastActivity = row.lastActivityAt ? formatRelativeTime(row.lastActivityAt, now) : "-"
		lines.push([marker, id, host, name, status, lastActivity].join(" "))
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
