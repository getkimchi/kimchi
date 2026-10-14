/**
 * /session-costs: billed cost from the backend's cost breakdown. Unlike the catalog prices a session's own messages carry,
 * billing prices every request the session sent: compaction summaries, its subagents and Auto requests, which bill
 * at the price of the model the router chose.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import type { BreakdownDimension, BreakdownItem, BreakdownTotals, GenerateBreakdownResponse } from "./types.js"
import { formatCurrency } from "./visual.js"

export type CostView = "sessions" | "models" | "workspaces"

export const COST_VIEWS: Record<CostView, BreakdownDimension> = {
	sessions: "BREAKDOWN_DIMENSION_SESSION",
	models: "BREAKDOWN_DIMENSION_MODEL",
	workspaces: "BREAKDOWN_DIMENSION_WORKSPACE",
}

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_ROWS = 10
/** GenerateBreakdown rejects longer windows. */
const MAX_DAYS = 33

/** Parses `/session-costs [sessions|models|workspaces] [days]`; the sessions of the last 7 days by default. */
export function parseCostArgs(args: string): { view: CostView; days: number } {
	let view: CostView = "sessions"
	let days = 7
	for (const part of args.trim().toLowerCase().split(/\s+/)) {
		const parsed = Number.parseInt(part, 10)
		if (!Number.isNaN(parsed) && parsed > 0) days = Math.min(parsed, MAX_DAYS)
		else if (part in COST_VIEWS) view = part as CostView
	}
	return { view, days }
}

/** The start time a UUIDv7 session id carries in its first 48 bits; Kimchi session ids are UUIDv7. */
export function sessionStartedAt(sessionId: string): Date | undefined {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return undefined
	return new Date(Number.parseInt(sessionId.replace(/-/g, "").slice(0, 12), 16))
}

/**
 * The last `days` days, or from an hour before the given session started when that is earlier, so the session's whole
 * cost counts. It never exceeds the backend's limit. The returned `days` is the span it covers.
 */
export function costWindow(
	days: number,
	sessionId: string | undefined,
	now = new Date(),
): { startTime: Date; endTime: Date; days: number } {
	let start = now.getTime() - days * DAY_MS
	const started = sessionId ? sessionStartedAt(sessionId) : undefined
	if (started) start = Math.max(Math.min(start, started.getTime() - 60 * 60 * 1000), now.getTime() - MAX_DAYS * DAY_MS)
	return { startTime: new Date(start), endTime: now, days: Math.ceil((now.getTime() - start) / DAY_MS) }
}

/** A backend without these breakdowns rejects the dimension while parsing the request. */
export function costError(message: string): string {
	return message.includes("dimension") && message.includes("is not a valid value")
		? "This Kimchi server does not report session, model or workspace costs yet."
		: message
}

/** The CEL filter that keeps the user's own requests. */
export function ownerFilter(userId: string): string {
	return `castai_api_key_owner_id == ${JSON.stringify(userId)}`
}

function count(value: string | undefined): number {
	return Number(value ?? 0) || 0
}

function requests(value: string | undefined): string {
	const n = count(value)
	return `${n} ${n === 1 ? "request" : "requests"}`
}

function autoShare(cost: string | undefined, autoRequests: string | undefined, models: string[] = []): string {
	if (count(autoRequests) === 0) return ""
	const picked = models.length > 0 ? ` (${models.join(", ")})` : ""
	return `Auto${picked} ${formatCurrency(cost)} (${count(autoRequests)})`
}

function totalLine(totals: BreakdownTotals | undefined): string {
	const auto = autoShare(totals?.autoCostUsd, totals?.autoRequestCount)
	return `  Total ${formatCurrency(totals?.totalCostUsd)} · ${requests(totals?.requestCount)}${auto ? ` · ${auto}` : ""}`
}

function row(...columns: string[]): string {
	return `  ${columns.filter(Boolean).join("  ")}`
}

function sessionLabel(item: BreakdownItem): string {
	const id = item.dimensionValue ?? ""
	if (!id) return item.displayName || "No session"
	const started = sessionStartedAt(id)
	if (!started) return id.slice(0, 8)
	const month = started.toLocaleString("en-US", { month: "short" })
	const time = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`
	return `${month} ${started.getDate()} ${time} …${id.slice(-6)}`
}

function sessionHeadline(item: BreakdownItem | undefined, tracked: boolean, morePages: boolean): string {
	if (!tracked) return "not tracked while telemetry is off"
	// The response is the costliest page of sessions, so a cheap current session can be on a later one.
	if (!item)
		return morePages
			? "not among the sessions loaded; try a shorter window such as /session-costs 1"
			: "no billed requests yet"
	return [
		`${formatCurrency(item.totalCostUsd)} billed`,
		requests(item.requestCount),
		(item.topModels ?? []).join(", "),
		autoShare(item.autoCostUsd, item.autoRequestCount, item.autoModels),
	]
		.filter(Boolean)
		.join(" · ")
}

export function formatSessionCosts(
	response: GenerateBreakdownResponse,
	/** Undefined while telemetry is off: Kimchi then sends no session id, so billing cannot tell sessions apart. */
	currentSessionId: string | undefined,
	days: number,
	theme: Theme,
): string[] {
	const items = response.items ?? []
	const current = currentSessionId ? items.find((item) => item.dimensionValue === currentSessionId) : undefined
	const headline = sessionHeadline(current, currentSessionId !== undefined, Boolean(response.nextPageToken))
	const lines = [
		`${theme.bold("This session")}  ${headline}`,
		theme.fg("dim", "Adds up across compactions and subagents; billing can lag a few minutes."),
		"",
		theme.bold(`Your sessions, last ${days} days`),
	]
	for (const item of items.slice(0, SESSION_ROWS)) {
		const marker = item === current ? theme.fg("accent", "← this session") : ""
		lines.push(
			row(
				formatCurrency(item.totalCostUsd).padStart(8),
				requests(item.requestCount).padStart(13),
				sessionLabel(item),
				(item.topModels ?? []).join(", "),
				autoShare(item.autoCostUsd, item.autoRequestCount, item.autoModels),
				marker,
			),
		)
	}
	if (items.length > SESSION_ROWS) {
		const more = `${response.nextPageToken ? "at least " : ""}${items.length - SESSION_ROWS} more`
		lines.push(theme.fg("dim", `  … ${more}`))
	}
	lines.push(totalLine(response.totals))
	return lines
}

export function formatModelCosts(response: GenerateBreakdownResponse, days: number, theme: Theme): string[] {
	const lines = [theme.bold(`Your cost by model, last ${days} days`)]
	for (const item of response.items ?? []) {
		lines.push(
			row(
				formatCurrency(item.totalCostUsd).padStart(8),
				item.dimensionValue || "unknown",
				requests(item.requestCount),
				autoShare(item.autoCostUsd, item.autoRequestCount),
			),
		)
	}
	lines.push(totalLine(response.totals))
	lines.push(theme.fg("dim", "Auto requests count under the model the router chose."))
	return lines
}

export function formatWorkspaceCosts(response: GenerateBreakdownResponse, days: number, theme: Theme): string[] {
	const lines = [theme.bold(`Your cost by workspace, last ${days} days`)]
	for (const item of response.items ?? []) {
		lines.push(row(formatCurrency(item.totalCostUsd).padStart(8), item.displayName ?? "", requests(item.requestCount)))
	}
	lines.push(totalLine(response.totals))
	return lines
}
