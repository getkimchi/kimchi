import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The account the fake server verifies for the fixture key "fake". */
export const BILLING_ACCOUNT = {
	organizationId: "30000000-0000-4000-8000-000000000003",
	userId: "40000000-0000-4000-8000-000000000004",
}

const DAY_MS = 24 * 60 * 60_000

export interface PendingWorkCost {
	agentDir: string
	fakeBaseUrl: string
	sessionId: string
	workId: string
	cwd: string
	/** Canonical Git directory and worktree, as Kimchi records them. */
	repository: string
	worktree: string
	headSha: string
	/** The open PR or MR link exactly as PR discovery saves it. */
	pullRequest: Record<string, unknown>
}

/**
 * Journal rows for a work whose commit belongs to an open PR, plus one request that Kimchi sent
 * through the fake gateway with its billing tag. Its first lookup has just found no bill, so the
 * next one is due in 30 seconds: the first background pass after launch keeps it pending.
 */
export function seedPendingWorkCost(seed: PendingWorkCost): { requestId: string } {
	const requestId = randomUUID()
	const now = Date.now()
	const dispatchedAt = new Date(now - 60_000).toISOString()
	const checkedAt = new Date(now).toISOString()
	const identity = { version: 1, sessionId: seed.sessionId, workId: seed.workId, cwd: seed.cwd, recordedAt: checkedAt }
	const billingSource = {
		apiUrl: seed.fakeBaseUrl,
		gatewayUrl: `${seed.fakeBaseUrl}/openai/v1/chat/completions`,
		credentialHash: createHash("sha256").update("fake").digest("hex"),
	}
	// The fixed lookup window saved at dispatch: 12 hours before it to 32 days after.
	const billingSelector = {
		type: "tag",
		tag: `kimchi-request:${requestId}`,
		startTime: new Date(Date.parse(dispatchedAt) - DAY_MS / 2).toISOString(),
		endTime: new Date(Date.parse(dispatchedAt) + 32 * DAY_MS).toISOString(),
	}
	const rows = [
		{ ...identity, type: "work" },
		{
			...identity,
			type: "commit",
			sha: seed.headSha,
			repository: seed.repository,
			worktree: seed.worktree,
			pullRequests: [seed.pullRequest],
			prLookup: { status: "linked", checkedAt },
		},
		{
			...identity,
			type: "request",
			requestId,
			startedAt: dispatchedAt,
			scope: { repository: seed.repository, account: { apiUrl: seed.fakeBaseUrl, ...BILLING_ACCOUNT } },
			segment: { id: randomUUID(), attribution: "session", reason: "new-task" },
		},
		{
			...identity,
			type: "request_dispatch",
			requestId,
			startedAt: dispatchedAt,
			dispatchedAt,
			billingSource,
			billingSelector,
		},
		{
			...identity,
			type: "request_cost",
			requestId,
			billingSource,
			billingSelector,
			billingRows: [],
			billingLookup: { status: "pending", checkedAt, ...BILLING_ACCOUNT },
		},
	]
	const ledgers = join(seed.agentDir, "work-attribution")
	mkdirSync(ledgers, { recursive: true })
	writeFileSync(
		join(ledgers, `${encodeURIComponent(seed.sessionId)}.jsonl`),
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	)
	return { requestId }
}
