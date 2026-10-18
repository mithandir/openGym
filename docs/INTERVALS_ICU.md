# Intervals.icu two-way sync

OpenGym can sync completed gym workouts, daily body weight, and dated gym plans
with Intervals.icu. Everything runs in OpenGym's API container. No bridge service,
cron job, public webhook endpoint, or mobile app running in the background is needed.

## Connect

1. Sign in to your OpenGym server and let your profile sync to it.
2. Open **Settings → Data & backup → Intervals.icu**.
3. Select the history range (90 days by default, up to 3,650), planning horizon
   (42 days by default, up to 180), and your IANA timezone, e.g. `Europe/Zurich`.
4. On a shared installation, choose **Connect with Intervals.icu** and grant
   activity, wellness, and calendar write access. OAuth setup is described below.
   On a personal self-hosted installation, you can paste your own Intervals.icu
   API key from **Settings → Developer settings** instead.
5. Choose **Sync now** and review any conflicts or imported plans needing exercises.

The server polls every 15 minutes and queues a sync five seconds after a successful
OpenGym profile write. A minute timer starts due polls, including after a restart.
Switching off automatic sync pauses both triggers; **Sync now** still works.
Failures retry with exponential backoff (one minute up to one hour), respecting
Intervals.icu's `Retry-After`. Access refusals wait an hour and ask you to reconnect.
Manual sync also respects this backoff. The server must remain running and be able
to reach `https://intervals.icu`.

## What is shared

| Data | OpenGym → Intervals.icu | Intervals.icu → OpenGym |
|---|---|---|
| Completed gym workout | Manual `WeightTraining` activity: name, local date/time, duration, notes and readable exercise/set description | Gym activity summary; linked workouts retain their detailed OpenGym sets |
| Daily body weight | The wellness record's `weight` field, converted to kg | Weight converted to the profile's kg/lb unit |
| Dated gym plan | `WORKOUT` / `WeightTraining` calendar event with prescription in its description | Name, date/time, duration and description in an isolated routine assigned to that date |

Other sports, Strava stubs, other wellness fields, and the Intervals.icu workout
library are outside this integration. Native gym activities import as summary-only
history entries with no invented reps, PRs, or progression. An Intervals description
cannot reliably identify a catalog exercise or express every OpenGym set type:
native plans retain that description in their routine notes and appear under
**Review plan** until exercises have been added. Shared-field edits to an exported
plan preserve the copied OpenGym prescription; they do not parse rewritten prose
into replacement sets. Update those prescriptions in OpenGym.

Fixed-week routines are expanded into dated calendar instances within the horizon.
Combined routines become one calendar event for the day. Floating rotations are
published only when pinned to a date. An Intervals edit creates or modifies that
date's routine, leaving the recurring source routine alone. Moving or deleting a
dated plan leaves a rest override on its old day so a weekly routine does not
silently recreate it. The planning horizon is a count of days starting today;
history includes the configured number of days before today and today's records.

OpenGym has one combined dated session per day. If Intervals has multiple gym
events on the same day, sync pauses those dates with a review explanation. Combine
or move the events in Intervals first. Other dates continue syncing.
Moving a linked session onto a different occupied OpenGym day also waits for review;
move one session to a free date first. Replacing the routine on the same imported
session's day updates its linked event instead of creating a second event.

## Conflicts and deletion

Record links and the last agreed shared values prevent repeat imports and exports.
If only one side changes, its shared fields update the other side. If both change,
or initial records have different weights/plans for the same day, **Sync conflicts**
shows both values. Choose **Use OpenGym** or **Use Intervals.icu**. Choices apply only
to the versions you reviewed; newer edits require a new choice.

Deleting a linked record requires a second **Confirm deletion** step to propagate
that deletion. Choosing the surviving side restores the missing record instead.
Body-weight deletion clears only `weight`, preserving other wellness fields.
The API client uses Intervals.icu's `-1` sentinel to clear that numeric field;
the live API ignores JSON `null` for this update.
The sync fetches a missing remote record individually before treating it as deleted,
because moving beyond the selected date range is not a deletion. Unlinked remote
data is never deleted. Date ranges limit discovery; they do not erase old records.

## OAuth for shared servers

1. Apply for an Intervals application at <https://intervals.icu/oauth/apply>.
   The application must be approved before OAuth works.
2. Register `https://your-gym.example/api/intervals/oauth/callback` as its redirect
   URI. For a subpath deployment include the prefix, such as
   `https://your-gym.example/gym/api/intervals/oauth/callback`.
3. Set `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET`, and
   `INTERVALS_REDIRECT_URI` in the API environment (`.env` for Docker Compose).
   The default redirect URI is `ORIGIN` plus `/api/intervals/oauth/callback`.
4. Restart the API container. **Connect with Intervals.icu** will appear in Settings.

Authorization requests activity, wellness, and calendar WRITE scopes (which include
read access). OAuth state is single-use, lasts ten minutes, and is bound to the
signed-in OpenGym profile. Complete OAuth in the same web browser; a paired mobile
app uses the server-side connection after it has been established there. The mobile
settings also support a personal API key.

## Storage, backups, and disconnect

Credentials are AES-256-GCM encrypted in `DATA_DIR/intervals-<uid>.json`, protected
with mode 0600 where supported. The encryption key derives from the instance's
`DATA_DIR/secret`. These files also hold record links, checkpoints, and review
items. They are outside profile state, device storage, and exported profile backups.
An operator's backup of the entire data directory includes them and the secret:
protect that backup as account credentials. Preserve the instance secret when
restoring these files.

**Disconnect Intervals.icu** removes stored credentials and links, cancels pending
imports, and attempts to revoke OAuth access. Existing workouts and plans remain
in both applications. If Intervals is unreachable, revoke the app there manually
as well. Deleting or disabling an OpenGym account also clears its integration (a
disabled account is detected by the next polling tick). Reconnecting to the same
athlete without disconnecting retains links. Switching athletes starts new links.

Endpoints are documented in [the OpenGym API](API.md). Automated tests use a
simulated Intervals server. The personal API-key flow has also passed a
[live verification with a dedicated dummy athlete](dev/INTERVALS_LIVE_TEST.md).

The integration's primary controls have translations in all app languages. Some
new explanatory text currently uses English until translated.
