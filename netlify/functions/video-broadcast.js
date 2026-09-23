import {dependencies} from './video-create.js';
import {requireVideoSessionMatch} from '../../server/video-match.js';
import {VideoError,matchesToken,validUUID} from '../../server/video-security.js';

export async function handler(event){
  const reply=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(statusCode===405?{Allow:'POST'}:{})},body:JSON.stringify(body)});
  try{
    if(event.httpMethod!=='POST')return reply(405,{error:'Chỉ hỗ trợ POST.'});
    const raw=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):event.body||'';
    if(Buffer.byteLength(raw)>110000)throw new VideoError(413,'Yêu cầu quá lớn.');
    let body;try{body=JSON.parse(raw);}catch{throw new VideoError(400,'Yêu cầu không hợp lệ.');}
    if(!validUUID(body?.session_id)||!['start','stop','heartbeat'].includes(body?.action))throw new VideoError(400,'Yêu cầu không hợp lệ.');
    const {repository,stream,box}=dependencies();
    const row=await repository.get(body.session_id);
    if(!row||!matchesToken(body.token,row.invite_hash))throw new VideoError(403,'Liên kết LIVE không hợp lệ.');
    await repository.rate(`video-broadcast:${row.id}`,20);
    if(body.action==='heartbeat'){
      if(!['connecting','live'].includes(row.status)||!(Date.parse(row.lease_expires_at)>Date.now())||!(Date.parse(row.hard_expires_at)>Date.now()))throw new VideoError(410,'Phiên LIVE đã hết hạn. Hãy tạo QR mới.');
      await requireVideoSessionMatch(repository,row);
      const expires=new Date(Math.min(Date.now()+60000,Date.parse(row.hard_expires_at))).toISOString();
      if(!await repository.cas(row,{status:'live',lease_expires_at:expires,cleanup_after:expires}))throw new VideoError(409,'Phiên LIVE đã thay đổi.');
      return reply(200,{lease_expires_at:expires});
    }
    if(body.action==='stop'){
      if(row.status==='ended')return reply(200,{status:'ended'});
      if(!['ready','connecting','live','stopping'].includes(row.status))throw new VideoError(409,'Phiên LIVE đang xử lý. Vui lòng thử lại.');
      const stopping=await repository.cas(row,{status:'stopping',cleanup_after:new Date().toISOString()});
      if(!stopping)throw new VideoError(409,'Phiên LIVE đã thay đổi. Vui lòng thử lại.');
      await stream.remove(stopping.input_uid);
      if(!await repository.cas(stopping,{status:'ended',ended_at:new Date().toISOString(),credentials_ciphertext:null,playback_url:null}))throw new VideoError(409,'Vui lòng thử kết thúc LIVE lại.');
      return reply(200,{status:'ended'});
    }
    if(row.status!=='ready')throw new VideoError(409,'QR này đã được sử dụng hoặc phiên LIVE đã kết thúc.');
    if(Date.parse(row.invite_expires_at)<=Date.now()||Date.parse(row.hard_expires_at)<=Date.now())throw new VideoError(410,'QR đã hết hạn. Hãy nhờ quản trị viên tạo phiên mới.');
    if(typeof body.sdp!=='string'||body.sdp.length>100000||!body.sdp.startsWith('v=0'))throw new VideoError(400,'Không thể đọc kết nối camera.');
    await requireVideoSessionMatch(repository,row);
    const publishing=await repository.cas(row,{status:'publishing',cleanup_after:new Date(Date.now()+60000).toISOString()});
    if(!publishing)throw new VideoError(409,'QR này đang được sử dụng.');
    try{
      const credentials=box.open(publishing.credentials_ciphertext);
      const result=await stream.publish(credentials.publish,body.sdp);
      await requireVideoSessionMatch(repository,publishing);
      const expires=new Date(Math.min(Date.now()+60000,Date.parse(row.hard_expires_at))).toISOString();
      const connecting=await repository.cas(publishing,{status:'connecting',credentials_ciphertext:box.seal({...credentials,session:result.session}),lease_expires_at:expires,cleanup_after:expires});
      if(!connecting)throw new VideoError(409,'Phiên LIVE đã thay đổi.');
      return reply(200,{sdp:result.answer,hard_expires_at:row.hard_expires_at});
    }catch(error){
      // Deleting the input also terminates an uncertain WHIP connection.
      try{
        const stopping=await repository.cas(publishing,{status:'stopping',cleanup_after:new Date().toISOString()});
        if(stopping){
          await stream.remove(stopping.input_uid);
          await repository.cas(stopping,{status:'ended',ended_at:new Date().toISOString(),credentials_ciphertext:null,playback_url:null});
        }
      }catch{}
      throw error;
    }
  }catch(error){return reply(error instanceof VideoError?error.status:503,{error:error instanceof VideoError?error.message:'Không thể kết nối LIVE. Vui lòng thử lại.'});}
}
