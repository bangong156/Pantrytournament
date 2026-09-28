import {createClient} from '@supabase/supabase-js';

// Same server-only Supabase credentials and bearer-token authentication as LIVE.
// No service key or password is returned to the browser or written to app tables.
export async function handler(event){
  const reply=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)});
  try{
    if(event.httpMethod!=='POST')return reply(405,{error:'Chỉ hỗ trợ POST.'});
    const token=/^Bearer (\S+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1];
    if(!token)return reply(401,{error:'Vui lòng đăng nhập lại.'});
    const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key}=process.env;
    if(!url||!key)return reply(503,{error:'Dịch vụ tài khoản khách chưa được cấu hình.'});
    const auth={persistSession:false,autoRefreshToken:false};
    const server=createClient(url,key,{auth});
    const {data:identity,error:identityError}=await server.auth.getUser(token);
    if(identityError||!identity?.user)return reply(401,{error:'Vui lòng đăng nhập lại.'});
    const caller=createClient(url,key,{auth,global:{headers:{Authorization:`Bearer ${token}`}}});
    const {data:accounts,error:adminError}=await caller.rpc('admin_organizer_accounts');
    if(adminError)return reply(adminError.code==='42501'?403:503,{error:adminError.message});
    const raw=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString('utf8'):event.body||'';
    if(Buffer.byteLength(raw)>8192)return reply(413,{error:'Yêu cầu quá lớn.'});
    let body;try{body=JSON.parse(raw);}catch{return reply(400,{error:'Yêu cầu không hợp lệ.'});}
    // Retry login activation if Auth was unavailable after successful provisioning.
    if(body.action==='restore_login'){
      const account=accounts.find(a=>a.user_id===body.user_id);
      if(!account)return reply(404,{error:'Không tìm thấy tài khoản khách.'});
      const {error}=await server.auth.admin.updateUserById(account.user_id,{ban_duration:'none'});
      return error?reply(503,{error:error.message}):reply(200,{user_id:account.user_id});
    }
    const name=String(body.display_name||'').trim(),email=String(body.email||'').trim();
    const expires=new Date(body.expires_at);
    if(!name||name.length>160||!/^\S+@\S+\.\S+$/.test(email)||typeof body.password!=='string'||body.password.length<8||body.password.length>256||!Number.isFinite(expires.getTime())||expires<=new Date()||typeof body.can_create_tournaments!=='boolean'){
      return reply(400,{error:'Nhập tên, email hợp lệ, mật khẩu từ 8 ký tự và ngày giờ hết hạn trong tương lai.'});
    }
    const {data,error}=await server.auth.admin.createUser({email,password:body.password,email_confirm:true,ban_duration:'876000h',user_metadata:{full_name:name}});
    if(error)return reply(400,{error:error.message});
    const userId=data.user.id;
    const {error:registerError}=await caller.rpc('admin_register_organizer',{p_user:userId,p_name:name,p_expires:expires.toISOString(),p_can_create:body.can_create_tournaments});
    if(registerError){
      // Only this just-created, still-banned user is eligible for cleanup.
      const {error:cleanupError}=await server.auth.admin.deleteUser(userId);
      return reply(503,{error:registerError.message+(cleanupError?' Tài khoản đăng nhập đang khóa chưa được dọn; liên hệ Pantry Admin.':'')});
    }
    const {error:activateError}=await server.auth.admin.updateUserById(userId,{ban_duration:'none'});
    return reply(201,{user_id:userId,email,warning:activateError?'Account đã tạo nhưng đăng nhập còn khóa. Mở QUẢN LÝ QUYỀN và lưu lại để kích hoạt đăng nhập.':null});
  }catch{return reply(503,{error:'Không thể kết nối dịch vụ tài khoản khách. Vui lòng thử lại.'});}
}
