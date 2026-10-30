// Iterative replacements for the three recursive tree walkers in the staged
// export template (upstream pi-mono template.js, staged into
// src/core/export-html/ and dist/share/kimchi/export-html/ by
// scripts/copy-resources.js).
//
// Long sessions form very deep parentId chains (the session that motivated
// this fix has a ~1.6k-level deepest branch over ~14k entries), and the
// recursive walkers overflow the browser call stack — the renderer dies with
// "RangeError: Maximum call stack size exceeded" at roots.forEach(sortChildren)
// before painting the tree, so the export shows only the trace-id divs kimchi
// injects (those renderers are already iterative).
//
// This module is the single source of truth for the fix: applyTemplateFixes
// injects the implementation strings below into the staged template, and the
// new Function materializations at the bottom export the very same strings as
// callable functions, so unit tests exercise the exact injected logic.
//
// Fail-soft by design: a missing anchor (upstream refactor or fix) warns and
// skips so a pi-mono upgrade never breaks the build; the vitest conformance
// test against the installed upstream template is the drift tripwire that
// forces a human decision. Drop this transform once upstream ships iterative
// walkers.

// buildTree() → sortChildren — the confirmed crash site. Recursive descent
// once per tree level; the longest sessions overflow the stack here.
const SORT_CHILDREN_ANCHOR = `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }
        roots.forEach(sortChildren);`

// Iterative sortChildren: an explicit stack replaces the recursion; node
// references live on the heap, so depth is bounded by memory, not the call
// stack. Children are pushed in reverse so nodes are processed in the same
// order the recursion visited them.
const SORT_CHILDREN_SOURCE = `        function sortChildren(root) {
          const stack = [root];
          while (stack.length > 0) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
          }
        }`

// findNewestLeaf() → mapNodes — builds treeNodeMap by recursing once per tree
// level while visiting every node.
const MAP_NODES_ANCHOR = `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`

// Iterative mapNodes: generic visitor (the testable export passes its own
// visit callback); the injected call site adapts the original
// treeNodeMap.set(entry.id, node) side effect. Every node is visited exactly
// once, in the same pre-order as the recursion.
const MAP_NODES_SOURCE = `          function mapNodes(root, visit) {
            const stack = [root];
            while (stack.length > 0) {
              const node = stack.pop();
              visit(node);
              for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
            }
          }`

// flattenTree() → markActive — recursive post-order that computes, for every
// node, whether its subtree contains the active leaf.
const MARK_ACTIVE_ANCHOR = `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }
        roots.forEach(markActive);`

// Iterative markActive: two-phase explicit stack. [node, false] entries
// descend; on pop they push [node, true] behind the children, so when
// [node, true] surfaces every descendant has already been stored and the
// parent can aggregate. Same post-order semantics as the recursion.
const MARK_ACTIVE_SOURCE = `        function markActive(root, isActive, store) {
          const stack = [[root, false]];
          while (stack.length > 0) {
            const [node, ready] = stack.pop();
            if (ready) {
              let has = isActive(node.entry.id);
              for (const child of node.children) {
                if (store.get(child)) has = true;
              }
              store.set(node, has);
            } else {
              stack.push([node, true]);
              for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], false]);
            }
          }
        }`

export const TEMPLATE_FIX_ANCHORS = [
	{
		id: "sortChildren",
		from: SORT_CHILDREN_ANCHOR,
		to: `${SORT_CHILDREN_SOURCE}
        roots.forEach(sortChildren);`,
	},
	{
		id: "mapNodes",
		from: MAP_NODES_ANCHOR,
		to: `${MAP_NODES_SOURCE}
          tree.forEach((root) => mapNodes(root, (node) => treeNodeMap.set(node.entry.id, node)));`,
	},
	{
		id: "markActive",
		from: MARK_ACTIVE_ANCHOR,
		to: `${MARK_ACTIVE_SOURCE}
        roots.forEach((root) => markActive(root, (id) => activePathIds.has(id), containsActive));`,
	},
]

/**
 * Replace the three recursive tree walkers in an export template.js with the
 * iterative implementations above. Fail-soft: a missing or duplicated anchor
 * produces a warning and is skipped — never throws, so an upstream pi-mono
 * upgrade cannot break the build (worst case is the pre-fix recursive
 * behavior).
 *
 * @param {string} templateJs contents of the upstream/staged template.js
 * @returns {{ js: string; applied: number; warnings: string[] }} the patched
 *   source, how many anchors were replaced, and per-anchor skip reasons
 */
export function applyTemplateFixes(templateJs) {
	let js = templateJs
	let applied = 0
	const warnings = []
	for (const fix of TEMPLATE_FIX_ANCHORS) {
		const occurrences = js.split(fix.from).length - 1
		if (occurrences === 0) {
			warnings.push(`anchor "${fix.id}" not found — upstream template.js changed; recursive walker left in place`)
			continue
		}
		if (occurrences > 1) {
			warnings.push(`anchor "${fix.id}" found ${occurrences} times, expected one — recursive walker left in place`)
			continue
		}
		// Replacer function (not a string): the replacement text is inserted
		// verbatim and cannot be mangled by $-substitution patterns.
		js = js.replace(fix.from, () => fix.to)
		applied += 1
	}
	return { js, applied, warnings }
}

// Materialize the injected implementations as callable functions. These are
// the exact strings applyTemplateFixes injects into the staged template, so
// tests exercising these functions exercise the shipped rendering logic.
export const sortChildrenIterative = new Function(`${SORT_CHILDREN_SOURCE}
return sortChildren;`)()

export const mapNodesIterative = new Function(`${MAP_NODES_SOURCE}
return mapNodes;`)()

export const markActiveIterative = new Function(`${MARK_ACTIVE_SOURCE}
return markActive;`)()
