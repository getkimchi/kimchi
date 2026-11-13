import type { RepositoryIdentity } from "@getkimchi/kimchi-bridge/work/kimchi/attribution"
import type { PullRequestCostReport } from "@getkimchi/kimchi-bridge/work/kimchi/costs"
import { buildEvents as build, type CommonEvents } from "@getkimchi/kimchi-bridge/work/kimchi/events"
import type { IngestEvent } from "@getkimchi/kimchi-bridge/work/protocol"
import { sameWorkAccount } from "../work-attribution/scope.js"
import type { StoredRecord } from "./ledger/records.js"

/**
 * Builds every fact the records support, with the bridge's event builder and this harness's rule for when two
 * accounts are the same. Shared work and PR facts always aggregate every request, but with `touched` only the named
 * requests and auxiliary records become units, so untouched requests skip their claim reads.
 */
export function buildEvents(
	stored: readonly StoredRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, RepositoryIdentity>,
	producerId: string,
	check: () => void,
	existingClaim: (account: string, entity: string) => IngestEvent | undefined,
	touched?: { requests: ReadonlySet<string>; records: ReadonlySet<string> },
): CommonEvents {
	return build({
		stored,
		report,
		repositories,
		producerId,
		sameAccount: sameWorkAccount,
		existingClaim,
		check,
		touched,
	})
}
