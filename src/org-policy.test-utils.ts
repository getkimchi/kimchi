// Test-only seeding for the org-policy holder.
//
// Lives outside src/org-policy.ts so the production module carries no
// test-only mutators: this module is a leaf that only *.test.ts files import,
// so it never enters the production bundle and an import from production code
// would be visible in review. Seeding goes through the public initOrgPolicy
// cache-hit path — the same validation the real fetch pipeline uses — instead
// of mutating the holder directly.

import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { OrgPolicy } from "./api/org-settings.js"
import { initOrgPolicy } from "./org-policy.js"

const SEED_API_KEY = "org-policy-seed-key"

/** A fetch that can never succeed: the seeded background refresh fails open. */
const unreachableFetch = (async () => {
	throw new Error("org-policy test seed has no endpoint")
}) as unknown as typeof globalThis.fetch

/**
 * Seed the in-memory org-policy holder for a test.
 *
 * Writes a cache file matching the seed key's fingerprint and runs
 * initOrgPolicy with an unreachable fetch: the startup fetch fails and the
 * session falls back to the seeded cache — the same offline-fallback path a
 * real client takes. Passing `undefined` clears the holder (the empty-key
 * path). Await the call: the fallback is applied asynchronously.
 */
export async function setOrgPolicyForTests(policy: OrgPolicy | undefined): Promise<void> {
	if (policy === undefined) {
		await initOrgPolicy("", { fetch: unreachableFetch })
		return
	}
	const cachePath = join(mkdtempSync(join(tmpdir(), "org-policy-seed-")), "org-policy.json")
	const fingerprint = createHash("sha256").update(SEED_API_KEY).digest("hex")
	writeFileSync(
		cachePath,
		`${JSON.stringify({ keyFingerprint: fingerprint, orgId: "test-org", fetchedAt: 1, policy })}\n`,
	)
	await initOrgPolicy(SEED_API_KEY, { cachePath, fetch: unreachableFetch })
}
