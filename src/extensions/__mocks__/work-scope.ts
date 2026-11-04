// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { WorkScopeSnapshot } from "../work-attribution/scope.js"

export function createWorkScopeSnapshot(repository = "/project/.git"): WorkScopeSnapshot {
	return {
		scope: {
			repository,
			account: {
				apiUrl: "https://account.example/api",
				organizationId: "30000000-0000-4000-8000-000000000003",
				userId: "40000000-0000-4000-8000-000000000004",
			},
		},
		isCurrent: () => true,
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
