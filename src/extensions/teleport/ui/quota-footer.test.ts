import { describe, expect, it } from "vitest"
import type { QuotaUsage } from "../../../sandbox/cloud/types.js"
import { quotaLines } from "./quota-footer.js"

const full: QuotaUsage = {
	userUsage: {
		currentSandboxes: 3,
		maxSandboxes: 10,
		currentCpuMillicores: 4500,
		maxCpuMillicores: 16000,
		currentRamBytes: 6442450944,
		maxRamBytes: 17179869184,
		currentPvcSizeBytes: 21474836480,
		maxPvcSizeBytes: 128849018880,
	},
	orgUsage: {
		currentSandboxes: 7,
		maxSandboxes: 10,
		currentCpuMillicores: 9000,
		maxCpuMillicores: 16000,
		currentRamBytes: 6442450944,
		maxRamBytes: 17179869184,
		currentPvcSizeBytes: 32212254720,
		maxPvcSizeBytes: 429496729600,
	},
}

describe("quotaLines", () => {
	it("formats each scope on its own line with all four dimensions", () => {
		const [user, org] = quotaLines(full)
		expect(user).toBe("you: 4500m/16000m CPU · 6Gi/16Gi RAM · 20Gi/120Gi PVC · 3/10 workspaces")
		expect(org).toBe("org: 9000m/16000m CPU · 6Gi/16Gi RAM · 30Gi/400Gi PVC · 7/10 workspaces")
	})

	it("drops segments whose fields are missing", () => {
		const [user] = quotaLines({ userUsage: { currentSandboxes: 1, maxSandboxes: 5 } })
		expect(user).toBe("you: 1/5 workspaces")
	})

	it("yields undefined for absent scopes", () => {
		const [user, org] = quotaLines({
			userUsage: { currentPvcSizeBytes: 5368709120, maxPvcSizeBytes: 107374182400 },
		})
		expect(user).toBe("you: 5Gi/100Gi PVC")
		expect(org).toBeUndefined()
	})

	it("yields a scope undefined when it carries no usable fields", () => {
		const [user, org] = quotaLines({ userUsage: full.userUsage, orgUsage: {} })
		expect(user).toContain("CPU")
		expect(org).toBeUndefined()
	})

	it("returns both lines undefined when quota is undefined", () => {
		const [user, org] = quotaLines(undefined)
		expect(user).toBeUndefined()
		expect(org).toBeUndefined()
	})
})
