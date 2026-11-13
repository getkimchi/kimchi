/**
 * Detector tier registry for the redaction engine.
 *
 * Every entity type the `@bulkhead-ai/core` engine can emit — plus the
 * kimchi-owned custom pattern names in `redactor.ts` — is classified once,
 * here, by the evidence its detector carries:
 *
 * - `checksum` — the match passes a mathematical check (Luhn, mod-97).
 *   Intrinsically precise; always on.
 * - `anchored` — the string itself carries the type signature (vendor
 *   prefix, PEM header, `@` email shape). False positives are rare by
 *   construction; on.
 * - `bare_shape` — the pattern is only a length/character-class shape
 *   (dates, phone runs, national-ID layouts, raw hex). In an engineering
 *   corpus these collide with SHAs, timestamps, and ID digits constantly;
 *   excluded by default.
 * - `anchor_required` — a bare secret shape (40-char base64, plain URL)
 *   honored only with keyword/context anchoring. Excluded at engine level;
 *   kimchi re-adds the anchored variants as custom patterns in
 *   `redactor.ts` (URL_WITH_CREDENTIALS, keyword-prefixed AWS secret, …).
 *
 * Rationale and evidence: `.kimchi/plans/redaction-precision.md`. The rule
 * classifies the vocabulary, not yesterday's samples — new entities on a
 * bulkhead upgrade are caught by the exhaustiveness test in
 * `entity-tiers.test.ts` (scan fixtures, assert every emitted type is
 * registered) and must be classified on arrival.
 *
 * The excluding mechanism is `engine.setExcludeEntities` — this module only
 * decides the default list; `config.ts` owns user overrides
 * (`redaction.excludedEntities` in settings.json).
 */

export type EntityTier = "checksum" | "anchored" | "bare_shape" | "anchor_required"

/** Math-validated detectors. Always on. */
const CHECKSUM_ENTITIES = [
	"CREDIT_CARD", // Luhn
	"IBAN_CODE", // mod-97
] as const

/**
 * Bare-shape detectors kept ON: their shape is syntactically precise
 * (dotted quads, colon hex) so they rarely false-fire, and their
 * sensitivity is debatable but low-cost to keep.
 */
const BARE_SHAPE_KEPT: ReadonlySet<string> = new Set(["IP_ADDRESS", "MAC_ADDRESS", "EMAIL_ADDRESS"])

/** National-ID / civil-date / locale formats — shape-only evidence. */
const BARE_SHAPE_NATIONAL_IDS = [
	"ABA_ROUTING_NUMBER",
	"AU_ABN",
	"AU_ACN",
	"AU_MEDICARE",
	"AU_TFN",
	"DE_PASSPORT",
	"DE_TAX_ID",
	"ES_NIE",
	"ES_NIF",
	"FI_PERSONAL_IDENTITY_CODE",
	"IN_AADHAAR",
	"IN_PAN",
	"IN_PASSPORT",
	"IN_VEHICLE_REGISTRATION",
	"IN_VOTER",
	"IT_DRIVER_LICENSE",
	"IT_FISCAL_CODE",
	"IT_IDENTITY_CARD",
	"IT_PASSPORT",
	"IT_VAT_CODE",
	"KR_PASSPORT",
	"KR_RRN",
	"MEDICAL_LICENSE",
	"NG_NIN",
	"PL_PESEL",
	"SE_PERSONNUMMER",
	"SG_NRIC_FIN",
	"SG_UEN",
	"TH_TNIN",
	"UK_NHS",
	"UK_NINO",
	"UK_PASSPORT",
	"UK_POSTCODE",
	"UK_VEHICLE_REGISTRATION",
	"US_BANK_NUMBER",
	"US_DRIVER_LICENSE",
	"US_ITIN",
	"US_MBI",
	"US_NPI",
	"US_PASSPORT",
	"US_SSN",
] as const

/** Other bare-shape detectors (off): dates, phones, NER-ish labels, IDs. */
const BARE_SHAPE_OTHER = [
	"DATE_TIME",
	"PHONE_NUMBER",
	"CRYPTO", // raw hex/base58 address shapes — collides with git SHAs
	"LOCATION", // NER-ish, no signature
	"PERSON", // unverified whether it fires — classified so a future activation is off
	"ORGANIZATION", // same
	"GUID", // structural identifiers (ferment/session IDs) — redacting breaks flows
	"IP_ADDRESS", // shape-precise and kept on — see BARE_SHAPE_KEPT
	"MAC_ADDRESS", // same
	"EMAIL_ADDRESS", // shape-based detector, always kept on (identity surface, not keyword-anchored)
	"AIRTABLE_KEY", // `key[A-Za-z0-9]{14}` shape — measured ~3% precision on transcripts; opt-in
	"TELEGRAM_BOT_TOKEN", // `<digits>:<35 chars>` collides with CI section markers
	"OKTA_TOKEN", // bare shape — collides with branch names / base64 blobs
] as const

/**
 * Bare secret shapes honored only with anchoring context. Excluded at
 * engine level; the anchored re-additions live in CUSTOM_PATTERNS.
 */
const ANCHOR_REQUIRED_ENTITIES = [
	"AWS_SECRET_KEY", // 40-char base64 — collides with temp paths, hashes
	"AZURE_STORAGE_KEY", // 88-char base64 —
	// Values only: AccountKey=/SharedAccessKey=/SharedAccessSignature= values
	// re-added anchored below — the keyword itself is never secret.
	"AZURE_CONNECTION_STRING",
	"GENERIC_SECRET", // by definition context-free
	// 0% measured precision on 2.6k production transcripts — every
	// hit was an identifier fragment or payload noise, zero real keys.
	"CRATES_IO_TOKEN",
	"NUGET_KEY",
	"BASIC_AUTH", // honored via an `Authorization: Basic` anchor
	"DOCKER_REGISTRY_AUTH",
	"DATABASE_CONNECTION_STRING", // bare scheme shape too noisy — credential-bearing DB URIs re-added by custom
	"URL", // URLs are not credentials — credentialed forms re-added
	"ELASTICSEARCH_URL",
	"FIREBASE_URL",
	"MONGODB_SRV",
] as const

/**
 * Vendor tokens whose signature is in the string itself (prefix, header,
 * marker path segment). On. Grouped loosely for maintainability; order
 * within a group carries no meaning.
 */
const ANCHORED_ENTITIES = [
	"PRIVATE_KEY",
	// Cloud / infra
	"AWS_ACCESS_KEY",
	"AWS_MWS_KEY",
	"AWS_SESSION_TOKEN",
	"AZURE_AD_CLIENT_SECRET",
	"AZURE_DEVOPS_TOKEN",
	"AZURE_FUNCTION_KEY",
	"GCP_API_KEY",
	"GCP_OAUTH_SECRET",
	"GCP_SERVICE_ACCOUNT",
	"IBM_CLOUD_API_KEY",
	"IBM_COS_HMAC",
	"ORACLE_CLOUD_KEY",
	"ALIBABA_CLOUD_KEY",
	"DIGITALOCEAN_TOKEN",
	"DIGITALOCEAN_SPACES_KEY",
	"VULTR_API_KEY",
	"LINODE_TOKEN",
	// LLM vendors
	"ANTHROPIC_KEY",
	"OPENAI_KEY",
	"MISTRAL_KEY",
	"GROQ_KEY",
	"DEEPSEEK_KEY",
	"COHERE_KEY",
	"GOOGLE_AI_KEY",
	"REPLICATE_TOKEN",
	"HUGGINGFACE_TOKEN",
	"WANDB_KEY",
	// Source control / CI
	"GITHUB_TOKEN",
	"GITHUB_APP_TOKEN",
	"GITHUB_FINE_GRAINED_TOKEN",
	"GITHUB_ACTIONS_SECRET",
	"GITLAB_TOKEN",
	"GITLAB_PIPELINE_TOKEN",
	"GITEA_TOKEN",
	"BITBUCKET_APP_PASSWORD",
	"BITBUCKET_CLIENT_SECRET",
	"CIRCLECI_TOKEN",
	"TRAVIS_CI_TOKEN",
	"DRONE_CI_TOKEN",
	"BUILDKITE_TOKEN",
	"BUILDKITE_AGENT_TOKEN",
	"TEAMCITY_TOKEN",
	"JENKINS_API_TOKEN",
	"JENKINS_CRUMB",
	"CODECOV_TOKEN",
	// Package registries
	"NPM_TOKEN",
	"PYPI_TOKEN",
	"RUBYGEMS_KEY",
	"DOCKER_HUB_TOKEN",
	"HELM_REPO_TOKEN",
	// Payments / commerce
	"STRIPE_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"SQUARE_ACCESS_TOKEN",
	"SQUARE_OAUTH_SECRET",
	"PAYPAL_CLIENT_SECRET",
	"PAYPAL_BRAINTREE_TOKEN",
	"BRAINTREE_KEY",
	"SHOPIFY_TOKEN",
	"ADYEN_API_KEY",
	"PLAID_KEY",
	// SaaS / app platforms
	"SLACK_TOKEN",
	"SLACK_APP_TOKEN",
	"DISCORD_TOKEN",
	"TWITTER_API_KEY",
	"TWITTER_API_SECRET",
	"TWITTER_BEARER_TOKEN",
	"FACEBOOK_TOKEN",
	"FACEBOOK_SECRET",
	"INSTAGRAM_TOKEN",
	"LINKEDIN_SECRET",
	"PINTEREST_TOKEN",
	"TIKTOK_TOKEN",
	"YOUTUBE_API_KEY",
	"NOTION_TOKEN",
	"INTERCOM_TOKEN",
	"JIRA_TOKEN",
	"LINEAR_API_KEY",
	"ASANA_TOKEN",
	"HUBSPOT_API_KEY",
	"MAILCHIMP_KEY",
	"MAILGUN_KEY",
	"POSTMARK_TOKEN",
	"SENDGRID_KEY",
	"SEGMENT_KEY",
	"TWILIO_ACCOUNT_SID", // "AC" prefix
	"TWILIO_AUTH_TOKEN",
	"TWILIO_KEY",
	"SALESFORCE_TOKEN",
	"ZENDESK_TOKEN",
	// Dev-platform / registry tokens (prefixed shapes)
	"SONARQUBE_TOKEN", // squ_/sqp_ prefix
	// Observability / ops
	"DATADOG_API_KEY",
	"NEW_RELIC_KEY",
	"GRAFANA_API_KEY",
	"SENTRY_AUTH_TOKEN",
	"PAGERDUTY_KEY",
	"VAULT_TOKEN",
	"CONSUL_TOKEN",
	"KEYCLOAK_SECRET",
	"KUBERNETES_SERVICE_TOKEN",
	"ANSIBLE_VAULT_PASSWORD",
	"TERRAFORM_TOKEN",
	// Databases / backends
	"NEON_DB_TOKEN",
	"PLANETSCALE_TOKEN",
	"PLANETSCALE_PASSWORD",
	"COCKROACHDB_CONNECTION",
	"SUPABASE_KEY",
	"SUPABASE_SERVICE_KEY",
	"FIREBASE_AUTH_KEY",
	"FIREBASE_KEY",
	"REDIS_URL_WITH_PASSWORD", // secret in userinfo by design
	// Deployment / hosting
	"VERCEL_TOKEN",
	"NETLIFY_TOKEN",
	"RENDER_TOKEN",
	"RAILWAY_TOKEN",
	"FLY_IO_TOKEN",
	"HEROKU_API_KEY",
	"SURGE_TOKEN",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_CA_KEY",
	"FASTLY_API_KEY",
	"ALGOLIA_KEY",
	"CONTENTFUL_TOKEN",
	"WEAVIATE_KEY",
	"PINECONE_KEY",
	"LAUNCHDARKLY_KEY",
	"PULUMI_TOKEN",
	// Identity / SSO
	"AUTH0_CLIENT_SECRET",
	"AUTH0_MANAGEMENT_TOKEN",
	"CLERK_PUBLISHABLE_KEY",
	"CLERK_SECRET_KEY",
	"STYTCH_SECRET",
	"PROPELAUTH_KEY",
	// Structured secrets (signature in shape)
	"JWT_TOKEN", // eyJ… . … . … triplet
	"BEARER_TOKEN",
	"SENTRY_DSN", // key in userinfo path by design
	"SLACK_WEBHOOK", // secret in URL path by design
	"TEAMS_WEBHOOK",
	"DISCORD_WEBHOOK",
] as const

/**
 * Kimchi-owned names emitted by CUSTOM_PATTERNS in redactor.ts — not engine
 * entities, but part of the same marker namespace and therefore valid in
 * `redaction.excludedEntities`. All are anchored by construction.
 */
const KIMCHI_OWNED = [
	"CASTAI_API_KEY",
	"OPENAI_API_KEY",
	"OAUTH_TOKEN",
	"LOCAL_PATH",
	"CREDENTIAL_FILE",
	"SECRET_FIELD",
	"URL_WITH_CREDENTIALS",
] as const

const TIER_ENTRIES: ReadonlyArray<readonly [EntityTier, readonly string[]]> = [
	["checksum", CHECKSUM_ENTITIES],
	["anchored", ANCHORED_ENTITIES],
	["bare_shape", [...BARE_SHAPE_NATIONAL_IDS, ...BARE_SHAPE_OTHER]],
	["anchor_required", ANCHOR_REQUIRED_ENTITIES],
	["anchored", KIMCHI_OWNED],
]

const ENTITY_TIERS: ReadonlyMap<string, EntityTier> = (() => {
	const map = new Map<string, EntityTier>()
	for (const [tier, names] of TIER_ENTRIES) {
		for (const name of names) map.set(name, tier)
	}
	return map
})()

/** Whether the name is a registered entity (engine-native or kimchi-owned). */
export function isKnownEntity(name: string): boolean {
	return ENTITY_TIERS.has(name)
}

/** Every registered entity name (includes GUID). For drift guards. */
export function listRegisteredEntities(): readonly string[] {
	return [...ENTITY_TIERS.keys()]
}

/** The tier for a registered entity, undefined for unknown names. */
export function getEntityTier(name: string): EntityTier | undefined {
	return ENTITY_TIERS.get(name)
}

/**
 * The default set excluded at engine level: every bare-shape detector
 * (except the shape-precise keep-list) plus every anchor-required detector
 * (re-added anchored by CUSTOM_PATTERNS).
 */
export function getDefaultExcludedEntities(): string[] {
	const excluded: string[] = []
	for (const [name, tier] of ENTITY_TIERS) {
		if (tier === "anchor_required") excluded.push(name)
		else if (tier === "bare_shape" && !BARE_SHAPE_KEPT.has(name)) excluded.push(name)
	}
	return excluded.sort()
}

// ---------------------------------------------------------------------------
// Redaction categories — the coarse unit admins toggle (LLM-4416)
// ---------------------------------------------------------------------------
//
// Every registered entity except GUID belongs to exactly one category and
// carries an effective default: whether it redacts today. The default is
// intentionally NOT derived from the tier alone: TELEGRAM_BOT_TOKEN and
// OKTA_TOKEN are bare_shape at the engine but redact via keyword-anchored
// custom patterns, while inert entities (URL, MONGODB_SRV, ...) have no
// re-addition at all and never fire. The category map is therefore
// explicit; the exhaustiveness test fails if tier and category maps drift.

export const REDACTION_CATEGORIES = [
	"secrets",
	"local_paths",
	"emails",
	"phones",
	"network",
	"credentialed_urls",
	"financial",
	"identity_documents",
	"personal_details",
] as const

export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number]

const REDACTION_CATEGORY_SET: ReadonlySet<string> = new Set(REDACTION_CATEGORIES)

export function isRedactionCategory(key: string): key is RedactionCategory {
	return REDACTION_CATEGORY_SET.has(key)
}

/** anchor_required entities whose anchored re-additions exist in CUSTOM_PATTERNS today. */
const ANCHOR_REQUIRED_WITH_CUSTOMS = [
	"AWS_SECRET_KEY",
	"AZURE_CONNECTION_STRING",
	"AZURE_STORAGE_KEY",
	"GENERIC_SECRET",
	"BASIC_AUTH",
	"DOCKER_REGISTRY_AUTH",
] as const

/** Credentialed-URL entities whose coverage lives in URL_WITH_CREDENTIALS customs, not their own bare shape. */
const CREDENTIALED_URLS_INERT = ["URL", "ELASTICSEARCH_URL", "FIREBASE_URL", "MONGODB_SRV"] as const

/** anchor_required entities with an anchored re-addition of their own — the
 * union of ANCHOR_REQUIRED_WITH_CUSTOMS (secrets members) and entities whose
 * custom lives under a different category (DATABASE_CONNECTION_STRING's
 * credentialed-URI custom). Used only for liveState derivation; membership
 * is pinned by test against redactor's CUSTOM_PATTERNS. */
const ANCHOR_REQUIRED_WITH_OWN_CUSTOMS = [...ANCHOR_REQUIRED_WITH_CUSTOMS, "DATABASE_CONNECTION_STRING"] as const

/**
 * The engine-side disposition of an entity, independent of policy defaults:
 *
 * - "active": has live coverage of its own — an engine detector (anchored /
 *   checksum / bare_shape) or an anchored custom pattern. Turning it on or
 *   off is a meaningful policy choice.
 * - "alias_of": no coverage of its own; its hits are reported under another
 *   marker (URL_WITH_CREDENTIALS). Flipping it on activates the bare shape
 *   instead — a false-positive hazard, not the aliased coverage.
 * - "no_matcher": nothing fires under any policy — anchor_required without
 *   an anchored re-addition, or demoted as measured-inert.
 */
export type RedactionLiveState = "active" | "alias_of" | "no_matcher"

/** anchor_required entities with no anchored re-addition — never fire today.
 * CRATES_IO_TOKEN / NUGET_KEY: measured 0% precision on production transcripts. */
const SECRETS_INERT = ["CRATES_IO_TOKEN", "NUGET_KEY"] as const

/** [category, defaultOn, members]. GUID is deliberately unassigned (structural identifiers are never
 * redacted), as is UK_POSTCODE (dropped from the configurable surface: a shape-only postal code is
 * low-value as a redaction choice — the engine detector stays off regardless). */
type CategoryGroup = readonly [RedactionCategory, boolean, readonly string[]]

const CATEGORY_GROUPS: readonly CategoryGroup[] = [
	[
		"secrets",
		true,
		[
			...ANCHORED_ENTITIES.filter((name) => name !== "REDIS_URL_WITH_PASSWORD" && name !== "COCKROACHDB_CONNECTION"),
			...ANCHOR_REQUIRED_WITH_CUSTOMS.filter((name) => name !== "AZURE_CONNECTION_STRING"),
			// bare_shape at engine level, anchored by keyword custom patterns.
			"TELEGRAM_BOT_TOKEN",
			"OKTA_TOKEN",
			// kimchi-owned secret markers.
			"CASTAI_API_KEY",
			"OPENAI_API_KEY",
			"OAUTH_TOKEN",
			"SECRET_FIELD",
		],
	],
	["local_paths", true, ["LOCAL_PATH", "CREDENTIAL_FILE"]],
	["emails", true, ["EMAIL_ADDRESS"]],
	["phones", false, ["PHONE_NUMBER"]],
	["network", true, ["IP_ADDRESS", "MAC_ADDRESS"]],
	// DATABASE_CONNECTION_STRING fires via its credentialed-URI custom (userinfo
	// redacted); the bare scheme shape stays engine-excluded, so a DSN without
	// credentials is never marked.
	[
		"credentialed_urls",
		true,
		[
			"URL_WITH_CREDENTIALS",
			"REDIS_URL_WITH_PASSWORD",
			"COCKROACHDB_CONNECTION",
			"DATABASE_CONNECTION_STRING",
			"AZURE_CONNECTION_STRING",
		],
	],
	["secrets", false, [...SECRETS_INERT, "AIRTABLE_KEY"]],
	["credentialed_urls", false, CREDENTIALED_URLS_INERT],
	["financial", true, ["CREDIT_CARD", "IBAN_CODE"]],
	["financial", false, ["ABA_ROUTING_NUMBER", "US_BANK_NUMBER", "CRYPTO"]],
	[
		"identity_documents",
		false,
		BARE_SHAPE_NATIONAL_IDS.filter(
			(name) => name !== "ABA_ROUTING_NUMBER" && name !== "US_BANK_NUMBER" && name !== "UK_POSTCODE",
		),
	],
	["personal_details", false, ["PERSON", "LOCATION", "ORGANIZATION", "DATE_TIME"]],
]

interface CategoryEntry {
	category: RedactionCategory
	defaultOn: boolean
}

const ENTITY_CATEGORIES: ReadonlyMap<string, CategoryEntry> = (() => {
	const map = new Map<string, CategoryEntry>()
	for (const [category, defaultOn, members] of CATEGORY_GROUPS) {
		for (const name of members) {
			if (map.has(name)) throw new Error(`entity "${name}" appears in two CATEGORY_GROUPS entries`)
			map.set(name, { category, defaultOn })
		}
	}
	return map
})()

/** The category of a registered entity, undefined for unknown names and GUID (not configurable). */
export function getEntityCategory(name: string): RedactionCategory | undefined {
	return ENTITY_CATEGORIES.get(name)?.category
}

/**
 * Whether the entity redacts today under the tier defaults. False for
 * unknown names, GUID, bare-shape detectors, and anchor-required entities
 * without an anchored re-addition. True for checksum/anchored detectors and
 * for anchor-off entities covered by keyword-anchored custom patterns.
 */
export function getEntityDefaultOn(name: string): boolean {
	return ENTITY_CATEGORIES.get(name)?.defaultOn ?? false
}

export interface RedactionCatalogEntry {
	entity: string
	tier: EntityTier
	category: RedactionCategory
	defaultOn: boolean
	/** Engine-side disposition — what actually fires, independent of defaultOn. */
	liveState: RedactionLiveState
	/** The marker this entity's coverage is reported under; set iff liveState is "alias_of". */
	aliasOf?: string
}

/** Computed once — the catalog is a pure function of immutable registries. */
const REDACTION_CATALOG: readonly RedactionCatalogEntry[] = (() => {
	const entries: RedactionCatalogEntry[] = []
	for (const [entity, { category, defaultOn }] of ENTITY_CATEGORIES) {
		const tier = ENTITY_TIERS.get(entity) ?? "anchored"
		let liveState: RedactionLiveState = "active"
		let aliasOf: string | undefined
		if ((CREDENTIALED_URLS_INERT as readonly string[]).includes(entity)) {
			liveState = "alias_of"
			aliasOf = "URL_WITH_CREDENTIALS"
		} else if (
			tier === "anchor_required" &&
			!(ANCHOR_REQUIRED_WITH_OWN_CUSTOMS as readonly string[]).includes(entity)
		) {
			liveState = "no_matcher"
		}
		entries.push({ entity, tier, category, defaultOn, liveState, ...(aliasOf ? { aliasOf } : {}) })
	}
	return entries.sort((a, b) => a.entity.localeCompare(b.entity))
})()

/** The full configurable catalog (GUID excluded), sorted by entity name. */
export function listRedactionCatalog(): readonly RedactionCatalogEntry[] {
	return REDACTION_CATALOG
}
