const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const date=value=>new Date(value).toLocaleString('vi-VN');
const localDate=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
async function accountRequest(client,body){
  const {data:{session}}=await client.auth.getSession();
  if(!session)throw new Error('Vui lòng đăng nhập lại.');
  const response=await fetch('/.netlify/functions/organizer-accounts',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
function modal(title,content){
  const host=document.querySelector('#modal');
  host.innerHTML=`<div class="overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modalhead"><h2>${esc(title)}</h2><button class="x" type="button" aria-label="Đóng">×</button></div>${content}</section></div>`;
  host.querySelector('.x').onclick=()=>host.replaceChildren();return host.querySelector('section');
}
export async function mountGuestAccounts(client,host){
  host.innerHTML='<p>Đang tải tài khoản khách…</p>';
  const {data:accounts,error}=await client.rpc('admin_organizer_accounts');
  if(!host.isConnected)return;
  if(error){host.innerHTML=`<p role="alert">${esc(error.message)}</p>`;return}
  const refresh=()=>mountGuestAccounts(client,host);
  host.innerHTML=`<div class="toolbar"><h2>TÀI KHOẢN KHÁCH</h2><button data-create-guest>＋ TẠO TÀI KHOẢN KHÁCH</button></div><div class="cards">${accounts.map(a=>{
    const valid=a.is_active&&Date.parse(a.expires_at)>Date.now();
    return `<article class="card"><h3>${esc(a.display_name)}</h3><p>${esc(a.email)}</p><strong>${valid?'🟢 HOẠT ĐỘNG':a.is_active?'HẾT HẠN':'ĐÃ KHÓA'}</strong><p>Hết hạn: ${esc(date(a.expires_at))}</p><p>Tự tạo giải: ${a.can_create_tournaments?'CÓ':'KHÔNG'}</p><p>${a.owned_count} giải tự tạo · ${a.assigned_count} giải được gán</p><div class="actions"><button data-extend="${a.user_id}">GIA HẠN</button><button data-assign="${a.user_id}">GÁN GIẢI</button><button data-permissions="${a.user_id}">QUẢN LÝ QUYỀN</button><button class="danger" data-lock="${a.user_id}">${a.is_active?'KHÓA ACCOUNT':'MỞ KHÓA'}</button></div></article>`;
  }).join('')||'<p>Chưa có tài khoản khách.</p>'}</div><p role="alert" data-account-error></p>`;
  host.querySelector('[data-create-guest]').onclick=()=>createAccount(client,refresh);
  for(const a of accounts){
    host.querySelector(`[data-extend="${a.user_id}"]`).onclick=()=>editAccount(client,a,refresh,true);
    host.querySelector(`[data-permissions="${a.user_id}"]`).onclick=()=>editAccount(client,a,refresh,false);
    host.querySelector(`[data-assign="${a.user_id}"]`).onclick=()=>assignTournaments(client,a,refresh);
    host.querySelector(`[data-lock="${a.user_id}"]`).onclick=async e=>{
      if(a.is_active&&!confirm(`Khóa quyền vận hành của ${a.display_name}?`))return;
      e.target.disabled=true;
      const {error}=await client.from('organizer_accounts').update({is_active:!a.is_active}).eq('user_id',a.user_id);
      if(error){host.querySelector('[data-account-error]').textContent=error.message;e.target.disabled=false;return}
      await refresh();
    };
  }
}
function createAccount(client,refresh){
  const panel=modal('TẠO TÀI KHOẢN KHÁCH',`<form><label>Tên người/BTC<input name="display_name" required maxlength="160"></label><label>Email đăng nhập<input name="email" type="email" required autocomplete="off"></label><label>Mật khẩu<input name="password" type="password" required minlength="8" maxlength="256" autocomplete="new-password"></label><label>Ngày giờ hết hạn (giờ địa phương)<input name="expires_at" type="datetime-local" required></label><label><input name="can_create" type="checkbox" checked> Cho phép tự tạo giải</label><button>TẠO ACCOUNT</button><p role="alert"></p></form>`);
  const form=panel.querySelector('form');
  form.onsubmit=async e=>{
    e.preventDefault();const button=form.querySelector('button');button.disabled=true;
    const fd=new FormData(form),password=fd.get('password'),email=fd.get('email');
    try{
      const result=await accountRequest(client,{display_name:fd.get('display_name'),email,password,expires_at:new Date(fd.get('expires_at')).toISOString(),can_create_tournaments:fd.has('can_create')});
      form.innerHTML=`<p>✓ Đã tạo account</p><p>${esc(result.warning||'')}</p><label>Thông tin đăng nhập<textarea readonly rows="3"></textarea></label><button type="button">SAO CHÉP ĐĂNG NHẬP</button><p role="status"></p>`;
      const credentials=`Email: ${email}\nMật khẩu: ${password}`;form.querySelector('textarea').value=credentials;
      form.querySelector('button').onclick=async()=>{try{await navigator.clipboard.writeText(credentials);form.querySelector('[role=status]').textContent='Đã sao chép.'}catch{form.querySelector('textarea').select();form.querySelector('[role=status]').textContent='Chọn và sao chép thông tin đăng nhập.'}};
      await refresh();
    }catch(error){form.querySelector('[role=alert]').textContent=error.message;button.disabled=false}
  };
}
function editAccount(client,account,refresh,extend){
  const panel=modal(extend?'GIA HẠN':'QUẢN LÝ QUYỀN',`<form>${extend?`<p>${esc(account.display_name)}</p>`:`<label>Tên người/BTC<input name="name" required maxlength="160" value="${esc(account.display_name)}"></label>`}<label>Ngày giờ hết hạn (giờ địa phương)<input name="expires" type="datetime-local" required value="${localDate(account.expires_at)}"></label>${extend?'':`<label><input name="active" type="checkbox" ${account.is_active?'checked':''}> Account hoạt động</label><label><input name="create" type="checkbox" ${account.can_create_tournaments?'checked':''}> Cho phép tự tạo giải</label>`}<button>LƯU</button><p role="alert"></p></form>`);
  const form=panel.querySelector('form');
  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(form),button=form.querySelector('button');button.disabled=true;
    try{
      const patch={expires_at:new Date(fd.get('expires')).toISOString(),...(!extend?{display_name:fd.get('name').trim(),is_active:fd.has('active'),can_create_tournaments:fd.has('create')}:{})};
      const {error}=await client.from('organizer_accounts').update(patch).eq('user_id',account.user_id);if(error)throw error;
      if(!extend&&patch.is_active)await accountRequest(client,{action:'restore_login',user_id:account.user_id});
      document.querySelector('#modal').replaceChildren();await refresh();
    }catch(error){form.querySelector('[role=alert]').textContent=error.message;button.disabled=false}
  };
}
async function assignTournaments(client,account,refresh){
  const panel=modal('GÁN GIẢI',`<p>${esc(account.display_name)}</p><div data-assignment-list>Đang tải…</div><p role="alert"></p>`);
  const paint=async()=>{
    const [t,a]=await Promise.all([client.from('tournaments').select('id,name,owner_user_id').order('name'),client.from('tournament_organizer_assignments').select('tournament_id').eq('organizer_user_id',account.user_id)]);
    if(t.error||a.error)throw t.error||a.error;if(!panel.isConnected)return;
    const assigned=new Set(a.data.map(x=>x.tournament_id)),owned=t.data.filter(x=>x.owner_user_id===account.user_id),other=t.data.filter(x=>assigned.has(x.id));
    panel.querySelector('[data-assignment-list]').innerHTML=`<h3>GIẢI TỰ TẠO</h3><ul>${owned.map(x=>`<li>${esc(x.name)}</li>`).join('')||'<li>Chưa có</li>'}</ul><h3>GIẢI ĐƯỢC CHỈ ĐỊNH</h3><ul>${other.map(x=>`<li>${esc(x.name)} <button type="button" class="ghost" data-unassign="${x.id}">BỎ GÁN</button></li>`).join('')||'<li>Chưa có</li>'}</ul><form><label>Chọn giải hiện có<select name="tournaments" multiple required size="6">${t.data.filter(x=>x.owner_user_id!==account.user_id&&!assigned.has(x.id)).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label><button>GÁN GIẢI</button></form>`;
    panel.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
      try{const rows=new FormData(e.target).getAll('tournaments').map(id=>({tournament_id:id,organizer_user_id:account.user_id}));
        const {error}=await client.from('tournament_organizer_assignments').insert(rows);if(error)throw error;await paint();await refresh();
      }catch(error){panel.querySelector('[role=alert]').textContent=error.message;button.disabled=false}
    };
    panel.querySelectorAll('[data-unassign]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try{const {error}=await client.from('tournament_organizer_assignments').delete().eq('tournament_id',button.dataset.unassign).eq('organizer_user_id',account.user_id);if(error)throw error;await paint();await refresh()}
      catch(error){panel.querySelector('[role=alert]').textContent=error.message;button.disabled=false}
    });
  };
  try{await paint()}catch(error){panel.querySelector('[role=alert]').textContent=error.message}
}
