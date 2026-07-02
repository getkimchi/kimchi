import { DIM, RST } from "./banner.js";

export function formatConfigSuccess(tool: string, postAction?: string): string {
  const base = `${DIM}configuration written.${RST}`;
  if (postAction) {
    return `${base} ${postAction}`;
  }
  return base;
}
