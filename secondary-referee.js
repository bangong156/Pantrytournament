import './secondary-referee.css';

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

export function secondaryRefereeControls(state,{groupId='',error=null}={}){
 if(state?.is_secondary)return '';
 const enabled=state?.enabled===true,code=escapeHtml(state?.code);
 return `<section class="ref-secondary" data-secondary-group="${escapeHtml(groupId)}"><b>TRỌNG TÀI PHỤ</b>${error?`<p role="alert">Không thể tải mã phụ: ${escapeHtml(error.message)}</p>`:`<p>Mã phụ: ${enabled?`<strong>${code}</strong> · ĐANG BẬT`:'CHƯA KÍCH HOẠT'}</p><div class="ref-admin-actions">${enabled?'<button class="ghost" data-secondary-copy>SAO CHÉP MÃ</button><button class="secondary" data-secondary-action="regenerate">TẠO MÃ MỚI</button><button class="danger" data-secondary-action="disable">TẮT TRỌNG TÀI PHỤ</button>':'<button class="secondary" data-secondary-action="activate">KÍCH HOẠT</button>'}</div>`}<span role="status" data-secondary-feedback></span></section>`;
}

export function bindSecondaryRefereeControls(root,{client,tournamentId,sessionToken=null,onChanged}){
 root.querySelectorAll('[data-secondary-group]').forEach(section=>{
  section.querySelector('[data-secondary-copy]')?.addEventListener('click',async()=>{
   const feedback=section.querySelector('[data-secondary-feedback]');
   try{await navigator.clipboard.writeText(section.querySelector('strong').textContent);feedback.textContent='✓ Đã sao chép';}
   catch{feedback.textContent='Không thể sao chép. Vui lòng sao chép mã thủ công.';}
  });
  section.querySelectorAll('[data-secondary-action]').forEach(button=>button.addEventListener('click',async()=>{
   section.querySelectorAll('button').forEach(b=>b.disabled=true);
   const {error}=await client.rpc('manage_secondary_referee_code',{p_tournament_id:tournamentId,p_group_id:section.dataset.secondaryGroup,p_action:button.dataset.secondaryAction,p_session_token:sessionToken});
   if(error){section.querySelector('[data-secondary-feedback]').textContent=error.message;section.querySelectorAll('button').forEach(b=>b.disabled=false);return;}
   await onChanged();
  }));
 });
}

export function secondaryRefereeLoginMarkup(){
 return '<section class="ref-secondary-login"><b>MÃ CODE TRỌNG TÀI PHỤ</b><form id="secondaryRefClaim"><label>Mã phụ<input name="code" required pattern="[0-9]{5}" minlength="5" maxlength="5" inputmode="numeric" autocomplete="one-time-code" placeholder="Nhập 5 số"></label><button class="wide">VÀO BẢNG</button><div role="alert" data-secondary-login-feedback></div></form></section>';
}

export function bindSecondaryRefereeLogin(root,{client,tournamentId,onClaimed}){
 const form=root.querySelector('#secondaryRefClaim');
 form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('button');button.disabled=true;
  const {data,error}=await client.rpc('claim_secondary_referee_access',{p_tournament_id:tournamentId,p_code:form.elements.code.value.trim()});
  const row=data?.[0];
  if(error||!row){button.disabled=false;form.querySelector('[data-secondary-login-feedback]').textContent=error?.message||'Mã phụ không hợp lệ, đã tắt hoặc tạm thời bị khóa.';return;}
  await onClaimed(row);
 };
}
