import type { TipProvider } from "../tips/types.js"
import { getBillingWarnings } from "./status.js"

export const BILLING_TIP_SOURCE = "kimchi.billing"
const BILLING_TIP_PRIORITY = 10_000

export function createBillingTipProvider(): TipProvider {
	return {
		source: BILLING_TIP_SOURCE,
		getTips: () => {
			return getBillingWarnings().map((warning, index) => ({
				id: `billing-${warning.kind}-${index}`,
				scope: "contextual",
				message: warning.message,
				priority: BILLING_TIP_PRIORITY,
				tone: warning.kind === "exhausted" ? "error" : "warning",
				showPrefix: false,
			}))
		},
	}
}
