import { wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { readOutboxStatus } from "./ledger/outbox.js"
import type { ReportingState } from "./queue.js"

const formatCount = (count: number) => count.toLocaleString("en-US")
const plural = (count: number, noun: string) => `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`

function inAbout(ms: number): string {
	if (ms <= 0) return "at the next upload"
	const minutes = Math.max(1, Math.round(ms / 60_000))
	return `in about ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`
}

/** Lines fit a 60-column TUI, which pads notifications by one column on each side. */
const WIDTH = 58
/** "Last event ACK" and a one-space gutter. */
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
 * The `/pr-reporting status` text. `skipReason` describes this session, not the saved choice. Delivery problems
 * come first and make it a warning.
 */
export function statusText(
	state: ReportingState,
	skipReason: string | undefined,
	now = Date.now(),
	outbox: ReturnType<typeof readOutboxStatus> = [],
): { text: string; warning: boolean } {
	const events = outbox.reduce(
		(total, status) => ({
			pending: total.pending + status.pending,
			blocked: total.blocked + status.blocked,
			acknowledged: total.acknowledged + status.acknowledged,
			batches: total.batches + status.batches,
			lastAcknowledgedAt: Math.max(total.lastAcknowledgedAt, status.lastAcknowledgedAt ?? 0),
		}),
		{ pending: 0, blocked: 0, acknowledged: 0, batches: 0, lastAcknowledgedAt: 0 },
	)
	const retryAt = Math.min(
		...outbox.flatMap((status) => (status.retry && status.retry.retryAt > now ? [status.retry.retryAt] : [])),
	)
	const problems = [
		...new Set(
			[
				state.error,
				...outbox.flatMap((status) =>
					status.retry ? [status.retry.error ?? "A previous PR cost event upload failed"] : [],
				),
			].filter((value): value is string => value !== undefined),
		),
		...(events.blocked ? [`${plural(events.blocked, "event")} blocked; retained locally.`] : []),
	]
	const sections = [
		...(problems.length ? [["Delivery problems", ...problems.flatMap((problem) => wrap(problem, "- "))]] : []),
		[
			...row(
				"PR reporting",
				`${state.enabled ? "Enabled" : "Disabled"} (${state.followsTelemetry ? "SaaS default" : "explicit choice"})`,
			),
			...(skipReason ? row("This session", "No uploads; local attribution continues", `Reason: ${skipReason}`) : []),
			...(outbox.length
				? row(
						"Events",
						`${formatCount(events.pending)} queued · ${formatCount(events.acknowledged)} acknowledged`,
						...(events.batches ? [`${plural(events.batches, "frozen batch")} awaiting acknowledgement`] : []),
					)
				: []),
			...(Number.isFinite(retryAt) ? row("Event retry", inAbout(retryAt - now)) : []),
			...(events.lastAcknowledgedAt ? row("Last event ACK", new Date(events.lastAcknowledgedAt).toISOString()) : []),
		],
	]
	return { text: sections.map((lines) => lines.join("\n")).join("\n\n"), warning: problems.length > 0 }
}
