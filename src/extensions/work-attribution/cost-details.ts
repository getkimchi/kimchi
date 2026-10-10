import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isWorkId } from "../../shared/work-id.js"
import type { BillingDisplay } from "./billing-evidence.js"
import { decimalNanos, type PullRequestCost, type RequestCostAllocation, usd } from "./costs.js"
import { PRICED_TAG_LIMIT } from "./request-tags.js"
import { isWorkAccount, sameWorkAccount, type WorkAccount } from "./scope.js"
import { object } from "./summary.js"

// The cost lines /work shows, read from the work's saved cost-totals.json.

/** A request of a saved report, with the billing state `costs.json` shows for it. */
export type SavedRequestCost = RequestCostAllocation & {
	/** Why the request was sent without a billing tag; such a request is never priced. */
	billingTagSkipped?: string
	billingLookup?: BillingDisplay["billingLookup"]
}

/** The parts of a work's `costs.json` its totals come from; PRs and requests include connected works'. */
export interface WorkCostReport {
	workId: string
	pullRequests: PullRequestCost[]
	requests: SavedRequestCost[]
}

/** A saved report also lists connected works' requests; a work's own are its requests and those linked into it. */
function ownRequests(rows: SavedRequestCost[], workId: string): SavedRequestCost[] {
	return rows.filter((row) => row.workIds.includes(workId) || row.linkedWorkIds?.includes(workId))
}

/** Priced requests and the known subtotal of saved request costs; unpriced requests add nothing. */
export function knownSpend(requests: SavedRequestCost[]): { priced: number; total: number; nanos: bigint } {
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
		/** Requests whose last billing refresh failed, with the newest reason. */
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
		/** Confirmed (`explicit`) and inferred known subtotals of a merged PR's spend. */
		explicit?: string
		inferred?: string
		/** An unmerged PR's spend so far, and whether every request it may include is priced. */
		soFar?: { knownCostUsd: string; complete: boolean }
	}[]
	/** The full report these totals come from. */
	report: "costs.json"
}

function spendTotals(rows: SavedRequestCost[]): SpendTotals {
	const { priced, total, nanos } = knownSpend(rows)
	return { total, priced, knownCostUsd: usd(nanos) }
}

/** Requests sent without a billing tag, by reason. */
function untaggedTotals(rows: SavedRequestCost[]): { untagged?: Record<string, number> } {
	const untagged: Record<string, number> = {}
	for (const { billingTagSkipped: reason } of rows)
		if (reason !== undefined) untagged[reason] = (untagged[reason] ?? 0) + 1
	return Object.keys(untagged).length ? { untagged } : {}
}

/** Requests whose last billing refresh failed, with the newest reason. */
function failedRefreshTotals(rows: SavedRequestCost[]): { failedRefresh?: { count: number; reason?: string } } {
	const failed = rows.flatMap(({ billingLookup }) => (billingLookup?.status === "unavailable" ? [billingLookup] : []))
	if (!failed.length) return {}
	const latest = failed.reduce((left, right) => ((right.checkedAt ?? "") > (left.checkedAt ?? "") ? right : left))
	return {
		failedRefresh: { count: failed.length, ...(latest.reason === undefined ? {} : { reason: latest.reason }) },
	}
}

/** Totals for the work a saved report belongs to. Its requests may include connected works'; PR rows count them all. */
export function workCostTotals({ workId, pullRequests, requests }: WorkCostReport): WorkCostTotals {
	// Own spend: the work's requests and requests a correction linked into it, not other connected works'.
	const own = ownRequests(requests, workId)
	const assigned = (allocation: RequestCostAllocation["allocation"]) =>
		own.filter((row) => row.allocation === allocation).length
	return {
		version: 1,
		workId,
		group: [
			...new Set([
				workId,
				...requests.flatMap((row) => [...row.workIds, ...(row.linkedWorkIds ?? [])]),
				...pullRequests.flatMap((row) => row.workIds),
			]),
		].sort(),
		groupRequests: spendTotals(requests),
		requests: {
			...spendTotals(own),
			recorded: requests.filter((row) => row.workIds.includes(workId)).length,
			unresolved: assigned("unknown"),
			inferred: assigned("inferred"),
			shared: assigned("shared"),
			...untaggedTotals(own),
			...failedRefreshTotals(own),
		},
		pullRequests: pullRequests.map((row) => {
			const pull = row.pullRequest
			return {
				key: row.key,
				account: row.account,
				own: row.workIds.includes(workId),
				// A PR link without a provider is GitHub's, as cost reports read stored links.
				pullRequest: pull && {
					provider: pull.provider ?? "github",
					number: pull.number,
					state: pull.state,
					url: pull.url,
				},
				totalCostUsd: row.totalCostUsd,
				knownCostUsd: row.knownCostUsd,
				// An unmerged PR's spend stays outside confirmed and inferred totals until it merges.
				...(pull && pull.state !== "merged"
					? { soFar: spendSoFar(row, requests) }
					: { explicit: row.explicit.knownCostUsd, inferred: row.inferred.knownCostUsd }),
			}
		}),
		report: "costs.json",
	}
}

/** An open or closed PR's priced spend over the requests counted for it so far. */
function spendSoFar(row: PullRequestCost, requests: SavedRequestCost[]) {
	const counted = requests.filter(
		(request) =>
			request.allocation === "unmerged" &&
			request.pullRequestIds.includes(row.key) &&
			(request.account && row.account
				? sameWorkAccount(request.account, row.account)
				: request.account === row.account),
	)
	return {
		knownCostUsd: usd(counted.reduce((sum, request) => sum + (decimalNanos(request.knownCostUsd) ?? 0n), 0n)),
		// Unpriced, shared or unresolved requests may still belong to this PR.
		complete:
			row.account !== null &&
			counted.every((request) => request.priceStatus === "priced") &&
			[row.sharedRequestIds, row.inferredRequestIds, row.unknownRequestIds].every((ids) => !ids.length),
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
		if (!state && typeof row.explicit === "string" && typeof row.inferred === "string")
			lines.push(
				`Confirmed: $${row.explicit} USD; inferred: $${row.inferred} USD${row.totalCostUsd === null ? " known so far" : ""}.`,
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
