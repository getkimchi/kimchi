import { closeBackends } from "../../src/extensions/pr-cost-reporting/ledger/records.ts"
import { reconcileWorkCosts } from "../../src/extensions/work-attribution/cost-sync.ts"

const agentDir = process.argv[2]
if (!agentDir) throw new Error("warm-billing requires the fixture agent directory")
const controller = new AbortController()
const deadline = setTimeout(() => controller.abort(new Error("warm-billing deadline exceeded")), 240_000)
deadline.unref()
try {
	// Called only after Kimchi has exited, so this driver shares neither its
	// database-write path nor its outbox with a concurrently running application.
	await reconcileWorkCosts(agentDir, controller.signal)
	console.log(JSON.stringify({ ok: true }))
} finally {
	clearTimeout(deadline)
	closeBackends()
}
