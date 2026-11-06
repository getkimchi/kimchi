import { createCodemodeExtension, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent"

export const CODEMODE_SELECTION_GUIDANCE =
	"Use codemode when later tool arguments can be computed from an earlier result and intermediate output can be filtered before it reaches the model. Use direct tools when the next step needs model judgment or when independent calls need their full results."

/** Pi's grep returns `path:line: text`; nested grep and read calls resolve to strings. */
export const CODEMODE_GREP_READ_EXAMPLE = `const hits = (await tools.grep({ pattern: "mySymbol", limit: 5 }))
  .split("\\n")
  .flatMap(line => {
    const match = line.match(/^(.+):(\\d+): /);
    return match ? [{ path: match[1], line: Number(match[2]) }] : [];
  });
const reads = await Promise.allSettled(
  hits.map(({ path, line }) => tools.read({ path, offset: Math.max(1, line - 4), limit: 9 }))
);
if (hits.length === 0) text("No parseable matches");
for (let i = 0; i < hits.length; i++) {
  const result = reads[i];
  text(hits[i].path + ":" + hits[i].line + "\\n" +
    (result.status === "fulfilled" ? result.value : "ERROR: " + result.reason));
}`

/** Decorate Pi's dynamic tool description without replacing its execution or loadout logic. */
export function createGuidedCodemodeExtension(): ExtensionFactory {
	const upstream = createCodemodeExtension()
	return (pi) => {
		const registerTool: ExtensionAPI["registerTool"] = (tool) => {
			if (tool.name !== "codemode") return pi.registerTool(tool)
			const prepareLoadout = tool.prepareLoadout
			pi.registerTool({
				...tool,
				prepareLoadout(loadout) {
					const changes = prepareLoadout?.(loadout)
					const description = changes?.descriptions?.codemode
					if (!description) return changes
					return {
						...changes,
						descriptions: {
							...changes.descriptions,
							codemode: `${CODEMODE_SELECTION_GUIDANCE}\n\nExample: grep for a symbol, then read a bounded range around each hit. Paste the script body without a code fence:\n${CODEMODE_GREP_READ_EXAMPLE}\n\n${description}`,
						},
					}
				},
			})
		}
		upstream(
			new Proxy(pi, {
				get(target, property, receiver) {
					return property === "registerTool" ? registerTool : Reflect.get(target, property, receiver)
				},
			}),
		)
	}
}
