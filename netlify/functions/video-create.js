import {randomUUID} from 'node:crypto';
import {videoRepository} from '../../server/video-repository.js';
import {cloudflareStream} from '../../server/cloudflare-stream.js';
import {requireVideoMatch,requireVideoSessionMatch} from '../../server/video-match.js';
import {VideoError,capability,digest,secretBox} from '../../server/video-security.js';

export function dependencies(){
  const env=process.env;
  const invalid=name=>{console.error(name);throw new VideoError(503,'LIVE chưa được cấu hình.');};
  if(!env.SUPABASE_URL)invalid('SUPABASE_URL');
  if(!env.SUPABASE_SERVICE_ROLE_KEY)invalid('SUPABASE_SERVICE_ROLE_KEY');
  return {
    repository:videoRepository({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY}),
    stream:(()=>{
      if(!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID||''))invalid('CLOUDFLARE_ACCOUNT_ID');
      if(!env.CLOUDFLARE_API_TOKEN)invalid('CLOUDFLARE_API_TOKEN');
      return cloudflareStream({accountId:env.CLOUDFLARE_ACCOUNT_ID,apiToken:env.CLOUDFLARE_API_TOKEN});
    })(),
    box:(()=>{
      if(Buffer.from(env.VIDEO_ENCRYPTION_KEY||'','base64').length!==32)invalid('VIDEO_ENCRYPTION_KEY');
      return secretBox(env.VIDEO_ENCRYPTION_KEY);
    })()
  };
}

export function createHandler(getDependencies=dependencies){
  return async event=>{
    let operation;
    const logFailure=(operation,error)=>{
      const details={operation};
      if(Number.isInteger(error?.status)&&error.status>=100&&error.status<=599)details.status=error.status;
      if(operation==='Cloudflare'&&Number.isSafeInteger(error?.cloudflareCode))details.cloudflare_code=error.cloudflareCode;
      console.error(details);
    };
    const reply=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(statusCode===405?{Allow:'POST'}:{})},body:JSON.stringify(body)});
    try{
      if(event.httpMethod!=='POST')return reply(405,{error:'Chỉ hỗ trợ POST.'});
      const authorization=event.headers?.authorization||event.headers?.Authorization||'';
      const token=/^Bearer (\S+)$/i.exec(authorization)?.[1];
      if(!token){operation='authentication';throw new VideoError(401,'Vui lòng đăng nhập lại.');}
      const body=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):event.body||'';
      if(Buffer.byteLength(body)>4096)throw new VideoError(413,'Yêu cầu quá lớn.');
      let payload;
      try{payload=JSON.parse(body);}catch{throw new VideoError(400,'Yêu cầu không hợp lệ.');}
      const {repository,stream,box}=getDependencies();
      operation='authentication';
      const userId=await repository.staff(token);
      operation='database';
      await repository.rate(`video-create:${userId}`,10);
      const match=await requireVideoMatch(repository,payload?.match_id);
      const now=Date.now(),invite=capability();
      const row=await repository.insert({
        id:randomUUID(),match_id:match.id,event_id:match.event_id,tournament_id:match.tournament_id,
        created_by:userId,status:'creating',invite_hash:digest(invite),
        invite_expires_at:new Date(now+10*60000).toISOString(),
        hard_expires_at:new Date(now+4*3600000).toISOString(),
        cleanup_after:new Date(now+60000).toISOString()
      });
      let input;
      try{
        operation='Cloudflare';
        input=await stream.create(row);
        operation='database';
        await requireVideoSessionMatch(repository,row);
        const ready=await repository.cas(row,{
          status:'ready',input_uid:input.uid,credentials_ciphertext:box.seal({publish:input.publish}),
          playback_url:input.playback,cleanup_after:row.invite_expires_at
        });
        if(!ready)throw new VideoError(409,'Phiên LIVE đã thay đổi. Vui lòng thử lại.');
        return reply(201,{session_id:ready.id,status:ready.status,invite_token:invite,invite_expires_at:ready.invite_expires_at,
          broadcaster_url:`/?broadcaster=1#session=${ready.id}&token=${invite}`});
      }catch(error){
        // Keep uncertain provider creations reserved for reconciliation. Never
        // release the active-match slot before a known input has been deleted.
        if(input){
          let removed=false;
          try{await stream.remove(input.uid);removed=true;}catch(error){logFailure('Cloudflare',error);}
          try{
            const current=await repository.get(row.id);
            if(current&&['creating','ready'].includes(current.status)){
              await repository.cas(current,removed?{
                status:'ended',ended_at:new Date().toISOString(),credentials_ciphertext:null,playback_url:null
              }:{status:'stopping',input_uid:input.uid,cleanup_after:new Date().toISOString()});
            }
          }catch(error){logFailure('database',error);}
        }
        throw error;
      }
    }catch(error){
      if(operation)logFailure(operation,error);
      return reply(error instanceof VideoError?error.status:503,{error:error instanceof VideoError?error.message:'Không thể tạo phiên LIVE. Vui lòng thử lại.'});
    }
  };
}

export const handler=createHandler();
