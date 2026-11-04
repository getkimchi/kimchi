// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { WorkerClient } from "./client.js"
import type { SandboxStatus } from "./types.js"

export async function getStatus(client: WorkerClient, signal?: AbortSignal): Promise<SandboxStatus> {
	return client.get<SandboxStatus>("/api/status", signal)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
