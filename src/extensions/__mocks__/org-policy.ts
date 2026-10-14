import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { initOrgPolicy } from "../../org-policy.js"

/**
 * Install a policy in the startup holder through the public API (mocked fetch,
 * throwaway cache file — never the real ~/.config one). The test file must
 * `vi.mock("../../api/org-settings.js", () => ({ fetchOrgPolicy: vi.fn() }))`
 * first; pair with `resetOrgPolicyForTests()` in afterEach.
 */
export async function seedOrgPolicy(modes: AllowedPermissionModes | undefined): Promise<void> {
	vi.mocked(fetchOrgPolicy).mockResolvedValue({
		kind: "policy",
		orgId: "org-policy-test",
		policy: { allowedPermissionModes: modes },
	})
	await initOrgPolicy("key", { cachePath: join(mkdtempSync(join(tmpdir(), "org-policy-test-")), "org-policy.json") })
}
