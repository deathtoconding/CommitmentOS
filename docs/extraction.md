# Provider-independent extraction (COM-122–134)

## Current scope

This milestone adds a provider-neutral extraction contract, strict response schema, deterministic business-rule validation, conservative owner/deadline resolution, and a repeatable synthetic regression suite. It does **not** install or call an AI provider, connect to Gmail/Slack, write a commitment, or persist source text. The provider interface is a boundary for future adapters, not evidence of real-model quality or production extraction.

Every accepted proposal is returned as `PENDING_HUMAN_REVIEW`. No model-generated status, confidence score, counterparty, or completion evidence is trusted or filled in. A later workflow must keep human review/confirmation before creating or changing consequential records.

## Validation and resolution rules

`src/extraction/model.ts` defines a versioned, strict Zod response contract. Unknown fields are rejected at every object level. Each proposed commitment must have a non-empty text/action and an evidence span using JavaScript UTF-16 code-unit offsets (start inclusive, end exclusive), without splitting a surrogate pair. Commitment text must appear in its evidence span after Unicode/whitespace normalization; the proposed normalized action must be identical to that text after case/whitespace normalization, so a paraphrase cannot add a new fact. Unsupported candidates are dropped.

- **Owners:** An owner remains `null` unless the proposed name/email appears in its evidence span, matches exactly one current workspace member, and that evidence span identifies only one workspace member. Ambiguous names, conflicting identities, missing members, and unsupported claims stay unassigned. No fuzzy identity matching is performed.
- **Deadlines:** A deadline remains `null` unless the complete ISO-8601 timestamp, including an explicit UTC offset, appears literally in its evidence span and parses to a valid instant. Relative dates such as “next Friday,” date-only values, and invented times/timezones are not resolved.
- **Safe proposal shape:** Evidence is returned as offsets only, not copied text. Any unsupported field is null; invalid response shape rejects the provider result without surfacing raw provider output or source text.

The current bounds (100,000 UTF-16 code units of source text, 25 candidate commitments, and 5,000 UTF-16 code units per evidence span) are resource-safety limits, not product retention or extraction policies. Source text is passed to the supplied provider in memory for that call only; this module has no network client, persistence code, or logging of source/provider payloads. Provider calls are bounded to 30 seconds, carry an `AbortSignal`, and return a sanitized failure code rather than a thrown provider error. Any future adapter must honor cancellation; this boundary does not retry requests or persist failed payloads.

## Untrusted content and provider boundary

Provider requests mark source text as `UNTRUSTED_EXTERNAL_CONTENT` and carry an explicit instruction not to follow instructions embedded in it. This is defense-in-depth guidance only; a future model adapter must assume the instruction can be ignored, validate every result through the strict schema/business rules, and never let source text authorize external actions. The synthetic prompt-injection fixture verifies deterministic regression behavior; without a real model, it is **not** a claim of prompt-injection resistance for any AI provider.

No provider API is enabled by this work. Gmail/Slack scopes, consent, mailbox/channel authorization, content protection, retention/deletion/disconnect behavior, and managed-secret provider access remain behind the existing policy gate. Do not provide real message bodies to the fixtures or log/provider-test environments.

## Synthetic evaluation

Run:

```sh
npm run test:extraction-evaluation
```

The script uses only the versioned synthetic dataset at `fixtures/extraction/v1.json`; it makes no network calls and prints aggregate JSON without source text. The report pins the fixture/schema version and checks repeatable regression metrics:

- Commitment precision and recall use exact normalized commitment-text matching at the **candidate** level.
- False-positive rate is measured at the **source** level: false-positive sources divided by all ground-truth-negative sources.
- Owner and deadline accuracy are measured only on matched true commitments, with correct `null` predictions included in the denominator. Unmatched false-positive candidates do not inflate field accuracy.

The current synthetic fixture baseline is: precision **0.75** (6/8), recall **0.8571** (6/7), false-positive rate **0.3333** (1/3), owner accuracy **0.8333** (5/6), and deadline accuracy **0.8333** (5/6). These small, deliberately adversarial fixtures demonstrate metric/reporting behavior; the values are **not** representative model-quality targets. Any fixture or schema change must be versioned and its resulting metrics reviewed rather than silently updating the expected report.
