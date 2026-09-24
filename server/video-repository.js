import {createClient} from '@supabase/supabase-js';
import {VideoError,digest} from './video-security.js';
export function videoRepository({url,key}){
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const check=({data,error,status},operation)=>{
    if(error){
      if(operation)console.error({operation,code:error.code,...(typeof status==='number'?{status}:{})});
      throw new VideoError(error.code==='23505'?409:503,error.code==='23505'?'Trận này đã có phiên LIVE. Hãy kết thúc phiên cũ trước.':'Không thể truy cập dịch vụ LIVE.');
    }
    return data;
  };
  return {
    async staff(token){
      const {data,error}=await db.auth.getUser(token);
      if(error||!data?.user)throw new VideoError(401,'Vui lòng đăng nhập lại.');
      const result=await db.from('profiles').select('role').eq('id',data.user.id).maybeSingle();
      if(result.error)console.error({code:result.error.code,status:result.status});
      const p=check(result);
      if(!['admin','staff'].includes(String(p?.role).toLowerCase()))throw new VideoError(403,'Chỉ Admin / Staff được quản lý LIVE.');
      return data.user.id;
    },
    async rate(key,limit){if(!check(await db.rpc('match_video_take_rate',{p_key:digest(key),p_limit:limit}),'rate'))throw new VideoError(429,'Quá nhiều yêu cầu. Vui lòng đợi một phút.');},
    async match(id){return check(await db.from('matches').select('id,event_id,tournament_id,match_code,team1_id,team2_id').eq('id',id).maybeSingle(),'match');},
    async get(id){return check(await db.from('match_video_sessions').select('*').eq('id',id).maybeSingle(),'cleanup');},
    async activeMatch(id){return check(await db.from('match_video_sessions').select('*').eq('match_id',id).neq('status','ended').maybeSingle(),'cleanup');},
    async insert(row){return check(await db.from('match_video_sessions').insert(row).select().single(),'insert');},
    async cas(row,patch){return check(await db.from('match_video_sessions').update({...patch,version:row.version+1}).eq('id',row.id).eq('version',row.version).eq('status',row.status).select().maybeSingle(),'cas');},
    async liveRows(){return check(await db.from('match_video_sessions').select('*').eq('status','live').gt('lease_expires_at',new Date().toISOString()).gt('hard_expires_at',new Date().toISOString()));},
    async publicMatchDetails(match){
      const [tournament,event,teams,court]=await Promise.all([
        db.from('tournaments').select('name').eq('id',match.tournament_id).maybeSingle(),
        db.from('tournament_events').select('name').eq('id',match.event_id).eq('tournament_id',match.tournament_id).maybeSingle(),
        db.from('teams').select('id,name').eq('event_id',match.event_id).in('id',[match.team1_id,match.team2_id].filter(Boolean)),
        db.from('matches').select('court_number').eq('id',match.id).eq('event_id',match.event_id).eq('tournament_id',match.tournament_id).maybeSingle()
      ]);
      const t=check(tournament),e=check(event),names=check(teams)||[];
      if(!t||!e)return null;
      return {tournament_name:t.name,event_name:e.name,match_code:match.match_code,court_number:check(court)?.court_number??null,
        team_a:names.find(team=>team.id===match.team1_id)?.name||'TBD',team_b:names.find(team=>team.id===match.team2_id)?.name||'TBD'};
    },
    async eventRows(id){return check(await db.from('match_video_sessions').select('*').eq('event_id',id).neq('status','ended').limit(100));},
    async due(now){return check(await db.from('match_video_sessions').select('*').neq('status','ended').lte('cleanup_after',now).order('cleanup_after').limit(12),'cleanup');},
    async prune(now){check(await db.from('match_video_rate_limits').delete().lt('window_start',new Date(now-86400000).toISOString()),'cleanup');}
  };
}
