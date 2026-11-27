import * as bridgeLedger from "@getkimchi/kimchi-bridge/ledger"
import * as bridgeReconcile from "@getkimchi/kimchi-bridge/reconcile"
import { describe, expect, it } from "vitest"

describe("bridge package loads as TypeScript source", () => {
	it("exposes the ledger barrel", () => {
		expect(typeof bridgeLedger.capture).toBe("function")
		expect(typeof bridgeLedger.createMemoryRecords).toBe("function")
	})

	it("exposes the reconcile barrel", () => {
		expect(typeof bridgeReconcile.runReconciliationPass).toBe("function")
		expect(typeof bridgeReconcile.setDefaultHostPorts).toBe("function")
	})
})
