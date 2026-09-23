import {videoRepository} from '../../server/video-repository.js';
import {cloudflareStream} from '../../server/cloudflare-stream.js';
import {requireVideoMatch,requireVideoSessionMatch} from '../../server/video-match.js';
import {VideoError,validUUID,cloudflareURL} from '../../server/video-security.js';

// Public reads never return invitation tokens or publishing credentials.
export async function handler(event){
  const reply=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(statusCode===405?{Allow:'GET'}:{})},body:JSON.stringify(body)});
  try{
    if(event.httpMethod!=='GET')return reply(405,{error:'Chỉ hỗ trợ GET.'});
    const {tournament_id,event_id,match_id}=event.queryStringParameters||{};
    if(!validUUID(tournament_id)||!validUUID(event_id)||(match_id!==undefined&&!validUUID(match_id)))throw new VideoError(400,'Thông tin trận đấu không hợp lệ.');
    const env=process.env;
    if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new VideoError(503,'LIVE chưa được cấu hình.');
    const repository=videoRepository({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY});
    const stream=cloudflareStream({accountId:env.CLOUDFLARE_ACCOUNT_ID,apiToken:env.CLOUDFLARE_API_TOKEN});
    if(match_id){
      const match=await requireVideoMatch(repository,match_id);
      if(match.event_id!==event_id||match.tournament_id!==tournament_id)throw new VideoError(404,'Trận đấu không thuộc nội dung này.');
    }
    const rows=(await repository.eventRows(event_id)).filter(row=>row.tournament_id===tournament_id&&(!match_id||row.match_id===match_id)&&['connecting','live'].includes(row.status)&&Date.parse(row.hard_expires_at)>Date.now()&&Date.parse(row.lease_expires_at)>Date.now());
    const streams=await Promise.all(rows.map(async row=>{
      try{await requireVideoSessionMatch(repository,row);}catch(error){if([400,404,409].includes(error.status))return null;throw error;}
      if(!await stream.active(row.input_uid))return null;
      // Recheck after the provider request so a stopped/replaced session is not advertised.
      const current=await repository.get(row.id);
      if(!current||!['connecting','live'].includes(current.status)||current.input_uid!==row.input_uid||!(Date.parse(current.lease_expires_at)>Date.now())||!(Date.parse(current.hard_expires_at)>Date.now()))return null;
      try{await requireVideoSessionMatch(repository,current);}catch(error){if([400,404,409].includes(error.status))return null;throw error;}
      const playback=cloudflareURL(row.playback_url,{suffix:'/webRTC/play'});
      return {match_id:row.match_id,session_id:row.id,...(match_id?{playback_url:playback}:{})};
    }));
    return reply(200,{streams:streams.filter(Boolean)});
  }catch(error){return reply(error instanceof VideoError?error.status:503,{error:error instanceof VideoError?error.message:'Không thể kiểm tra video LIVE lúc này.'});}
}
