import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"
import { Type } from "typebox"

const s = createStep({
	name: "s",
	output: Type.Object({ n: Type.Number() }),
	run: () => {
		throw new Error("boom in step")
	},
})
export default createWorkflow({ name: "zz2" }).then(s).commit()
