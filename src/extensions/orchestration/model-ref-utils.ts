// Re-export stub. The implementation lives at model-catalog/ref-utils.ts;
// this shim exists only to satisfy stale imports from the in-progress
// `refactor/extract-model-catalog` work. Safe to delete once those imports
// are updated to point at the new location.
export { modelIdFromRef, splitModelRef } from "../model-catalog/ref-utils.js"
