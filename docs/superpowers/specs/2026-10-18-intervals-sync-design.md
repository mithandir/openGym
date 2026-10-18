# Intervals.icu two-way sync

Approved on 2026-10-18: completed gym workouts, daily body weight, and planned gym sessions; use server-side polling.

## Behavior

Settings → Data & backup contains the connection, configurable history (default 90 days), planning horizon (default 42 days), timezone, automatic sync switch, Sync now, errors, review items, and disconnect. OAuth is available when the operator configures an approved Intervals application; a personal API key supports a private installation. Secrets never enter workout state or backups and are encrypted on disk using the instance secret.

Poll every 15 minutes and queue a debounced run after a successful OpenGym state write. Runs serialize per profile; no overlapping imports. Errors use bounded exponential backoff, honor Retry-After, and leave checkpoints intact. Persist record links and content baselines after each successful operation. Bulk manual activity upsert and calendar external IDs make retries idempotent.

Completed workouts become WeightTraining activities with readable exercise/set descriptions. Shared metadata returns to OpenGym without discarding its detailed sets. Native Intervals strength activities import as summary sessions with no invented repetitions or training progression. Strava stubs and other sports are skipped.

Body weight shares only the weight field of daily wellness records; all remote values are metric and convert to/from the profile unit. Compare normalized content rather than clocks.

Publish dated instances of the fixed weekly plan and explicit date overrides; floating rotation sessions require a date pin. Imported plans create date-specific routines, leaving reusable routines unchanged. Multiple sessions on a day are combined. Calendar name/date/description edits return to the dated instance. Arbitrary exercise prose is preserved as notes and requires a user to add exercises before a summary-only plan can be trained; never guess exercise identity or prescriptions.

## Reconciliation and safety

Three-way comparison uses each linked record's local and remote baselines. One-sided changes flow automatically; two-sided changes, existing same-day weigh-ins, ambiguous plan collisions, and deletions are review items. User choices select OpenGym or Intervals; deletions require an explicit choice. Missing records are verified individually, since moving outside a query range does not mean deletion. Never delete unrelated activities, calendar events, or wellness fields. Date-specific cancellations must not fall back to a repeating routine on the next poll.

Imported state updates use OpenGym's stampPut, revision/write ancestry, atomic persistence, and cache invalidation. Fetch the latest local document after network requests; apply only if the compared source still matches, otherwise defer to the next run. Credentials changing or disconnecting invalidates in-flight work. Account deletion clears the integration and revokes OAuth where possible.

## Verification

Unit tests cover mapping, unit conversion, calendar instances, conflicts, deletion review, out-of-window records, idempotence, partial retries, backoff, serialization, credential protection, and concurrent local edits. HTTP tests cover authentication, route validation, OAuth state, and server state revision behavior. Frontend tests cover settings and conflict actions; run API/frontend suites, locale checks, production build, and a browser check. Live third-party verification requires a real authorized account and is reported separately.

## API references

- https://intervals.icu/api/v1/docs
- https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090
- https://forum.intervals.icu/t/uploading-planned-workouts-to-intervals-icu/63624
- https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
