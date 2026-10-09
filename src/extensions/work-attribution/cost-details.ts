import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isWorkId } from "../../shared/work-id.js"
import { decimalNanos, usd } from "./costs.js"
import { PRICED_TAG_LIMIT } from "./request-tags.js"
import { isWorkAccount, sameWorkAccount, type WorkAccount } from "./scope.js"
import { object } from "./summary.js"

// The cost lines /work shows, read from the work's saved costs.json.

/** A saved report also lists connected works' requests; a work's own are its requests and those linked into it. */
export function ownRequests(rows: readonly Record<string, unknown>[], workId: string): Record<string, unknown>[] {
	return rows.filter((row) =>
		[row.workIds, row.linkedWorkIds].some((ids) => Array.isArray(ids) && ids.includes(workId)),
	)
}

/** Priced requests and the known subtotal of saved request costs; unpriced requests add nothing. */
export function knownSpend(requests: Record<string, unknown>[]): { priced: number; total: number; nanos: bigint } {
	return {
		priced: requests.filter((row) => row.priceStatus === "priced").length,
		total: requests.length,
		nanos: requests.reduce((sum, row) => sum + (decimalNanos(row.knownCostUsd) ?? 0n), 0n),
	}
}

/** Request counts and the known subtotal, as `/work` prints them. */
interface SpendTotals {
	total: number
	priced: number
	knownCostUsd: string
}

/** What `/work` and its browser print for one work: a bounded digest of its `costs.json`, by PR. */
export interface WorkCostTotals {
	version: 1
	workId: string
	/** Connected works whose requests and PR totals `costs.json` covers; every member's file names the same ones. */
	group: string[]
	/** Every request `costs.json` covers, connected works' included. */
	groupRequests: SpendTotals
	/** Requests this work recorded or that a correction linked into it. */
	requests: SpendTotals & {
		/** Those recorded in this work. Newer requests in `work.json` are not priced yet. */
		recorded: number
		unresolved: number
		inferred: number
		shared: number
		/** Requests sent without a billing tag, by reason; such requests are never priced. */
		untagged?: Record<string, number>
		/** Requests whose last billing refresh failed before any page, with the newest reason. */
		failedRefresh?: { count: number; reason?: string }
	}
	pullRequests: {
		key: string
		account: WorkAccount | null
		/** This work has commits on the PR. */
		own: boolean
		pullRequest: { provider: string; number: number; state: string; url: string } | null
		totalCostUsd: string | null
		knownCostUsd: string
		/** Sure and likely parts of a merged or closed PR's spend. */
		sure?: string
		likely?: string
		/** An unmerged PR's spend so far, and whether every request it may include is priced. */
		soFar?: { knownCostUsd: string; complete: boolean }
	}[]
	/** The full report these totals come from. */
	report: "costs.json"
}

function spendTotals(rows: Record<string, unknown>[]): SpendTotals {
	const { priced, total, nanos } = knownSpend(rows)
	return { total, priced, knownCostUsd: usd(nanos) }
}

/** Totals for the work a saved report belongs to. Its requests may include connected works'; PR rows count them all. */
function untaggedTotals(rows: Record<string, unknown>[]): { untagged?: Record<string, number> } {
	const untagged: Record<string, number> = {}
	for (const row of rows)
		if (typeof row.billingTagSkipped === "string")
			untagged[row.billingTagSkipped] = (untagged[row.billingTagSkipped] ?? 0) + 1
	return Object.keys(untagged).length ? { untagged } : {}
}
function failedRefreshTotals(rows: Record<string, unknown>[]): { failedRefresh?: { count: number; reason?: string } } {
	const failed = rows.flatMap((row) =>
		object(row.billingLookup) && row.billingLookup.status === "unavailable" ? [row.billingLookup] : [],
	)
	if (!failed.length) return {}
	const latest = failed.reduce((left, right) =>
		String(right.checkedAt ?? "") > String(left.checkedAt ?? "") ? right : left,
	)
	return {
		failedRefresh: { count: failed.length, ...(typeof latest.reason === "string" ? { reason: latest.reason } : {}) },
	}
}
export function workCostTotals(report: unknown): WorkCostTotals | undefined {
	if (
		!object(report) ||
		typeof report.workId !== "string" ||
		!Array.isArray(report.pullRequests) ||
		!Array.isArray(report.requests)
	)
		return undefined
	const { workId } = report
	const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id) => typeof id === "string") : [])
	const requests = report.requests.filter(object)
	const pullRequests = report.pullRequests.filter(object)
	// Own spend: the work's requests and requests a correction linked into it, not other connected works'.
	const own = ownRequests(requests, workId)
	const assigned = (allocation: string) => own.filter((row) => row.allocation === allocation).length
	return {
		version: 1,
		workId,
		group: [
			...new Set([
				workId,
				...requests.flatMap((row) => [...ids(row.workIds), ...ids(row.linkedWorkIds)]),
				...pullRequests.flatMap((row) => ids(row.workIds)),
			]),
		].sort(),
		groupRequests: spendTotals(requests),
		requests: {
			...spendTotals(own),
			recorded: requests.filter((row) => ids(row.workIds).includes(workId)).length,
			unresolved: assigned("unknown"),
			inferred: assigned("inferred"),
			shared: assigned("shared"),
			...untaggedTotals(own),
			...failedRefreshTotals(own),
		},
		pullRequests: pullRequests.map((row) => {
			const pull = object(row.pullRequest) ? row.pullRequest : undefined
			// An unmerged PR's spend stays outside confirmed and inferred totals until it merges.
			const unmerged = pull && pull.state !== "merged"
			return {
				key: String(row.key),
				account: isWorkAccount(row.account) ? row.account : null,
				own: ids(row.workIds).includes(workId),
				pullRequest:
					pull &&
					(pull.provider === "github" || pull.provider === "gitlab") &&
					typeof pull.number === "number" &&
					typeof pull.state === "string" &&
					typeof pull.url === "string"
						? { provider: pull.provider, number: pull.number, state: pull.state, url: pull.url }
						: null,
				totalCostUsd: typeof row.totalCostUsd === "string" ? row.totalCostUsd : null,
				knownCostUsd: String(row.knownCostUsd),
				...(!unmerged && object(row.explicit) && object(row.inferred)
					? { sure: String(row.explicit.knownCostUsd), likely: String(row.inferred.knownCostUsd) }
					: {}),
				...(unmerged ? { soFar: spendSoFar(row, requests) } : {}),
			}
		}),
		report: "costs.json",
	}
}

/** An open or closed PR's priced spend over the requests counted for it so far. */
function spendSoFar(row: Record<string, unknown>, requests: Record<string, unknown>[]) {
	const counted = requests.filter(
		(request) =>
			request.allocation === "unmerged" &&
			Array.isArray(request.pullRequestIds) &&
			request.pullRequestIds.includes(row.key) &&
			(isWorkAccount(request.account) && isWorkAccount(row.account)
				? sameWorkAccount(request.account, row.account)
				: request.account === row.account),
	)
	return {
		knownCostUsd: usd(counted.reduce((sum, request) => sum + (decimalNanos(request.knownCostUsd) ?? 0n), 0n)),
		// Unpriced, shared or unresolved requests may still belong to this PR.
		complete:
			isWorkAccount(row.account) &&
			counted.every((request) => request.priceStatus === "priced") &&
			[row.sharedRequestIds, row.inferredRequestIds, row.unknownRequestIds].every(
				(ids) => !Array.isArray(ids) || !ids.length,
			),
	}
}

/** /work reads the last durable result; opening the command never waits for the network or reads the full report. */
export function workCostDetails(agentDir: string, workId: string): string[] {
	if (!isWorkId(workId)) return []
	const folder = join(agentDir, "work", workId)
	try {
		return costDetailLines(
			JSON.parse(readFileSync(join(folder, "cost-totals.json"), "utf8")),
			join(folder, "costs.json"),
		)
	} catch {
		return ["Cost: unknown; waiting for billing"]
	}
}

/** `/work` cost lines for saved `cost-totals.json` content; `path` names the full report. */
export function costDetailLines(value: unknown, path: string): string[] {
	if (!object(value) || !Array.isArray(value.pullRequests) || !object(value.requests))
		return ["Cost: unknown; waiting for billing"]
	const lines: string[] = []
	for (const row of value.pullRequests) {
		if (!object(row)) continue
		if (value.pullRequests.some((other) => object(other) && other !== row && other.key === row.key))
			lines.push(
				isWorkAccount(row.account)
					? `Account: ${row.account.organizationId} / ${row.account.userId} (${row.account.apiUrl})`
					: "Account: unknown",
			)
		const label = object(row.pullRequest) ? row.pullRequest.url : row.key
		const state = object(row.pullRequest) && row.pullRequest.state !== "merged" ? row.pullRequest.state : undefined
		if (state && object(row.soFar))
			lines.push(
				row.soFar.complete === true
					? `Cost so far: $${row.soFar.knownCostUsd} USD (${state}) — ${label}`
					: `Cost so far: unknown; $${row.soFar.knownCostUsd} USD priced (${state}) — ${label}`,
			)
		else if (typeof row.totalCostUsd === "string") lines.push(`Cost: $${row.totalCostUsd} USD — ${label}`)
		else lines.push(`Cost: unknown; $${row.knownCostUsd} USD priced so far — ${label}`)
		if (!state && typeof row.sure === "string" && typeof row.likely === "string")
			lines.push(
				`Confirmed: $${row.sure} USD; inferred: $${row.likely} USD${row.totalCostUsd === null ? " known so far" : ""}.`,
			)
	}
	// Work without a PR has no cost line above, so its own priced spend is shown here.
	const { priced, total, knownCostUsd, unresolved, inferred, shared } = value.requests
	if (typeof priced === "number" && typeof total === "number")
		lines.push(
			`Prices: ${priced}/${total} requests priced, $${knownCostUsd} USD${priced < total ? " known so far" : ""}. PR assignments: ${unresolved} unresolved, ${inferred} inferred, ${shared} shared.`,
		)
	// Untagged requests and failed refreshes of the work's own requests explain unknown prices.
	if (object(value.requests.untagged)) {
		const untagged = Object.entries(value.requests.untagged).filter(
			(entry): entry is [string, number] => typeof entry[1] === "number",
		)
		const count = untagged.reduce((sum, [, total]) => sum + total, 0)
		const reasons = untagged
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([reason, total]) => `${untagged.length > 1 ? `${total} ` : ""}${reason.replaceAll("-", " ")}`)
		if (count)
			lines.push(
				`${count} request${count === 1 ? "" : "s"} untagged: ${reasons.join(", ")}${untagged.some(([reason]) => reason === "tag-limit") ? ` (Kimchi adds model and phase tags; keep at most ${PRICED_TAG_LIMIT} in /tags)` : ""}.`,
			)
	}
	if (object(value.requests.failedRefresh) && typeof value.requests.failedRefresh.count === "number") {
		const { count, reason } = value.requests.failedRefresh
		lines.push(
			`Last billing refresh failed for ${count} request${count === 1 ? "" : "s"}${typeof reason === "string" ? `: ${reason}` : ""}.`,
		)
	}
	return [...lines, `Cost details: ${path}`]
}
