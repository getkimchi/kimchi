import type { Fact } from "@getkimchi/kimchi-bridge/ledger"
import type { WorkAccount } from "../work-attribution/scope.js"

export interface CommonEvents {
	accounts: { account: WorkAccount; facts: Fact[]; recordHashes: string[] }[]
	/**
	 * What each request or auxiliary record contributes, in a stable order: its facts by entity, including the work,
	 * PR and link facts it shares, and the records it translates.
	 */
	units: EventUnit[]
	unresolved: { requestId: string; reason: string; recordHashes: string[] }[]
}
export interface EventUnit {
	account: string
	requestId?: string
	entities: string[]
	recordHashes: string[]
}
