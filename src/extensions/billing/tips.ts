import type { TipProvider } from "../tips/types.js"
import { getBillingWarning } from "./status.js"

export const BILLING_TIP_SOURCE = "kimchi.billing"
const BILLING_TIP_PRIORITY = 10_000

export function createBillingTipProvider(): TipProvider {
	return {
		source: BILLING_TIP_SOURCE,
		getTips: () => {
			const warning = getBillingWarning()
			if (!warning) return []
			return [
				{
					id: `billing-${warning.kind}`,
					scope: "contextual",
					message: warning.message,
					priority: BILLING_TIP_PRIORITY,
					tone: warning.kind === "exhausted" ? "error" : "warning",
					showPrefix: false,
				},
			]
		},
	}
}
