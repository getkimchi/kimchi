import {
	type LimitNotices,
	type PendingRepository,
	type ReportingState,
	type ServerLimit,
	UPLOAD_INTERVAL_MS,
} from "./queue.js"
import type { ReportingRepository } from "./snapshot.js"

const name = (repository: ReportingRepository) => repository.name ?? `${repository.host} repository ${repository.id}`
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

function inAbout(ms: number): string {
	if (ms <= 0) return "at the next upload"
	const minutes = Math.max(1, Math.round(ms / 60_000))
	return `in about ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`
}

function reached(limit: ServerLimit): string {
	const values =
		limit.current !== undefined && limit.maximum !== undefined ? ` ${limit.current} of ${limit.maximum}` : ""
	return `${limit.scope ?? "server"} limit reached${limit.limit ? ` (${limit.limit}${values})` : ""}`
}

/** A snapshot limit in a dimension trimming can shrink is retried with a smaller snapshot. */
function shrinking({ limit, learned }: PendingRepository): boolean {
	return (
		limit?.scope === "snapshot" &&
		(limit.limit === "requests" || limit.limit === "pullRequests" || limit.limit === "bytes") &&
		learned?.[limit.limit] !== undefined
	)
}

const owner = (limit: ServerLimit) =>
	limit.scope === "contributor" ? "your account in this organization" : "this organization"
const paused = (limit: ServerLimit) =>
	`PR cost reporting paused for ${owner(limit)}: limit reached. Ask an admin to free space or wait.`

/** One-time notices: an account pause, or a repository that is only partly reported. */
export function limitNoticeTexts(notices: LimitNotices): string[] {
	return [
		...new Set(notices.pauses.map(paused)),
		...notices.repositories.map(
			(repository) =>
				`PR costs for ${name(repository)} are partially reported: limit reached. See /pr-reporting status.`,
		),
	]
}

/** The `/pr-reporting status` text. `skipReason` describes this session, not the saved choice. */
export function statusText(
	state: ReportingState,
	skipReason: string | undefined,
	now = Date.now(),
): { text: string; warning: boolean } {
	const entries = Object.values(state.entries)
	const pending = entries.filter((entry) => entry.pending)
	const waiting = pending.filter(
		(entry) =>
			!entry.urgent &&
			entry.uploadedAt !== undefined &&
			entry.uploadedAt <= now &&
			now - entry.uploadedAt < UPLOAD_INTERVAL_MS,
	).length
	const problems = [
		...Object.values(state.paused ?? {}).map(
			(pause) =>
				`PR cost reporting paused for ${owner(pause.limit)}: ${reached(pause.limit)}. Ask an admin to free space or wait; next try ${inAbout(pause.retryAt - now)}.`,
		),
		...entries.flatMap((entry) => {
			const lines: string[] = []
			if (entry.limit)
				lines.push(
					`${name(entry.repository)}: ${reached(entry.limit)}. ${shrinking(entry) ? "Sending a smaller snapshot" : "Not reported; next try"} ${inAbout(entry.retryAt - now)}.`,
				)
			if (entry.trimmed)
				lines.push(
					`${name(entry.repository)} is partially reported: ${plural(entry.trimmed, "request")} left out to fit the upload limits.`,
				)
			return lines
		}),
		...new Set(
			[state.error, ...pending.map((entry) => entry.lastError)].filter((value): value is string => value !== undefined),
		),
	]
	return {
		text: [
			`PR reporting: ${state.enabled ? "on" : "off"} (${state.followsTelemetry ? "SaaS default" : "explicit choice"})`,
			...(skipReason ? [`Uploads are skipped in this session: ${skipReason}. Local attribution continues.`] : []),
			`Queued repositories: ${pending.length}${waiting ? ` (${waiting} waiting for the 5-minute upload window)` : ""}`,
			`Acknowledged repositories: ${entries.filter((entry) => entry.lastAcknowledgedAt).length}`,
			...problems,
		].join("\n"),
		warning: problems.length > 0,
	}
}
