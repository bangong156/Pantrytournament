const KEY='pantry-quick-rotating-partners-v2';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={names:[],matches:[]};
try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved&&Array.isArray(saved.names)&&Array.isArray(saved.matches))state=saved}catch{}
const save=()=>{localStorage.setItem(KEY,JSON.stringify(state));if(roomCode){queued=true;void pushRoom()}};
import {createClient} from '@supabase/supabase-js';
const db=createClient('https://duuklzzxpegptsarcbqq.supabase.co','sb_publishable_FmGKX67AD3M4QvCuL3dSyg_w0X5vIX9');
const ROOM_KEY='pantry-quick-roundrobin-room';
let roomCode=localStorage.getItem(ROOM_KEY)||'',roomVersion=0,saving=false,queued=false,blocked=false;
const roomError=msg=>{$('roomError').textContent=msg||''};
function showRoom(){
 $('roomCodeInput').value=roomCode;
 $('roomInfo').innerHTML=roomCode?'<b>Đang quản lý chung · Mã phòng: '+esc(roomCode)+'</b> <button type="button" class="secondary" id="copyRoom">Copy mã</button> <button type="button" class="secondary" id="leaveRoom">Rời phòng</button><p class="muted">Mọi thay đổi được đồng bộ qua Supabase. Không chia sẻ mã với người chỉ muốn xem.</p>':'<span class="muted">Chưa tham gia phòng chung. Dữ liệu hiện chỉ lưu trên thiết bị này.</span>';
 $('copyRoom')?.addEventListener('click',()=>navigator.clipboard.writeText(roomCode).catch(()=>prompt('Sao chép mã phòng:',roomCode)));
 $('leaveRoom')?.addEventListener('click',()=>{roomCode='';roomVersion=0;blocked=false;localStorage.removeItem(ROOM_KEY);showRoom();roomError('Đã rời phòng. Dữ liệu hiện tại được giữ trên máy.');});
}
async function loadRoom(){
 if(!roomCode)return;
 const {data,error}=await db.rpc('quick_rr_read',{p_code:roomCode});
 if(error)throw error;
 if(!data)throw Error('Mã phòng không tồn tại.');
 roomVersion=Number(data.version);state=data.state;localStorage.setItem(KEY,JSON.stringify(state));render();
}
async function pushRoom(){
 if(!roomCode||saving||blocked)return;
 saving=true;
 try{
  do{
   queued=false;
   const snapshot=JSON.parse(JSON.stringify(state));
   const {data,error}=await db.rpc('quick_rr_save',{p_code:roomCode,p_state:snapshot,p_version:roomVersion});
   if(error)throw error;
   if(!data)throw Error('Không thể lưu, dữ liệu đã thay đổi trên thiết bị khác.');
   roomVersion=Number(data.version);
   if(JSON.stringify(state)!==JSON.stringify(snapshot))queued=true;
  }while(queued&&roomCode);
  roomError('');
 }catch(e){
  blocked=true;
  roomError('Không đồng bộ được: '+e.message+' · Tải lại phòng để nhận dữ liệu mới.');
 }finally{saving=false}
}
$('createRoom').onclick=async()=>{
 if(roomCode&&!confirm('Bạn đang ở phòng chung. Tạo phòng mới từ dữ liệu hiện tại?'))return;
 const b=$('createRoom');b.disabled=true;roomError('');
 try{
  const {data,error}=await db.rpc('quick_rr_create',{p_state:state});
  if(error)throw error;
  roomCode=data.code;roomVersion=Number(data.version);blocked=false;
  localStorage.setItem(ROOM_KEY,roomCode);showRoom();
 }catch(e){roomError(e.message)}finally{b.disabled=false}
};
$('joinRoom').onclick=async()=>{
 const code=$('roomCodeInput').value.trim().toLowerCase();
 if(!/^[0-9a-f]{24}$/.test(code)){roomError('Mã phòng không hợp lệ.');return}
 if(state.matches.length&&!confirm('Vào phòng sẽ thay dữ liệu hiện tại bằng dữ liệu chung của phòng. Tiếp tục?'))return;
 const b=$('joinRoom');b.disabled=true;roomError('');
 try{
  const {data,error}=await db.rpc('quick_rr_read',{p_code:code});if(error)throw error;
  if(!data)throw Error('Mã phòng không tồn tại.');
  roomCode=code;roomVersion=Number(data.version);state=data.state;blocked=false;
  localStorage.setItem(ROOM_KEY,roomCode);localStorage.setItem(KEY,JSON.stringify(state));
  showRoom();render();
 }catch(e){roomError(e.message)}finally{b.disabled=false}
};
showRoom();
if(roomCode)loadRoom().catch(e=>roomError('Không vào được phòng: '+e.message));
setInterval(async()=>{
 if(!roomCode||saving||blocked||document.activeElement?.matches('input[type=number],textarea'))return;
 try{
  const {data,error}=await db.rpc('quick_rr_read',{p_code:roomCode});if(error)throw error;
  if(!data)throw Error('Phòng không tồn tại.');
  if(Number(data.version)>roomVersion){
   roomVersion=Number(data.version);state=data.state;
   localStorage.setItem(KEY,JSON.stringify(state));render();
  }
 }catch(e){roomError('Mất kết nối phòng: '+e.message)}
},4000);

function shuffle(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function parseNames(text){
 const names=text.split(/\r?\n/).map(x=>x.replace(/^\s*(?:#\s*)?\d{1,4}\s*(?:[.)]|[-–—:]\s+|\t)\s*/,'').trim()).filter(Boolean);
 if(names.length<4)throw Error('Cần ít nhất 4 người để chơi đánh đôi.');
 if(names.length>64)throw Error('Tối đa 64 người.');
 if(new Set(names.map(x=>x.toLocaleLowerCase('vi'))).size!==names.length)throw Error('Tên VĐV bị trùng. Hãy thêm biệt danh để phân biệt.');
 return names;
}
function schedule(names){
 // Build every unique partnership, then pair disjoint partnerships into doubles matches.
 // The theoretical ceiling is floor(n*(n-1)/4) matches: two unique partnerships per match.
 const n=names.length,ids=shuffle(names.map((_,i)=>i));
 const edges=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)edges.push([ids[i],ids[j]]);
 const ceiling=Math.floor(edges.length/2);
 let best=[];
 const trials=n>28?5:35;
 for(let trial=0;trial<trials;trial++){
  const pool=shuffle(edges),games=[],counts=Array(n).fill(0);
  while(pool.length>1){
   // Prefer players with fewer scheduled games while keeping partners unique.
   let first=0;
   if(trial%3!==0){
    let score=Infinity;
    for(let i=0;i<pool.length;i++){
     const e=pool[i],v=counts[e[0]]+counts[e[1]]+Math.random()*.5;
     if(v<score){score=v;first=i}
    }
   }
   const a=pool.splice(first,1)[0];
   let index=-1,score=Infinity;
   for(let i=0;i<pool.length;i++){
    const b=pool[i];
    if(a[0]===b[0]||a[0]===b[1]||a[1]===b[0]||a[1]===b[1])continue;
    const v=counts[b[0]]+counts[b[1]]+Math.random()*.5;
    if(v<score){score=v;index=i}
   }
   if(index<0)continue;
   const b=pool.splice(index,1)[0];
   games.push({a,b});
   for(const id of [...a,...b])counts[id]++;
  }
  if(games.length>best.length)best=games;
  if(best.length===ceiling)break;
 }
 // Pack matches into rounds; a player can appear at most once in each round.
 const rounds=[];
 for(const game of shuffle(best)){
  let placed=false;
  for(const round of rounds){
   if(round.some(g=>[...g.a,...g.b].some(id=>game.a.includes(id)||game.b.includes(id))))continue;
   round.push(game);placed=true;break;
  }
  if(!placed)rounds.push([game]);
 }
 return rounds.flatMap((round,i)=>round.map(game=>({id:'m'+(i)+'-'+game.a.join('-')+'-'+game.b.join('-'),round:i+1,a:game.a,b:game.b,sa:'',sb:''})));
}
function generate(reshuffle=false){
 $('error').textContent='';
 try{
  const names=reshuffle?state.names:parseNames($('names').value);
  if(state.matches.length&&!confirm(state.matches.some(m=>m.sa!==''||m.sb!=='')?'Xếp lại lịch sẽ XÓA các trận cũ và toàn bộ tỉ số đã nhập. Tiếp tục?':'Xếp lại lịch sẽ thay thế toàn bộ trận đã xếp. Tiếp tục?'))return;
  state={names,matches:schedule(names)};save();render();
 }catch(e){$('error').textContent=e.message}
}
function render(){
 $('names').value=state.names.join('\n');
 const exists=state.names.length>0;
 ['teamsPanel','matchesPanel','rankingPanel'].forEach(id=>$(id).hidden=!exists);
 $('reshuffle').hidden=!exists;
 $('clearMatches').hidden=!exists||state.matches.length===0;
 if(!exists)return;
 $('teamsPanel').querySelector('h2').textContent='2. VĐV tham gia';
 $('teams').innerHTML=state.names.map((name,i)=>'<div class="team"><b>VĐV '+(i+1)+'</b>'+esc(name)+'</div>').join('');
 const done=state.matches.filter(m=>m.sa!==''&&m.sb!==''&&m.sa!==m.sb).length;
 $('progress').textContent=done+' / '+state.matches.length+' trận có kết quả · '+(state.matches.length?Math.max(...state.matches.map(m=>m.round)):0)+' lượt · Ghép partner không trùng.';
 $('matches').innerHTML=Array.from({length:Math.max(...state.matches.map(m=>m.round))},(_,i)=>i+1).map(r=>'<div class="round">LƯỢT '+r+'</div>'+state.matches.filter(m=>m.round===r).map(m=>'<div class="match"><div>'+m.a.map(id=>esc(state.names[id])).join(' + ')+'</div><input type="number" min="0" max="999" step="1" aria-label="Điểm đội A" data-match="'+m.id+'" data-side="sa" value="'+esc(m.sa)+'"><span class="vs">:</span><input type="number" min="0" max="999" step="1" aria-label="Điểm đội B" data-match="'+m.id+'" data-side="sb" value="'+esc(m.sb)+'"><div class="right">'+m.b.map(id=>esc(state.names[id])).join(' + ')+'</div><button type="button" class="danger match-delete" data-delete-match="'+esc(m.id)+'">Xóa trận</button></div>').join('')).join('');
 $('matches').querySelectorAll('[data-delete-match]').forEach(button=>button.onclick=()=>{
  const match=state.matches.find(m=>m.id===button.dataset.deleteMatch);
  if(!match)return;
  if(!confirm((match.sa!==''||match.sb!=='')?'Trận này đã nhập tỉ số. Xóa trận sẽ xóa cả kết quả và cập nhật BXH. Tiếp tục?':'Xóa trận này khỏi lịch thi đấu?'))return;
  state.matches=state.matches.filter(m=>m!==match);
  save();render();
 });
 $('matches').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{
  const match=state.matches.find(m=>m.id===input.dataset.match);if(!match)return;
  const value=input.value.trim();
  if(value!==''&&(!/^\d+$/.test(value)||Number(value)>999)){input.value=match[input.dataset.side];$('error').textContent='Điểm phải là số nguyên 0–999.';return}
  match[input.dataset.side]=value;$('error').textContent='';save();renderRanking();
  $('progress').textContent=state.matches.filter(m=>m.sa!==''&&m.sb!==''&&m.sa!==m.sb).length+' / '+state.matches.length+' trận có kết quả · '+(state.matches.length?Math.max(...state.matches.map(m=>m.round)):0)+' lượt.';
 }));
 renderRanking();
}
function renderRanking(){
 const rows=state.names.map((name,id)=>({id,name,played:0,w:0,l:0,pf:0,pa:0}));
 for(const m of state.matches){
  if(m.sa===''||m.sb==='')continue;
  const sa=Number(m.sa),sb=Number(m.sb);if(sa===sb)continue;
  for(const id of m.a){const x=rows[id];x.played++;x.pf+=sa;x.pa+=sb;if(sa>sb)x.w++;else x.l++}
  for(const id of m.b){const x=rows[id];x.played++;x.pf+=sb;x.pa+=sa;if(sb>sa)x.w++;else x.l++}
 }
 rows.sort((a,b)=>b.w-a.w||(b.pf-b.pa)-(a.pf-a.pa)||b.pf-a.pf||a.name.localeCompare(b.name,'vi'));
 $('ranking').innerHTML=rows.map((x,i)=>'<tr><td><b>'+(i+1)+'</b></td><td>'+esc(x.name)+'</td><td>'+x.played+'</td><td>'+x.w+'</td><td>'+x.l+'</td><td>'+x.pf+'</td><td>'+x.pa+'</td><td>'+(x.pf-x.pa>0?'+':'')+(x.pf-x.pa)+'</td></tr>').join('');
}
$('addPlayer').onclick=()=>{
 $('error').textContent='';
 const name=$('newPlayer').value.trim().replace(/^\s*(?:#\s*)?\d{1,4}\s*(?:[.)]|[-–—:]\s+|\t)\s*/,'').trim();
 if(!name){$('error').textContent='Nhập tên người chơi mới.';return}
 const names=state.names.length?[...state.names]:$('names').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 try{
  const updated=parseNames([...names,name].join('\n'));
  if(state.matches.length&&!confirm(state.matches.some(m=>m.sa!==''||m.sb!=='')?'Thêm người sẽ xếp lại toàn bộ trận và XÓA các tỉ số hiện tại. Tiếp tục?':'Thêm người sẽ xếp lại toàn bộ lịch thi đấu. Tiếp tục?'))return;
  state={names:updated,matches:schedule(updated)};
  $('newPlayer').value='';save();render();
 }catch(e){$('error').textContent=e.message}
};
$('newPlayer').addEventListener('keydown',e=>{if(e.key==='Enter'){$('addPlayer').click()}});
$('clearMatches').onclick=()=>{
 if(!state.matches.length)return;
 if(!confirm(state.matches.some(m=>m.sa!==''||m.sb!=='')?'Xóa TẤT CẢ trận đã xếp và toàn bộ kết quả? Danh sách người chơi được giữ lại.':'Xóa toàn bộ trận đã xếp? Danh sách người chơi được giữ lại.'))return;
 state.matches=[];save();render();
};
$('generate').onclick=()=>generate();
$('reshuffle').onclick=()=>generate(true);
$('reset').onclick=()=>{if(!confirm('Xóa danh sách, lịch và kết quả Round Robin xoay partner trên trình duyệt này?'))return;state={names:[],matches:[]};save();$('names').value='';$('error').textContent='';render()};
render();