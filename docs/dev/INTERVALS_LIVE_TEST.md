# Intervals.icu live verification

Tested on 2026-10-18 against the real Intervals.icu API with a dedicated dummy
athlete and an isolated localhost OpenGym profile. Authentication used a personal
API key; no personal athlete account or connected device was used. The dummy
mailbox was provided by [Mail.tm](https://mail.tm/).

## Result

All nine scenarios passed:

1. Export an OpenGym gym workout, daily body weight, and dated plan.
2. Repeat sync without creating duplicate activities or calendar events.
3. Import remote edits, preserving detailed OpenGym sets and the source routine.
4. Import native Intervals gym activities, wellness weight, and planned workouts.
5. Push an OpenGym edit automatically after a state write, without Sync now.
6. Hold simultaneous edits for review and apply the selected conflict side.
7. Hold remote calendar deletion for review before cancelling its OpenGym date.
8. Restore a deleted remote activity by choosing its surviving OpenGym version.
9. Propagate a confirmed weigh-in deletion while preserving unrelated wellness fields.

The final run completed with zero cleanup errors. A separate read-only verification
confirmed zero remaining test activities, zero remaining test plans, cleared test
weight fields, and removal of the connection credentials from OpenGym.

## Fix found through live testing

The first run passed the initial eight scenarios but found two cleanup failures:
`PUT /athlete/0/wellness/{date}` ignores a JSON `null` for built-in numeric weight.
Sending `{ "weight": -1 }` clears it. This was verified directly against the dummy
athlete, then fixed in `api/intervals-client.js` and covered by client and service
regression tests. A full second run included explicit weight-deletion verification
and passed all nine scenarios.

Reference: [clearing numeric wellness fields](https://forum.intervals.icu/t/api-and-clear-wellness-field/36819).

## Reproduce

`api/scripts/test-intervals-live.mjs` is an opt-in runner. It accepts a localhost
OpenGym API URL, a local test-session JSON file containing `uid` and `cookie`, and
the isolated `DATA_DIR`. It refuses a non-localhost API, a data directory without
the `opengym-intervals-live-<32 hex characters>` name, or an OpenGym profile whose
name does not start with `OpenGym live test`.

Connect that isolated profile through OpenGym Settings first. The runner reads
the existing encrypted credential; it never accepts a key on the command line or
prints it. It selects dates without existing weight or gym-plan data, uses unique
external IDs for test records, pauses automatic sync during controlled scenarios,
and cleans up its exact records in a `finally` block. It leaves the local connection
disconnected and writes `live-test-result.json` into the isolated data directory.
Use a fresh local test profile for each run; the runner retains local result data
for inspection, and reconnecting a dirty profile could export older test records.

```text
node api/scripts/test-intervals-live.mjs http://127.0.0.1:3000 <session.json> <isolated-data-dir>
```

OAuth remains covered by automated route tests; exercising that authorization flow
live requires an approved Intervals OAuth application configured on the server.
