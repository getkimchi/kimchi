# PII redaction policy

Which entity types the pii-redaction extension redacts, and how that set is
configured. Redaction itself is still gated by the `extensions.pii-redaction`
resource (see `docs/` references in AGENTS.md); this document covers **what**
redacts once the gate is on.

## Categories and entities

Every entity the redaction engine can emit (plus the kimchi-owned custom
marker types) belongs to exactly one of nine categories and carries an
effective default — whether it redacts today or not:

| Category | Members (abridged) | Default |
|---|---|---|
| `secrets` | vendor tokens (GitHub, AWS, LLM keys …), keyword-anchored secrets (`aws_secret_access_key = …`, `password: …`), `SECRET_FIELD` (JSON-key force-redaction) | on |
| `local_paths` | `LOCAL_PATH`, `CREDENTIAL_FILE` | on |
| `emails` | `EMAIL_ADDRESS` | on |
| `phones` | `PHONE_NUMBER` | off (bare shapes false-positive) |
| `network` | `IP_ADDRESS`, `MAC_ADDRESS` | on |
| `credentialed_urls` | `URL_WITH_CREDENTIALS` (+ members covered through it) | on |
| `financial` | `CREDIT_CARD`, `IBAN_CODE` on; routing numbers, `CRYPTO` off | mixed |
| `identity_documents` | national IDs, healthcare IDs (SSN, passports, Medicare …) | off |
| `personal_details` | `PERSON`, `LOCATION`, `ORGANIZATION`, `DATE_TIME`, `UK_POSTCODE` | off |

`GUID` has no category and is not configurable: structural identifiers
(ferment/session IDs) are never redacted. The full machine-readable catalog
(entity → tier → category → default) is emitted by
`bun scripts/redaction-catalog.ts`.

## Local configuration (settings.json)

```jsonc
{
  "redaction": {
    "categories": { "network": "off" },            // whole category on/off
    "entities": { "FLY_IO_TOKEN": "off",           // per-entity override
                  "PHONE_NUMBER": "on" },
    "customEntities": [                            // user-defined regex entity
      { "name": "ACME_EMPLOYEE_ID",
        "category": "identity_documents",
        "pattern": "(emp[-_ ]?id\\s*[:=]\\s*)(E\\d{6})",
        "flags": "i",
        "secretGroup": 2 }
    ]
  }
}
```

- Per-entity state beats its category state; the tier-registry defaults apply
  to everything unset. An **absent `redaction` block reproduces default
  behavior exactly** (the baseline is the default, not an empty policy).
- Entity `off` suspends everything under that name: engine detector, the
  keyword-anchored custom patterns, and `SECRET_FIELD` force-redaction.
- Entity `on` re-enables a bare-shape engine detector (accept the
  false-positive cost), but **never** enables an anchor-required bare shape
  (`AWS_SECRET_KEY`, `GENERIC_SECRET`, …): those stay matched only through
  their keyword-anchored patterns.
- Unknown categories/entities and invalid custom entries **throw** — the
  live pipeline degrades to the tier defaults with one loud log, and the
  strict export path fails closed, until settings.json is fixed.
- Local edits take effect mid-session (the engine rebuilds when the
  resolved view changes).

### Custom entities

Rules (violations throw locally, drop-in-managed — see below): name
`^[A-Z][A-Z0-9_]{2,63}$` and not a built-in entity name; category from the
list above; pattern ≤ 512 chars compiling as a JS RegExp; flags ⊆ `imsu`;
at most 50 entries. `secretGroup` ≥ 1 replaces only that capture group (the
rest of the match is anchoring context), mirroring the built-in anchored
patterns. Quantified groups containing alternation or a nested quantifier —
`(a|a)*`, `(a+)+`, `(\d{2,})*` — are rejected: these backtrack
exponentially, the scan cannot time them out (regex runs synchronously),
and one bad pattern would hang the process.

## Org-managed policy

The platform carries the same shape as a whole-message `kimchiRedaction`
field on the Settings message (org/team scope where the most specific wins).
States are proto enum names (`KIMCHI_REDACTION_STATE_ON|OFF`; `UNSPECIFIED`
means unset). Per entity, first hit wins:

```
managed.entities[E] → managed.categories[cat(E)] →
local.entities[E]    → local.categories[cat(E)]  → registry default
```

- Unknown categories/entities and invalid custom entries from the platform
  are **dropped** with one log line (a harness predates the vocabulary the
  platform ships; dropping is fail-open and cannot silently switch
  redaction off).
- The org policy is fetched at session startup, so managed changes apply to
  **new sessions**; local settings.json edits apply mid-session.
- Under an org FORCE_* resource lock on `extensions.pii-redaction`, the
  local settings file is not read at all; only the managed policy applies.

## Legacy `excludedEntities`

`{ "redaction": { "excludedEntities": ["DATE_TIME"] } }` keeps its
pre-policy meaning exactly: the array **replaces** the engine exclusion
list wholesale (it can re-enable bare detectors, which entity states
deliberately cannot) and disables the listed custom patterns. It cannot be
combined with `categories`/`entities`/`customEntities` — mixing throws.

## Telemetry

`pii_redaction.redacted` records carry a `category` attribute derived from
the pass's policy view (`emails`, `secrets`, …; `custom` when the marker
has no catalog attribution), so dashboards can group redactions by the same
unit admins toggle. See `docs/event-bus.md` §9.
