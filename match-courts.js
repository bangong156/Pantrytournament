export function courtLabel(number) {
  return Number.isInteger(number)&&number>0?`SÂN ${number}`:'';
}
export function courtOptions(current) {
  return [...new Set([1,2,3,4,5,6,...(courtLabel(current)?[current]:[])])];
}
export async function assignCourt(db, tournamentId, matchId, value) {
  const court=value===''?null:Number(value);
  if(court!==null&&(!Number.isInteger(court)||court<=0))throw new Error('Sân phải là số nguyên dương.');
  const {data,error}=await db.from('matches').update({court_number:court}).eq('tournament_id',tournamentId).eq('id',matchId).select('id,court_number').single();
  if(error)throw error;
  return data;
}
// The unique index handles simultaneous starts. Resolve its error to the same
// friendly court warning as the database guard, using public read permissions.
export async function courtConflictMessage(client,matchId,error) {
  if(error?.code!=='23505'||!String(error.message).includes('matches_playing_court_unique'))return error.message;
  const {data:match}=await client.from('matches').select('tournament_id,court_number').eq('id',matchId).maybeSingle();
  if(match?.court_number){
    const {data:other}=await client.from('matches').select('match_code').eq('tournament_id',match.tournament_id).eq('court_number',match.court_number).eq('status','playing').neq('id',matchId).limit(1).maybeSingle();
    if(other)return `Sân ${match.court_number} đang có trận ${other.match_code}.`;
  }
  return 'Sân vừa có trận khác bắt đầu. Vui lòng kiểm tra lại sân.';
}
