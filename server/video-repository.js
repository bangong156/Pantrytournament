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
    async match(id){return check(await db.from('matches').select('id,event_id,tournament_id,match_code').eq('id',id).maybeSingle(),'match');},
    async get(id){return check(await db.from('match_video_sessions').select('*').eq('id',id).maybeSingle(),'cleanup');},
    async activeMatch(id){return check(await db.from('match_video_sessions').select('*').eq('match_id',id).neq('status','ended').maybeSingle(),'cleanup');},
    async insert(row){return check(await db.from('match_video_sessions').insert(row).select().single(),'insert');},
    async cas(row,patch){return check(await db.from('match_video_sessions').update({...patch,version:row.version+1}).eq('id',row.id).eq('version',row.version).eq('status',row.status).select().maybeSingle(),'cas');},
    async eventRows(id){return check(await db.from('match_video_sessions').select('*').eq('event_id',id).neq('status','ended').limit(100));},
    async due(now){return check(await db.from('match_video_sessions').select('*').neq('status','ended').lte('cleanup_after',now).order('cleanup_after').limit(12),'cleanup');},
    async prune(now){check(await db.from('match_video_rate_limits').delete().lt('window_start',new Date(now-86400000).toISOString()),'cleanup');}
  };
}
