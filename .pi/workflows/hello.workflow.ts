/**
 * Tracer-bullet example: a single function step with a TypeBox output schema.
 *
 * Run it: `/workflow run hello` (or `/workflow run .pi/workflows/hello.workflow.ts`).
 *
 * `typebox` and `@pmateusz/pi-workflows` are supplied by the extension's loader as virtual
 * modules, so nothing has to be installed in this repo for the run to resolve them.
 */
import { Type } from "typebox";
import { createStep, createWorkflow } from "@pmateusz/pi-workflows";

export const helloOutputSchema = Type.Object({
  message: Type.String(),
});

const sayHello = createStep({
  name: "say-hello",
  output: helloOutputSchema,
  run: () => ({ message: "Hello, PI workflows!" }),
});

const helloWorkflow = createWorkflow({ name: "hello", description: "Say hello (Phase 1 tracer bullet)" }).then(sayHello).commit();

export default helloWorkflow;