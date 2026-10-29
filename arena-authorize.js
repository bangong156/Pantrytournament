import {createClient} from '@supabase/supabase-js';
const status=document.getElementById('arenaStatus');
const params=new URLSearchParams(location.search),state=params.get('state'),challenge=params.get('code_challenge');
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
(async()=>{
 try{
  if(!valid(state)||!valid(challenge))throw Error('Hãy mở từ Tạo → Tạo Đấu Trường tại giaipantry.com.');
  const db=createClient('https://duuklzzxpegptsarcbqq.supabase.co','sb_publishable_FmGKX67AD3M4QvCuL3dSyg_w0X5vIX9');
  const {data:{session},error}=await db.auth.getSession();
  if(error||!session)throw Error('Vui lòng về giaipantry.com đăng nhập, rồi chọn Tạo → Tạo Đấu Trường.');
  const res=await fetch('/.netlify/functions/arena-access',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},body:JSON.stringify({action:'authorize',challenge}),cache:'no-store'});
  const body=await res.json();if(!res.ok||!valid(body.code))throw Error(body.error||'Không thể mở Đấu Trường.');
  const next=new URL('https://dautruongsua.xyz/private-arena/callback');next.searchParams.set('code',body.code);next.searchParams.set('state',state);location.replace(next.href);
 }catch(error){status.textContent=error.message}
})();
