# Multiple competition events

Schema reference: **`pantry-multi-event-tournaments.sql`**.

**Production already has the Multi-event schema. Do not execute or rerun this SQL
as part of deploying the frontend.** Keep it as a schema reference alongside the
historical SQL files. Do not run older feature patches either; they contain
older tournament-wide RPC definitions.

The user confirmed production diagnostics: all 25 expected function bodies match
after CRLF-to-LF normalization, with no function metadata/EXECUTE grant, trigger,
RLS policy, or checked schema differences. Prior ownership checks returned zero
violations; 304 operational rows were event-owned, with two default events for
two tournaments. These results establish the reported installed state, not who
originally applied it. This frontend review has not executed production SQL or
modified production data.

## Data model and compatibility

- `tournaments` keeps its identity, date, poster, information, registration link and
  legacy courts column. Adds nullable `start_time` and `expected_team_count`.
- `tournament_events` owns category name, planned time, format, planning count,
  order, default marker and competition status.
- Every existing tournament gets `Nội dung chính`, copying its format/status.
  Existing IDs, scores, group assignments, rosters, MLP settings, awards and tokens
  remain in place. Root rows are backfilled through `tournament_id`; child rows
  through their existing team/group/match parent. Players and flags remain global.
- Event ownership is non-null on teams, team_members, groups, group_teams, matches,
  mlp_configs, mlp_slots, mlp_games, tournament_awards, referee_access_codes,
  referee_sessions, referee_score_logs and referee_live_actions.
- Composite foreign keys validate tournament and parent-event consistency.
  Existing FK delete actions remain in effect. Tournament-wide operational unique
  keys move to `event_id`; keys already based on group/team/match UUIDs remain.
- A trigger creates future default events automatically. The new create RPC commits
  tournament/default event/MLP style atomically. The old `set_mlp_style` signature
  continues targeting the default event.
- The shared frontend client adds event filters/payload ownership and captures the
  selected event per screen. Event scope is tagged in the existing `x-client-info`
  header, avoiding a custom CORS header requirement. Restrictive write RLS keeps clients without an event
  header on the default event, while retaining existing authorization policies.
  This header selects scope; it does not grant authorization. Legacy public reads
  can still aggregate a tournament, so deploy/refresh the updated UI for multi-event use.
- Referee tokens still authorize a specific group UUID. Server checks also verify
  event ownership and use event-specific format/configuration. Public rosters expose
  the same display names/counts as before, with no new access to player records.
- Event deletion is allowed only for empty events and never the final event. Format
  changes are refused once teams, groups, matches or honors exist. These restrictions
  protect existing data. MLP configuration may be removed when deleting an empty event.
- Planned counts never cap registration. Public single-event tournaments have no
  extra event selector; multi-event tournaments do. Tournament information remains
  shared across all events.

## Deployment and remaining validation

Deploy the frontend build only, after commit/deployment approval. No SQL execution
is required for the confirmed production installation. Keep diagnostic SQL files
and `security-audit-live.sql` out of the feature commit. Do not include generated
`dist/` files or `node_modules/`.

The frontend uses `create_competition_tournament` to create the tournament,
default event and MLP style atomically. Event management uses
`save_competition_event` and `delete_competition_event`; populated-event and
last-event restrictions remain server-enforced. Editing an existing MLP event
does not reset its style. Converting an empty doubles event offers Basic or Mini.

Before releasing broadly, use a separate staging dataset for desktop/mobile and
real Supabase authorization acceptance checks:

1. Create doubles, MLP Basic and Mini tournaments; verify one default event and
   the selected style, start time and optional planning count.
2. Add/switch/edit/delete empty events. Verify populated-event format/deletion
   rejection and last-event protection. No production reset or regrouping is
   part of this deployment review.
3. Use identical group/match labels in two events. Check rosters, group scheduling,
   scoring, standings, knockout and awards remain isolated. Navigate during a
   pending save and confirm the new screen remains selected.
4. Restore existing referee sessions and access codes. Check doubles/Mini live
   scoring and Basic game/DreamBreaker entry, revocation and cross-event rejection.
5. Verify anonymous public rosters and the event selector; verify staff/admin
   permissions and player privacy. Check desktop/mobile layouts and shared
   tournament information, posters and registration links.

Operational regrouping, schedule replacement and roster import still use multiple
requests; they are not atomic on network/server failure. Import reports partial
progress. Inspect the selected event before retrying; do not blindly repeat an
import or destructive scheduling action. A browser stores one referee login per
tournament; viewing another event retains it, while a successful new claim replaces
that local entry without revoking the previous server session.

## Local verification

- `npm test`: 22 regression cases across two test files. Uses the actual Supabase
  query builder with a mock transport and a VM frontend harness with in-memory
  records. Covers event filters/payloads/headers, ownership rejection, default
  selection, creation/event RPC payloads, Basic/Mini configuration, scheduling,
  standings, knockout, awards, navigation races, referee scope/login preservation,
  public selection, escaping/last-event UI, spreadsheet parsing and slot-ID retention.
- `npm run build`: production Vite build; spreadsheet code loads only for import.
- `git diff --check`: whitespace validation.

The frontend review did not execute SQL or application requests against production.
The production catalog results were supplied by the user. Automated tests use
mock data; real-browser mobile/desktop and end-to-end Supabase authorization checks
remain outstanding. The migration SQL is unchanged.

The pre-existing overview referenced an undefined `previewExcel` handler. It is
restored using the existing XLSX dependency, established roster column order and
shared player lookup, with preview/confirmation and event-scoped writes. Import
reports partial progress if an individual team fails; inspect existing teams before
retrying to avoid duplicate registrations. MLP slot edits retain existing IDs and
values; reading legacy Mini settings only normalizes the display, without writing
configuration changes.
