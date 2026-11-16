# PII redaction policy

Which entity types the pii-redaction extension redacts, and how that set is
configured. Redaction itself is still gated by the `extensions.pii-redaction`
resource (see `docs/` references in AGENTS.md); this document covers **what**
redacts once the gate is on.

## Categories and entities

Every registered entity (engine detectors plus the kimchi-owned custom
marker types) belongs to exactly one of five categories and carries an
effective default — whether it redacts today or not:

| Category | Members (abridged) | Default |
|---|---|---|
| `credentials` | 152 entities: vendor tokens, keyword-anchored secrets (`aws_secret_access_key = …`, `password: …`), `SECRET_FIELD` (JSON-key force-redaction), `CREDENTIAL_FILE`, credentialed URLs and connection strings (`URL_WITH_CREDENTIALS`, `AZURE_CONNECTION_STRING`, webhooks …) | on (every member) |
| `identity_documents` | 38 national-ID and healthcare-ID entities (SSN, passports, Medicare …) | off (every member) |
| `person_data` | `EMAIL_ADDRESS` on; `PHONE_NUMBER`, `PERSON`, `LOCATION`, `ORGANIZATION` off | mixed |
| `financial` | `CREDIT_CARD`, `IBAN_CODE` on; routing numbers, `CRYPTO` off | mixed |
| `environment` | `LOCAL_PATH`, `IP_ADDRESS`, `MAC_ADDRESS` | on (every member) |

The five labels are grouping and display metadata. The relabel preserves
entity names, tier meanings and every per-entity default. Detectors and
redaction mechanics are unchanged; `local_paths` was the only split
bucket: its path entity joins `environment` while credential-file entities
join `credentials`.

Category membership and labels are **not a stable wire contract**. Stored
policies keyed per **entity** keep their exact meaning across upgrades.
Older category-keyed policy rows are not remapped: a current label's
members follow the new grouping, while a dropped label is rejected strictly
locally / dropped tolerantly on the managed path. Prefer entity keys, or
migrate category keys deliberately before upgrading to this label set. For
example, moving `network` to the new name `environment` keeps its members,
but `secrets → credentials` would now also include credentialed URLs.
Stored **custom entity** definitions' category labels are normalized at
parse time through the legacy-label map (e.g. `secrets` and
`credentialed_urls` → `credentials`, `emails`/`phones`/`personal_details` →
`person_data`, `local_paths`/`network` → `environment`). That mapping
applies only to custom-definition metadata — never to category-keyed policy
states.

### Removed names

Twelve engine names were removed from the registry entirely — not
configurable, permanently suppressed engine-side
(`PERMANENT_ENGINE_EXCLUSIONS`), their names free for user-defined custom
entities:

`GUID` (structural identifiers — redacting session IDs breaks flows),
`DATE_TIME` and `UK_POSTCODE` (log chatter, not PII), the URL family
`URL`, `MONGODB_SRV`, `ELASTICSEARCH_URL`, `FIREBASE_URL` (coverage lives
in the `URL_WITH_CREDENTIALS` customs), `CRATES_IO_TOKEN`, `NUGET_KEY`,
`AIRTABLE_KEY` (measured inert on production transcripts),
`TWILIO_ACCOUNT_SID`, `CLERK_PUBLISHABLE_KEY` (public identifiers, not
secrets).

Migration note: a **local** `redaction.entities` entry naming any of the
twelve now throws `unknown entity` (strict, fail-visible — delete the
entry); the org-managed wire path drops them tolerantly with one log line.
The legacy `excludedEntities` list still accepts them (they land inert).

The full machine-readable catalog (entity → tier → category → defaultOn →
liveState) is emitted by `bun scripts/redaction-catalog.ts`; its active
rows are committed next to the registry as
`src/extensions/pii-redaction/redaction-catalog.json` (a drift-guard test
pins them — any registry edit must regenerate and commit both), and the
policy-UI console fetches the tagged raw file from this repo.

## Local configuration (settings.json)

```jsonc
{
  "redaction": {
    "categories": { "environment": "off" },        // whole category on/off
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
`^[A-Z][A-Z0-9_]{2,63}$` and not a built-in registry name (names of
removed entities above are free for reuse — the engine detectors behind
them stay permanently excluded); category from the list above; pattern ≤
512 chars compiling as a JS RegExp; flags ⊆ `imsu`; at most 50 entries.
`secretGroup` ≥ 1 replaces only that capture group (the rest of the match
is anchoring context), mirroring the built-in anchored patterns.
Quantified groups containing alternation or a nested quantifier —
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

`{ "redaction": { "excludedEntities": ["PHONE_NUMBER"] } }` is deprecated
in favor of the policy shape above. The array **replaces** the engine
exclusion list wholesale — with one permanent exception:
`PERMANENT_ENGINE_EXCLUSIONS` survives every path, so the twelve removed
names above can no longer be re-enabled (they parse but land inert). For
anchor-required entities the legacy list remains the only way to restore
the bare engine detector. It cannot be combined with
`categories`/`entities`/`customEntities` — mixing throws.

## Telemetry

`pii_redaction.redacted` records carry a `category` attribute derived from
the pass's policy view (`credentials`, `person_data`, …; `custom` when the
marker has no catalog attribution), so dashboards can group redactions by
the same unit admins toggle. The five-label relabel starts a new series at
the release boundary; existing `secrets`, `emails` and other previous
attributes are not renamed retroactively. See `docs/event-bus.md` §9.
