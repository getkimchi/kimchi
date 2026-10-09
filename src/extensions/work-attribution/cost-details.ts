import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isWorkId } from "../../shared/work-id.js"
import { decimalNanos, usd } from "./costs.js"
import { PRICED_TAG_LIMIT } from "./request-tags.js"
import { isWorkAccount, sameWorkAccount } from "./scope.js"
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

/** /work reads the last durable result; opening the command never waits for the network. */
export function workCostDetails(agentDir: string, workId: string): string[] {
	if (!isWorkId(workId)) return []
	const path = join(agentDir, "work", workId, "costs.json")
	try {
		return costDetailLines(JSON.parse(readFileSync(path, "utf8")), path)
	} catch {
		return ["Cost: unknown; waiting for billing"]
	}
}

/** `/work` cost lines for a saved `costs.json` value read from `path`. */
export function costDetailLines(value: unknown, path: string): string[] {
	if (!object(value) || !Array.isArray(value.pullRequests)) return ["Cost: unknown; waiting for billing"]
	const lines: string[] = []
	const requests = Array.isArray(value.requests) ? value.requests.filter(object) : []
	for (const row of value.pullRequests) {
		if (!object(row)) continue
		if (value.pullRequests.some((other) => object(other) && other !== row && other.key === row.key))
			lines.push(
				isWorkAccount(row.account)
					? `Account: ${row.account.organizationId} / ${row.account.userId} (${row.account.apiUrl})`
					: "Account: unknown",
			)
		const label = object(row.pullRequest) ? row.pullRequest.url : row.key
		// An unmerged PR's spend stays outside confirmed and inferred totals until it merges.
		const state = object(row.pullRequest) && row.pullRequest.state !== "merged" ? row.pullRequest.state : undefined
		if (state) {
			const counted = requests.filter(
				(request) =>
					request.allocation === "unmerged" &&
					Array.isArray(request.pullRequestIds) &&
					request.pullRequestIds.includes(row.key) &&
					(isWorkAccount(request.account) && isWorkAccount(row.account)
						? sameWorkAccount(request.account, row.account)
						: request.account === row.account),
			)

			const spent = usd(counted.reduce((sum, request) => sum + (decimalNanos(request.knownCostUsd) ?? 0n), 0n))
			// Unpriced, shared or unresolved requests may still belong to this PR.
			const complete =
				isWorkAccount(row.account) &&
				counted.every((request) => request.priceStatus === "priced") &&
				[row.sharedRequestIds, row.inferredRequestIds, row.unknownRequestIds].every(
					(ids) => !Array.isArray(ids) || !ids.length,
				)
			lines.push(
				complete
					? `Cost so far: $${spent} USD (${state}) — ${label}`
					: `Cost so far: unknown; $${spent} USD priced (${state}) — ${label}`,
			)
		} else if (typeof row.totalCostUsd === "string") lines.push(`Cost: $${row.totalCostUsd} USD — ${label}`)
		else lines.push(`Cost: unknown; $${row.knownCostUsd} USD priced so far — ${label}`)
		if (!state && object(row.explicit) && object(row.inferred))
			lines.push(
				`Confirmed: $${row.explicit.knownCostUsd} USD; inferred: $${row.inferred.knownCostUsd} USD${row.totalCostUsd === null ? " known so far" : ""}.`,
			)
	}
	if (Array.isArray(value.requests)) {
		// PR lines above include connected works; this one is the work's own spend, even without a PR.
		const own = typeof value.workId === "string" ? ownRequests(requests, value.workId) : requests
		const spend = knownSpend(own)
		const unresolved = own.filter((row) => row.allocation === "unknown").length
		const inferred = own.filter((row) => row.allocation === "inferred").length
		const shared = own.filter((row) => row.allocation === "shared").length
		lines.push(
			`Prices: ${spend.priced}/${spend.total} requests priced, $${usd(spend.nanos)} USD${spend.priced < spend.total ? " known so far" : ""}. PR assignments: ${unresolved} unresolved, ${inferred} inferred, ${shared} shared.`,
		)

		const untagged = new Map<string, number>()
		for (const row of own)
			if (typeof row.billingTagSkipped === "string")
				untagged.set(row.billingTagSkipped, (untagged.get(row.billingTagSkipped) ?? 0) + 1)
		if (untagged.size) {
			const count = [...untagged.values()].reduce((sum, value) => sum + value, 0)
			const reasons = [...untagged]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([reason, total]) => `${untagged.size > 1 ? `${total} ` : ""}${reason.replaceAll("-", " ")}`)
			lines.push(
				`${count} request${count === 1 ? "" : "s"} untagged: ${reasons.join(", ")}${untagged.has("tag-limit") ? ` (Kimchi adds model and phase tags; keep at most ${PRICED_TAG_LIMIT} in /tags)` : ""}.`,
			)
		}

		const failed = own.flatMap((row) =>
			object(row.billingLookup) && row.billingLookup.status === "unavailable" ? [row.billingLookup] : [],
		)
		if (failed.length) {
			const latest = failed.reduce((left, right) =>
				String(right.checkedAt ?? "") > String(left.checkedAt ?? "") ? right : left,
			)
			lines.push(
				`Last billing refresh failed for ${failed.length} request${failed.length === 1 ? "" : "s"}${typeof latest.reason === "string" ? `: ${latest.reason}` : ""}.`,
			)
		}
	}
	return [...lines, `Cost details: ${path}`]
}
