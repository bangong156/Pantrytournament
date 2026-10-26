import {createClient} from '@supabase/supabase-js';
const db=createClient('https://duuklzzxpegptsarcbqq.supabase.co','sb_publishable_FmGKX67AD3M4QvCuL3dSyg_w0X5vIX9');
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
let athletes=[],events=[];
function tab(type){$('listSection').classList.toggle('hidden',type!=='list');$('registerSection').classList.toggle('hidden',type!=='register');$('tabList').className=type==='list'?'':'secondary';$('tabRegister').className=type==='register'?'':'secondary'}
$('tabList').onclick=()=>tab('list');$('tabRegister').onclick=()=>tab('register');
async function load(){
 const [a,e]=await Promise.all([db.rpc('pantry_athlete_public_list'),db.rpc('pantry_open_registrations')]);
 if(a.error)$('athleteList').textContent='Không tải được danh sách: '+a.error.message;
 else{athletes=a.data||[];renderAthletes()}
 if(e.error)$('openEvents').textContent='Không tải được giải: '+e.error.message;
 else{
  events=e.data||[];
  $('openEvents').innerHTML=events.length?events.map(x=>'<label class="event"><input type="checkbox" name="event" value="'+esc(x.event_id)+'"> <b>'+esc(x.tournament)+'</b> · '+esc(x.event)+' · '+esc(x.date||'')+'</label>').join(''):'<p class="muted">Hiện chưa có giải ở trạng thái mở đăng ký.</p>';
  $('openEvents').querySelectorAll('input').forEach(i=>i.onchange=updatePartner);
 }
 $('partnerSelect').innerHTML='<option value="">-- Chọn partner --</option>'+athletes.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+' ('+esc(x.nickname)+')</option>').join('');
}
function renderAthletes(){
 const q=$('search').value.toLocaleLowerCase('vi').trim();
 const items=athletes.filter(a=>(a.name+' '+a.nickname).toLocaleLowerCase('vi').includes(q));
 $('athleteList').innerHTML=items.length?items.map(a=>'<div class="person"><img loading="lazy" src="'+esc(a.portrait)+'" alt="Ảnh '+esc(a.nickname)+'"><div><b>'+esc(a.name)+'</b> · '+esc(a.nickname)+'<small>PVNA: '+esc(a.pvna_rating??'Chưa có')+' · Tự chấm: '+esc(a.self_rating??'Chưa có')+'</small><small>Đã đăng ký '+(a.events?.length||0)+' nội dung</small></div></div>').join(''):'<p class="muted">Chưa có VĐV phù hợp.</p>';
}
$('search').oninput=renderAthletes;
function updatePartner(){$('partnerSection').classList.toggle('hidden',!document.querySelector('input[name=event]:checked'))}
$('newPartnerToggle').onchange=()=>{$('newPartnerFields').classList.toggle('hidden',!$('newPartnerToggle').checked);$('partnerSelect').disabled=$('newPartnerToggle').checked};
async function upload(file){
 if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>3145728)throw Error('Ảnh phải là JPG, PNG hoặc WEBP và không quá 3MB.');
 const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';
 const path=crypto.randomUUID()+'.'+ext;
 const {error}=await db.storage.from('pantry-athlete-portraits').upload(path,file,{contentType:file.type,upsert:false});
 if(error)throw error;
 return db.storage.from('pantry-athlete-portraits').getPublicUrl(path).data.publicUrl;
}
const fields=(form,prefix='')=>Object.fromEntries(['full_name','nickname','pvna_phone','pvna_rating','other_system','other_rating','self_rating'].map(k=>[k,form.elements.namedItem(prefix+k)?.value?.trim()||'']));
$('registerForm').onsubmit=async ev=>{
 ev.preventDefault();const form=ev.currentTarget,button=$('submitRegistration');$('message').textContent='';
 const checked=[...document.querySelectorAll('input[name=event]:checked')].map(x=>({event_id:x.value}));
 if(!checked.length){$('message').textContent='Vui lòng chọn ít nhất một giải.';return}
 const fresh=$('newPartnerToggle').checked,existing=$('partnerSelect').value;
 if(!fresh&&!existing){$('message').textContent='Vui lòng chọn partner hoặc đăng ký giúp partner.';return}
 button.disabled=true;button.textContent='Đang gửi…';
 try{
  const profile=fields(form);profile.portrait_url=await upload(form.elements.namedItem('portrait').files[0]);
  let partner=fresh?fields(form,'partner_'):{existing_id:existing};
  if(fresh){if(!partner.full_name||!partner.nickname||partner.pvna_phone.length<8)throw Error('Điền đủ thông tin partner.');partner.portrait_url=await upload(form.elements.namedItem('partner_portrait').files[0])}
  const {error}=await db.rpc('pantry_register_athlete',{p_profile:profile,p_entries:checked,p_partner:partner});
  if(error)throw error;
  form.reset();$('partnerSection').classList.add('hidden');$('newPartnerFields').classList.add('hidden');$('message').style.color='#2c7335';$('message').textContent='Đăng ký thành công!';await load();
 }catch(e){$('message').style.color='#ad382e';$('message').textContent='Đăng ký thất bại: '+e.message}
 finally{button.disabled=false;button.textContent='Gửi đăng ký'}
};
if(location.hash==='#register')tab('register');else tab('list');
load();
