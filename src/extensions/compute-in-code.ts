/**
 * System prompt block that instructs the model to use code for computation
 * rather than working through it in thinking blocks.
 *
 * Observed in terminal-bench-2 benchmark runs: the model spent up to 124s
 * generating 42K chars of thinking to simulate an arithmetic encoder —
 * arithmetic that would take <1s in a Python script. This instruction
 * teaches the model to delegate computation to bash, keeping thinking
 * for deciding *what* to do, not for *doing* it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "./prompt-construction/index.js"

const COMPUTE_IN_CODE_PROMPT = `## Computation belongs in code, not in thinking

When you need to compute something — arithmetic, encoding logic, format analysis, bit
manipulation, state simulation, numerical verification — write a script and run it.
Do not work through multi-step computation in your thinking. Your thinking is for
deciding *what* to do, not for *doing* it. A 3-line Python script is faster and more
reliable than 5,000 words of mental arithmetic.`

export default function computeInCodeExtension(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "compute-in-code").register({
		id: "compute-in-code",
		render: () => COMPUTE_IN_CODE_PROMPT,
	})
}
