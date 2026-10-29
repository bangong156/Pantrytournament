import {createHash,randomBytes} from 'node:crypto';
export const hashToken=v=>createHash('sha256').update(v).digest('hex');
export const pkceChallenge=v=>createHash('sha256').update(v).digest('base64url');
export const validCapability=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
export async function arenaAllowed(server,userId,now=Date.now()){
 const {data:profile,error}=await server.from('profiles').select('role').eq('id',userId).maybeSingle();
 if(error)throw Error('Access lookup failed');
 const role=String(profile?.role||'').toLowerCase();
 if(['admin','staff'].includes(role))return true;
 if(role!=='organizer')return false;
 const account=await server.from('organizer_accounts').select('is_active,expires_at,can_create_tournaments').eq('user_id',userId).maybeSingle();
 if(account.error)throw Error('Access lookup failed');
 return Boolean(account.data?.is_active&&account.data.can_create_tournaments&&Date.parse(account.data.expires_at)>now);
}
export function createArenaHandler({makeServer,now=()=>Date.now(),random=()=>randomBytes(32).toString('base64url')}){
 return async event=>{
  const reply=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)});
  try{
   if(event.httpMethod!=='POST')return reply(405,{error:'Method not allowed'});
   const raw=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):event.body||'';
   if(Buffer.byteLength(raw)>4096)return reply(413,{error:'Request too large'});
   let body;try{body=JSON.parse(raw)}catch{return reply(400,{error:'Invalid request'})}
   const server=makeServer(),stamp=new Date(now()).toISOString();
   if(body.action==='authorize'){
    if((event.headers?.origin||event.headers?.Origin)!=='https://giaipantry.com')return reply(403,{error:'Hãy mở từ giaipantry.com.'});
    const token=/^Bearer (\S+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1];
    if(!token)return reply(401,{error:'Vui lòng đăng nhập tại giaipantry.com.'});
    if(!validCapability(body.challenge))return reply(400,{error:'Invalid challenge'});
    const {data,error}=await server.auth.getUser(token);
    if(error||!data?.user)return reply(401,{error:'Phiên đăng nhập không hợp lệ.'});
    if(!await arenaAllowed(server,data.user.id,now()))return reply(403,{error:'Tài khoản chưa có quyền tạo Đấu Trường.'});
    // Bound capability accumulation and prune expired grants on the server.
    const expired=await server.from('arena_access_codes').delete().lte('expires_at',stamp);if(expired.error)throw expired.error;
    const recent=await server.from('arena_access_codes').select('code_hash',{count:'exact',head:true}).eq('user_id',data.user.id).gt('created_at',new Date(now()-60000).toISOString());
    if(recent.error)throw recent.error;if(recent.count>=10)return reply(429,{error:'Bạn thao tác quá nhanh. Thử lại sau một phút.'});
    const code=random(),expires=new Date(now()+60000).toISOString();
    const saved=await server.from('arena_access_codes').insert({code_hash:hashToken(code),challenge:body.challenge,user_id:data.user.id,expires_at:expires});
    if(saved.error)throw saved.error;
    return reply(200,{code});
   }
   if(body.action==='redeem'){
    if(!validCapability(body.code)||!validCapability(body.verifier))return reply(400,{error:'Invalid capability'});
    // DELETE RETURNING is atomic: concurrent redemption can succeed only once.
    const grant=await server.from('arena_access_codes').delete().eq('code_hash',hashToken(body.code)).eq('challenge',pkceChallenge(body.verifier)).gt('expires_at',stamp).select('user_id').maybeSingle();
    if(grant.error)throw grant.error;if(!grant.data)return reply(401,{error:'Mã chuyển tiếp đã hết hạn hoặc đã sử dụng.'});
    if(!await arenaAllowed(server,grant.data.user_id,now()))return reply(403,{error:'Quyền truy cập đã bị thu hồi.'});
    const identity=await server.auth.admin.getUserById(grant.data.user_id);
    if(identity.error||!identity.data.user||Date.parse(identity.data.user.banned_until||'')>now())return reply(403,{error:'Tài khoản không hoạt động.'});
    const token=random(),expires=new Date(now()+12*60*60*1000).toISOString();
    const saved=await server.from('arena_access_sessions').insert({token_hash:hashToken(token),user_id:grant.data.user_id,expires_at:expires});if(saved.error)throw saved.error;
    await server.from('arena_access_sessions').delete().lte('expires_at',stamp);
    return reply(200,{token,expires_at:expires});
   }
   if(body.action==='session'||body.action==='logout'){
    if(!validCapability(body.token))return reply(401,{error:'Invalid session'});
    const query=server.from('arena_access_sessions');
    if(body.action==='logout'){const result=await query.delete().eq('token_hash',hashToken(body.token));if(result.error)throw result.error;return reply(200,{ok:true})}
    const session=await query.select('user_id,expires_at').eq('token_hash',hashToken(body.token)).gt('expires_at',stamp).maybeSingle();
    if(session.error)throw session.error;if(!session.data||!await arenaAllowed(server,session.data.user_id,now()))return reply(401,{error:'Phiên không hợp lệ hoặc đã hết hạn.'});
    const user=await server.auth.admin.getUserById(session.data.user_id);
    if(user.error)throw user.error;if(!user.data.user||Date.parse(user.data.user.banned_until||'')>now())return reply(401,{error:'Tài khoản không hoạt động.'});
    return reply(200,{valid:true,expires_at:session.data.expires_at});
   }
   return reply(400,{error:'Invalid action'});
  }catch{return reply(503,{error:'Không thể xác minh quyền truy cập. Vui lòng thử lại.'})}
 };
}
