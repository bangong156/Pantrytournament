// Each screen captures an immutable event scope. Never silently fall back to a
// tournament-wide query when the event has not loaded.
export const competitionTables = new Set([
  'teams', 'team_members', 'groups', 'group_teams', 'matches',
  'mlp_configs', 'mlp_slots', 'mlp_games', 'tournament_awards',
  'referee_access_codes', 'referee_sessions', 'referee_score_logs',
  'referee_live_actions'
]);
export function competitionClient(client, event) {
  if (!event?.id || !event?.tournament_id) throw new Error('Chưa chọn nội dung thi đấu.');
  const scope = Object.freeze({id:event.id, tournament_id:event.tournament_id});
  const payload = row => {
    if (row.event_id && row.event_id !== scope.id) throw new Error('Sai nội dung thi đấu.');
    if (row.tournament_id && row.tournament_id !== scope.tournament_id) throw new Error('Sai giải đấu.');
    return {...row, event_id:scope.id};
  };
  return {
    event:scope,
    from(table) {
      if (!competitionTables.has(table)) throw new Error(`Table is not event scoped: ${table}`);
      const query = client.from(table);
      // Reuse the Supabase client-info header so browser CORS needs no new headers.
      const scoped = builder => builder.eq('event_id',scope.id).setHeader('x-client-info',`pantry-event/${scope.id}`);
      return {
        select: (...args) => scoped(query.select(...args)),
        update: (row,...args) => scoped(query.update(payload(row),...args)),
        delete: (...args) => scoped(query.delete(...args)),
        insert: (rows,...args) => query.insert(Array.isArray(rows)?rows.map(payload):payload(rows),...args).setHeader('x-client-info',`pantry-event/${scope.id}`),
        upsert: (rows,...args) => query.upsert(Array.isArray(rows)?rows.map(payload):payload(rows),...args).setHeader('x-client-info',`pantry-event/${scope.id}`)
      };
    }
  };
}
