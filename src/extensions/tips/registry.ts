// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { Tip, TipCandidate, TipProvider, TipScope } from "./types.js"

interface ProviderRecord {
	owner: symbol
	provider: TipProvider
}

export class TipRegistry {
	private readonly providers = new Map<string, ProviderRecord>()

	registerProvider(provider: TipProvider): () => void {
		if (provider.source.trim().length === 0) {
			throw new Error("Tip provider source must be non-empty")
		}
		const owner = Symbol(provider.source)
		this.providers.set(provider.source, { owner, provider })

		return () => {
			const current = this.providers.get(provider.source)
			if (current?.owner === owner) this.providers.delete(provider.source)
		}
	}

	getProviders(): readonly TipProvider[] {
		return Array.from(this.providers.values(), (record) => record.provider)
	}

	getEligibleTips(scope?: TipScope): TipCandidate[] {
		const candidates: TipCandidate[] = []

		for (const provider of this.getProviders()) {
			let tips: readonly Tip[]
			try {
				tips = provider.getTips()
			} catch {
				continue
			}

			for (const tip of tips) {
				if (scope !== undefined && tip.scope !== scope) continue
				candidates.push({
					source: provider.source,
					id: tip.id,
					scope: tip.scope,
					message: tip.message,
					priority: tip.priority,
					tone: tip.tone,
					showPrefix: tip.showPrefix,
				})
			}
		}

		return candidates
	}

	getFirstTip(scope: TipScope = "general"): TipCandidate | undefined {
		return this.getEligibleTips(scope)[0]
	}

	clear(): void {
		this.providers.clear()
	}
}

export const globalTipRegistry = new TipRegistry()

export function registerTipProvider(provider: TipProvider): () => void {
	return globalTipRegistry.registerProvider(provider)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
