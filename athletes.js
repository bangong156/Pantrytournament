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
$('partnerLater').onchange=()=>{const later=$('partnerLater').checked;$('partnerNow').classList.toggle('hidden',later);$('partnerSelect').required=!later&&!$('newPartnerToggle').checked};
$('newPartnerToggle').onchange=()=>{$('newPartnerFields').classList.toggle('hidden',!$('newPartnerToggle').checked);$('partnerSelect').disabled=$('newPartnerToggle').checked};
async function upload(file){
 if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>3145728)throw Error('Ảnh phải là JPG, PNG hoặc WEBP và không quá 3MB.');
 const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';
 const path=crypto.randomUUID()+'.'+ext;
 const {error}=await db.storage.from('pantry-athlete-portraits').upload(path,file,{contentType:file.type,upsert:false});
 if(error)throw error;
 return db.storage.from('pantry-athlete-portraits').getPublicUrl(path).data.publicUrl;
}
function bindRating(prefix=''){
 const form=$('registerForm'),name=k=>form.elements.namedItem(prefix+k);
 const select=name('other_system'),rating=name('other_rating'),noPvna=name('no_pvna'),phone=name('pvna_phone'),pvna=name('pvna_rating');
 const updateSystem=()=>{const absent=select.value==='Không có';rating.disabled=absent;rating.required=!absent;if(absent)rating.value='';rating.placeholder=absent?'Không áp dụng':'Nhập điểm *'};
 const updatePvna=()=>{const absent=noPvna.checked;phone.disabled=absent;phone.required=!absent;pvna.disabled=absent;if(absent){phone.value='';pvna.value=''}};
 select.addEventListener('change',updateSystem);noPvna.addEventListener('change',updatePvna);updateSystem();updatePvna();
}
bindRating();bindRating('partner_');
const PVNA_ENDPOINT='https://duuklzzxpegptsarcbqq.supabase.co/functions/v1/pvna-phone-search';
const PVNA_KEY='sb_publishable_FmGKX67AD3M4QvCuL3dSyg_w0X5vIX9';
function setupPvnaLookup(prefix='',statusId='pvnaLookupStatus'){
 const form=$('registerForm'),phone=form.elements.namedItem(prefix+'pvna_phone'),rating=form.elements.namedItem(prefix+'pvna_rating'),noPvna=form.elements.namedItem(prefix+'no_pvna'),status=$(statusId);
 let timer,sequence=0;
 const normalized=v=>{let n=String(v||'').replace(/[\s().-]/g,'');if(n.startsWith('+84'))n='0'+n.slice(3);else if(n.startsWith('84')&&n.length===11)n='0'+n.slice(2);return n};
 const run=async()=>{
  const id=++sequence,num=normalized(phone.value);
  rating.value='';
  if(noPvna.checked){status.textContent='Đã chọn Chưa có PVNA.';return}
  if(!/^0[35789]\d{8}$/.test(num)){status.textContent='Nhập đủ 10 số để tra cứu PVNA.';return}
  status.textContent='Đang tra cứu PVNA…';
  try{
   const response=await fetch(PVNA_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','apikey':PVNA_KEY},body:JSON.stringify({phone:num})});
   const result=await response.json();if(id!==sequence)return;
   if(!response.ok)throw Error(result.error||'Không kết nối được PVNA');
   const players=result.players||[];
   if(players.length!==1){status.textContent=players.length?'Có nhiều hồ sơ trùng SĐT; vui lòng kiểm tra.':'Không tìm thấy hồ sơ PVNA khớp SĐT.';return}
   const player=players[0],score=player.doubleScore;
   if(score!=null&&Number.isFinite(Number(score))){rating.value=String(score);status.textContent='✓ PVNA: '+player.name+' · Điểm đôi: '+score}
   else status.textContent='Tìm thấy '+player.name+' nhưng chưa có điểm PVNA.';
  }catch(e){if(id===sequence)status.textContent='Không tra cứu được: '+e.message}
 };
 phone.addEventListener('input',()=>{clearTimeout(timer);sequence++;rating.value='';status.textContent='Đang chờ nhập đủ SĐT…';timer=setTimeout(run,550)});
 phone.addEventListener('blur',()=>{clearTimeout(timer);void run()});
 noPvna.addEventListener('change',()=>{clearTimeout(timer);sequence++;rating.value='';status.textContent=noPvna.checked?'Đã chọn Chưa có PVNA.':'Nhập SĐT để tự động tra cứu PVNA.'});
}
setupPvnaLookup();setupPvnaLookup('partner_','partnerPvnaLookupStatus');
const fields=(form,prefix='')=>Object.fromEntries(['full_name','nickname','pvna_phone','pvna_rating','other_system','other_rating','self_rating'].map(k=>[k,form.elements.namedItem(prefix+k)?.value?.trim()||'']));
$('registerForm').onsubmit=async ev=>{
 ev.preventDefault();const form=ev.currentTarget,button=$('submitRegistration');$('message').textContent='';
 const checked=[...document.querySelectorAll('input[name=event]:checked')].map(x=>({event_id:x.value}));
 if(!checked.length){$('message').textContent='Vui lòng chọn ít nhất một giải.';return}
 const later=$('partnerLater').checked,fresh=!later&&$('newPartnerToggle').checked,existing=later?'':$('partnerSelect').value;
 if(!later&&!fresh&&!existing){$('message').textContent='Vui lòng chọn partner, đăng ký giúp partner hoặc chọn Thêm Partner sau.';return}
 button.disabled=true;button.textContent='Đang gửi…';
 try{
  const profile=fields(form);if(form.elements.namedItem('no_pvna').checked)profile.pvna_phone='Chưa có PVNA';profile.portrait_url=await upload(form.elements.namedItem('portrait').files[0]);
  let partner=later?null:fresh?fields(form,'partner_'):{existing_id:existing};
  if(fresh){if(form.elements.namedItem('partner_no_pvna').checked)partner.pvna_phone='Chưa có PVNA';if(!partner.other_system||partner.other_system!=='Không có'&&!partner.other_rating)throw Error('Vui lòng chọn hệ thống điểm và nhập điểm partner (hoặc chọn Không có).');if(!partner.full_name||!partner.nickname||partner.pvna_phone.length<8)throw Error('Điền đủ thông tin partner.');partner.portrait_url=await upload(form.elements.namedItem('partner_portrait').files[0])}
  const {error}=await db.rpc('pantry_register_athlete',{p_profile:profile,p_entries:checked,p_partner:partner});
  if(error)throw error;
  form.reset();$('partnerNow').classList.remove('hidden');for(const p of ['','partner_']){const sys=form.elements.namedItem(p+'other_system'),score=form.elements.namedItem(p+'other_rating'),phone=form.elements.namedItem(p+'pvna_phone'),pvna=form.elements.namedItem(p+'pvna_rating');score.disabled=false;score.required=!p;phone.disabled=false;phone.required=!p;pvna.disabled=false;sys.value='';} $('partnerSection').classList.add('hidden');$('newPartnerFields').classList.add('hidden');$('message').style.color='#2c7335';$('message').textContent='Đăng ký thành công!';await load();
 }catch(e){$('message').style.color='#ad382e';$('message').textContent='Đăng ký thất bại: '+e.message}
 finally{button.disabled=false;button.textContent='Gửi đăng ký'}
};
if(location.hash==='#register')tab('register');else tab('list');
load();
