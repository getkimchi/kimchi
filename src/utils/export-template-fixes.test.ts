import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { ExportTemplateNode } from "../../scripts/export-template-fixes.js"
import {
	applyTemplateFixes,
	mapNodesIterative,
	markActiveIterative,
	sortChildrenIterative,
	TEMPLATE_FIX_ANCHORS,
} from "../../scripts/export-template-fixes.js"

// The installed upstream template that scripts/copy-resources.js stages and
// patches — the drift-tripwire target. If upstream refactors (or fixes) the
// recursive walkers, the conformance test below fails and forces a human
// decision about the transform.
const upstreamTemplatePath = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js", import.meta.url),
)

const DEEP_CHAIN = 50_000

// --- fixtures ---------------------------------------------------------------

function makeNode(id: string, timestamp: string): ExportTemplateNode {
	return { entry: { id, timestamp }, children: [] }
}

/** A linear parentId chain — the deep-branch shape long sessions produce. */
function buildChain(depth: number): { root: ExportTemplateNode; nodes: ExportTemplateNode[] } {
	const nodes: ExportTemplateNode[] = []
	for (let i = 0; i < depth; i++) {
		nodes.push(makeNode(`n${i}`, new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString()))
		if (i > 0) nodes[i - 1].children.push(nodes[i])
	}
	return { root: nodes[0], nodes }
}

// --- recursive reference implementations ------------------------------------
// The upstream code shape, reimplemented here to (a) prove the deep-chain
// fixture actually overflows a recursive walker and (b) provide ground truth
// on fixtures shallow enough for recursion.

function sortChildrenRecursive(node: ExportTemplateNode): void {
	node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime())
	node.children.forEach(sortChildrenRecursive)
}

function mapNodesRecursive(node: ExportTemplateNode, visit: (node: ExportTemplateNode) => void): void {
	visit(node)
	for (const child of node.children) {
		mapNodesRecursive(child, visit)
	}
}

function markActiveRecursive(
	node: ExportTemplateNode,
	isActive: (id: string) => boolean,
	store: Map<ExportTemplateNode, boolean>,
): boolean {
	let has = isActive(node.entry.id)
	for (const child of node.children) {
		if (markActiveRecursive(child, isActive, store)) has = true
	}
	store.set(node, has)
	return has
}

// --- applyTemplateFixes: upstream conformance (drift tripwire) ----------------

describe("applyTemplateFixes — upstream conformance (drift tripwire)", () => {
	it("applies exactly the three fixes to the installed upstream template with no warnings", () => {
		const result = applyTemplateFixes(readFileSync(upstreamTemplatePath, "utf-8"))
		expect(result.applied).toBe(TEMPLATE_FIX_ANCHORS.length)
		expect(result.warnings).toEqual([])
		// Every recursive anchor is gone and its iterative replacement is in,
		// verbatim — the materialized functions under test are the injected logic.
		for (const anchor of TEMPLATE_FIX_ANCHORS) {
			expect(result.js).not.toContain(anchor.from)
			expect(result.js).toContain(anchor.to)
		}
	})

	it("yields a syntactically valid script", () => {
		const result = applyTemplateFixes(readFileSync(upstreamTemplatePath, "utf-8"))
		// Compiling (not executing) the patched template catches any syntactic
		// damage the replacements could introduce.
		expect(() => new Function(result.js)).not.toThrow()
	})
})

// --- applyTemplateFixes: fail-soft contract ----------------------------------

describe("applyTemplateFixes — fail-soft contract", () => {
	it("is idempotent: a second pass over fixed output changes nothing", () => {
		const first = applyTemplateFixes(readFileSync(upstreamTemplatePath, "utf-8"))
		const second = applyTemplateFixes(first.js)
		expect(second.applied).toBe(0)
		expect(second.js).toBe(first.js)
		expect(second.warnings.length).toBe(TEMPLATE_FIX_ANCHORS.length)
	})

	it("returns applied 0 with warnings on input without anchors — never throws", () => {
		const untouched = "const unrelated = 1\n"
		const result = applyTemplateFixes(untouched)
		expect(result.applied).toBe(0)
		expect(result.warnings.length).toBeGreaterThan(0)
		expect(result.js).toBe(untouched)
	})
})

// --- behavioral: deep chain (the crash fixture shape) ------------------------

describe("iterative tree walkers — 50k-deep linear chain", () => {
	it("complete without RangeError while each recursive reference overflows", () => {
		// The references throwing on the same fixture proves it is deep enough
		// to reproduce the reported browser crash.
		expect(() => sortChildrenRecursive(buildChain(DEEP_CHAIN).root)).toThrow(RangeError)
		expect(() => mapNodesRecursive(buildChain(DEEP_CHAIN).root, () => {})).toThrow(RangeError)
		expect(() => markActiveRecursive(buildChain(DEEP_CHAIN).root, () => false, new Map())).toThrow(RangeError)

		// The iterative replacements hold node references on the heap.
		expect(() => sortChildrenIterative(buildChain(DEEP_CHAIN).root)).not.toThrow()

		// mapNodes: every node visited exactly once.
		const chain = buildChain(DEEP_CHAIN)
		const visits = new Map<ExportTemplateNode, number>()
		expect(() => mapNodesIterative(chain.root, (node) => visits.set(node, (visits.get(node) ?? 0) + 1))).not.toThrow()
		expect(visits.size).toBe(DEEP_CHAIN)
		for (const node of chain.nodes) {
			expect(visits.get(node)).toBe(1)
		}

		// markActive: post-order propagation marks every ancestor of the
		// active leaf (deepest node) active along the whole chain.
		const store = new Map<ExportTemplateNode, boolean>()
		const leafId = chain.nodes[DEEP_CHAIN - 1].entry.id
		expect(() => markActiveIterative(chain.root, (id) => id === leafId, store)).not.toThrow()
		for (const node of chain.nodes) {
			expect(store.get(node)).toBe(true)
		}
	})
})

// --- behavioral: sortChildren ordering ---------------------------------------

describe("sortChildrenIterative — ordering", () => {
	it("sorts every level by timestamp across multiple roots with out-of-order insertion", () => {
		const rootA = makeNode("a", "2024-01-01T00:00:00.000Z")
		const aMid = makeNode("a-mid", "2024-03-01T00:00:00.000Z")
		const aOld = makeNode("a-old", "2024-01-15T00:00:00.000Z")
		const aNew = makeNode("a-new", "2024-06-01T00:00:00.000Z")
		rootA.children.push(aMid, aOld, aNew)
		aMid.children.push(makeNode("a-mid-2", "2024-05-01T00:00:00.000Z"), makeNode("a-mid-1", "2024-02-01T00:00:00.000Z"))

		const rootB = makeNode("b", "2023-12-01T00:00:00.000Z")
		rootB.children.push(makeNode("b-2", "2024-04-01T00:00:00.000Z"), makeNode("b-1", "2024-02-15T00:00:00.000Z"))

		const rootC = makeNode("c", "2024-07-01T00:00:00.000Z") // leaf root

		for (const root of [rootA, rootB, rootC]) {
			sortChildrenIterative(root)
		}

		expect(rootA.children.map((c) => c.entry.id)).toEqual(["a-old", "a-mid", "a-new"])
		expect(aMid.children.map((c) => c.entry.id)).toEqual(["a-mid-1", "a-mid-2"])
		expect(rootB.children.map((c) => c.entry.id)).toEqual(["b-1", "b-2"])

		// Exhaustive: no parent anywhere has out-of-order timestamps.
		const violations: string[] = []
		for (const root of [rootA, rootB, rootC]) {
			mapNodesIterative(root, (node) => {
				for (let i = 1; i < node.children.length; i++) {
					const prev = new Date(node.children[i - 1].entry.timestamp).getTime()
					const curr = new Date(node.children[i].entry.timestamp).getTime()
					if (prev > curr) violations.push(node.entry.id)
				}
			})
		}
		expect(violations).toEqual([])
	})

	it("matches a recursive reference sort on a randomized branching fixture", () => {
		// Deterministic LCG so failures reproduce.
		let seed = 42
		const rand = (max: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648
			return seed % max
		}
		let counter = 0
		const build = (depth: number): ExportTemplateNode => {
			const node = makeNode(`id-${counter++}`, new Date(Date.UTC(2024, 0, 1) + rand(100) * 86_400_000).toISOString())
			if (depth > 0) {
				const childCount = 1 + rand(4)
				for (let i = 0; i < childCount; i++) {
					node.children.push(build(depth - 1))
				}
			}
			return node
		}
		const fixture = build(4)

		const iterativelySorted = structuredClone(fixture)
		sortChildrenIterative(iterativelySorted)
		const recursivelySorted = structuredClone(fixture)
		sortChildrenRecursive(recursivelySorted)

		const snapshot = (root: ExportTemplateNode): string[] => {
			const lines: string[] = []
			mapNodesIterative(root, (node) => {
				lines.push(`${node.entry.id}: [${node.children.map((c) => c.entry.id).join(", ")}]`)
			})
			return lines
		}
		expect(snapshot(iterativelySorted)).toEqual(snapshot(recursivelySorted))
	})
})

// --- behavioral: markActive post-order semantics -----------------------------

describe("markActiveIterative — post-order propagation", () => {
	it("stores a node active iff itself or any descendant is active (actives at varying depths)", () => {
		const ts = "2024-01-01T00:00:00.000Z"
		const r = makeNode("r", ts)
		const a = makeNode("a", ts)
		const b = makeNode("b", ts)
		const c = makeNode("c", ts)
		const d = makeNode("d", ts)
		const e = makeNode("e", ts)
		const f = makeNode("f", ts)
		const g = makeNode("g", ts)
		//        r
		//      / | \
		//     a  b  c*
		//    / \     \
		//   d   e     f
		//      /
		//     g*
		r.children.push(a, b, c)
		a.children.push(d, e)
		e.children.push(g)
		c.children.push(f)
		const activeIds = new Set([g.entry.id, c.entry.id]) // depth 3 and depth 1
		const isActive = (id: string) => activeIds.has(id)

		const expected = new Map<ExportTemplateNode, boolean>()
		markActiveRecursive(r, isActive, expected)
		const actual = new Map<ExportTemplateNode, boolean>()
		markActiveIterative(r, isActive, actual)

		expect(actual.size).toBe(expected.size)
		for (const [node, value] of expected) {
			expect(actual.get(node)).toBe(value)
		}
		// Ancestors of an active node light up; sibling branches stay off.
		expect(actual.get(r)).toBe(true)
		expect(actual.get(a)).toBe(true)
		expect(actual.get(e)).toBe(true)
		expect(actual.get(g)).toBe(true)
		expect(actual.get(c)).toBe(true)
		expect(actual.get(b)).toBe(false)
		expect(actual.get(d)).toBe(false)
		expect(actual.get(f)).toBe(false)
	})
})

// --- behavioral: mapNodes visit semantics ------------------------------------

describe("mapNodesIterative — visit semantics", () => {
	it("visits every node exactly once, in the same pre-order as the recursion", () => {
		const ts = "2024-01-01T00:00:00.000Z"
		const r = makeNode("r", ts)
		const a = makeNode("a", ts)
		const b = makeNode("b", ts)
		const c = makeNode("c", ts)
		const d = makeNode("d", ts)
		const e = makeNode("e", ts)
		r.children.push(a, b, c)
		a.children.push(d)
		c.children.push(e)

		const iterativeOrder: string[] = []
		const visits = new Map<ExportTemplateNode, number>()
		mapNodesIterative(r, (node) => {
			iterativeOrder.push(node.entry.id)
			visits.set(node, (visits.get(node) ?? 0) + 1)
		})
		const recursiveOrder: string[] = []
		mapNodesRecursive(r, (node) => recursiveOrder.push(node.entry.id))

		expect(visits.size).toBe(6)
		for (const node of [r, a, b, c, d, e]) {
			expect(visits.get(node)).toBe(1)
		}
		expect(iterativeOrder).toEqual(recursiveOrder)
	})
})
