import { wrapTextWithAnsi } from "@earendil-works/pi-tui"
import {
	inUploadWindow,
	type LimitNotices,
	type PendingRepository,
	type ReportingState,
	type ServerLimit,
} from "./queue.js"
import type { ReportingRepository } from "./snapshot.js"

const name = (repository: ReportingRepository) => repository.name ?? `${repository.host} repository ${repository.id}`
const formatCount = (count: number) => count.toLocaleString("en-US")
const plural = (count: number, noun: string) => `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`

function inAbout(ms: number): string {
	if (ms <= 0) return "at the next upload"
	const minutes = Math.max(1, Math.round(ms / 60_000))
	return `in about ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`
}

function reached(limit: ServerLimit): string {
	const values =
		limit.current !== undefined && limit.maximum !== undefined
			? ` ${formatCount(limit.current)} of ${formatCount(limit.maximum)}`
			: ""
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

/** Lines fit a 60-column TUI, which pads notifications by one column on each side. */
const WIDTH = 58
/** "Repositories" and a three-space gutter. */
const LABEL_WIDTH = 15

/** A label and its values, each starting a line of the value column. */
const row = (label: string, ...values: string[]) =>
	values
		.flatMap((value) => wrapTextWithAnsi(value, WIDTH - LABEL_WIDTH))
		.map((line, index) => `${(index ? "" : label).padEnd(LABEL_WIDTH)}${line}`)
/** Section text wrapped two columns in; `first` starts its first line. */
const wrap = (text: string, first: string) =>
	wrapTextWithAnsi(text, WIDTH - 2).map((line, index) => `${index ? "  " : first}${line}`)

/**
 * The `/pr-reporting status` text. `skipReason` describes this session, not the saved choice. Server limits and
 * delivery problems come first and make it a warning; skipped history alone is information, because the other
 * requests still report.
 */
export function statusText(
	state: ReportingState,
	skipReason: string | undefined,
	now = Date.now(),
): { text: string; warning: boolean } {
	const entries = Object.values(state.entries)
	const pending = entries.filter((entry) => entry.pending)
	const waiting = pending.filter((entry) => inUploadWindow(entry, now)).length
	const acknowledged = entries.filter((entry) => entry.lastAcknowledgedAt).length
	const problems = [
		// The advice is long, so the retry time keeps a line of its own.
		...Object.values(state.paused ?? {}).map(
			(pause) =>
				`PR cost reporting paused for ${owner(pause.limit)}: ${reached(pause.limit)}. Ask an admin to free space or wait.\nNext try ${inAbout(pause.retryAt - now)}.`,
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
	const sections = [
		...(problems.length ? [["Delivery problems", ...problems.flatMap((problem) => wrap(problem, "- "))]] : []),
		[
			...row(
				"PR reporting",
				`${state.enabled ? "Enabled" : "Disabled"} (${state.followsTelemetry ? "SaaS default" : "explicit choice"})`,
			),
			...(skipReason ? row("This session", "No uploads; local attribution continues", `Reason: ${skipReason}`) : []),
			...row(
				"Repositories",
				`${formatCount(pending.length)} queued · ${formatCount(acknowledged)} acknowledged`,
				...(waiting ? [`${formatCount(waiting)} waiting for the 5-minute upload window`] : []),
			),
		],
		...(state.skippedRequests
			? [
					[
						"History coverage incomplete",
						...wrap(
							`${plural(state.skippedRequests, "request")} skipped without original account or repository evidence. Other requests are still reported.`,
							"  ",
						),
					],
				]
			: []),
	]
	return { text: sections.map((lines) => lines.join("\n")).join("\n\n"), warning: problems.length > 0 }
}
