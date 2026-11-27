// Pure legacy-Ferment identifier constants with no runtime imports. Kept in a
// leaf module so `resources/definitions.ts` can reference the id without pulling
// in `resources/store.ts`, which would otherwise form a circular import
// (definitions -> resource -> store -> definitions) that leaves these constants
// undefined when the static resource map is built under some entry orders.

/** The /resources id for legacy Ferment (V1). Opt-in; the primary Ferment id belongs to V2. */
export const FERMENT_LEGACY_RESOURCE_ID = "extensions.ferment-legacy"

/** V1 slash command. `/ferment` belongs to V2, so V1 lives under this name. */
export const FERMENT_LEGACY_COMMAND_NAME = "ferment-legacy"
