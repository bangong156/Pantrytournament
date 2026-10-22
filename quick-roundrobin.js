const KEY='pantry-quick-roundrobin-v1';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={names:[],teams:[],matches:[]};
try{const stored=JSON.parse(localStorage.getItem(KEY));if(stored&&Array.isArray(stored.teams)&&Array.isArray(stored.matches)&&Array.isArray(stored.names))state=stored}catch{}
const save=()=>localStorage.setItem(KEY,JSON.stringify(state));
function shuffle(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function parseNames(text){const names=text.split(/\r?\n/).map(x=>x.replace(/^\s*(?:#\s*)?\d{1,4}\s*(?:[.)]|[-–—:]\s+|\t)\s*/,'').trim()).filter(Boolean);if(names.length<4||names.length%2)throw Error('Cần số người chẵn và ít nhất 4 người.');if(names.length>64)throw Error('Tối đa 64 người trong một phiên.');if(new Set(names.map(x=>x.toLocaleLowerCase('vi'))).size!==names.length)throw Error('Danh sách có tên trùng. Hãy thêm biệt danh để phân biệt.');return names}
function makeSchedule(teams){
 const ids=teams.map(t=>t.id);const arr=ids.length%2?[...ids,null]:[...ids],rounds=arr.length-1;let fixtures=[];
 for(let round=0;round<rounds;round++){
  for(let i=0;i<arr.length/2;i++){const a=arr[i],b=arr[arr.length-1-i];if(a!==null&&b!==null)fixtures.push({id:'m'+fixtures.length,a:round%2?b:a,b:round%2?a:b,round:round+1,sa:'',sb:''})}
  arr.splice(1,0,arr.pop());
 }
 return fixtures;
}
function generate(reshuffle=false){
 $('error').textContent='';
 try{
  const names=reshuffle?state.names:parseNames($('names').value);
  if(state.matches.some(m=>m.sa!==''&&m.sb!=='')&&!confirm('Tạo lại cặp sẽ xóa toàn bộ tỉ số hiện tại. Tiếp tục?'))return;
  const mixed=shuffle(names);state={names,teams:Array.from({length:mixed.length/2},(_,i)=>({id:i,name:mixed[2*i]+' - '+mixed[2*i+1]})),matches:[]};
  state.matches=makeSchedule(state.teams);save();render();
 }catch(e){$('error').textContent=e.message}
}
function render(){
 $('names').value=state.names.join('\n');
 const exists=state.teams.length>0;
 ['teamsPanel','matchesPanel','rankingPanel'].forEach(id=>$(id).hidden=!exists);
 $('reshuffle').hidden=!exists;if(!exists)return;
 $('teams').innerHTML=state.teams.map((t,i)=>'<div class="team"><b>Cặp '+(i+1)+'</b>'+esc(t.name)+'</div>').join('');
 const names=Object.fromEntries(state.teams.map(t=>[t.id,t.name]));
 const done=state.matches.filter(m=>m.sa!==''&&m.sb!=='').length;
 $('progress').textContent=done+' / '+state.matches.length+' trận đã có kết quả. Nhập tỉ số hai bên, hệ thống lưu ngay.';
 const rounds=[...new Set(state.matches.map(m=>m.round))];
 $('matches').innerHTML=rounds.map(r=>'<div class="round">LƯỢT '+r+'</div>'+state.matches.filter(m=>m.round===r).map(m=>'<div class="match"><div><small>Cặp '+(m.a+1)+'</small>'+esc(names[m.a])+'</div><input type="number" min="0" max="999" step="1" aria-label="Điểm '+esc(names[m.a])+'" data-match="'+m.id+'" data-side="sa" value="'+esc(m.sa)+'"><span class="vs">:</span><input type="number" min="0" max="999" step="1" aria-label="Điểm '+esc(names[m.b])+'" data-match="'+m.id+'" data-side="sb" value="'+esc(m.sb)+'"><div class="right"><small>Cặp '+(m.b+1)+'</small>'+esc(names[m.b])+'</div></div>').join('')).join('');
 $('matches').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{
  const match=state.matches.find(m=>m.id===input.dataset.match);if(!match)return;
  const value=input.value.trim();if(value!==''&&(!/^\d+$/.test(value)||Number(value)>999)){input.value=match[input.dataset.side];$('error').textContent='Điểm phải là số nguyên từ 0 đến 999.';return}
  match[input.dataset.side]=value;
  $('error').textContent='';
  save();renderRanking();
  $('progress').textContent=state.matches.filter(m=>m.sa!==''&&m.sb!=='').length+' / '+state.matches.length+' trận đã có kết quả.';
 }));
 renderRanking();
}
function renderRanking(){
 const table=state.teams.map(t=>({id:t.id,name:t.name,played:0,w:0,l:0,pf:0,pa:0}));
 for(const m of state.matches){
  if(m.sa===''||m.sb==='')continue;
  const a=table[m.a],b=table[m.b],sa=Number(m.sa),sb=Number(m.sb);
  if(sa===sb)continue;
  a.played++;b.played++;a.pf+=sa;a.pa+=sb;b.pf+=sb;b.pa+=sa;
  if(sa>sb){a.w++;b.l++}else{b.w++;a.l++}
 }
 table.sort((a,b)=>b.w-a.w||((b.pf-b.pa)-(a.pf-a.pa))||b.pf-a.pf||a.name.localeCompare(b.name,'vi'));
 $('ranking').innerHTML=table.map((t,i)=>'<tr><td><b>'+(i+1)+'</b></td><td>'+esc(t.name)+'</td><td>'+t.played+'</td><td>'+t.w+'</td><td>'+t.l+'</td><td>'+t.pf+'</td><td>'+t.pa+'</td><td>'+(t.pf-t.pa>0?'+':'')+(t.pf-t.pa)+'</td></tr>').join('');
}
$('generate').onclick=()=>generate();
$('reshuffle').onclick=()=>generate(true);
$('reset').onclick=()=>{if(!confirm('Xóa toàn bộ danh sách, lịch và kết quả Round Robin trên trình duyệt này?'))return;state={names:[],teams:[],matches:[]};localStorage.removeItem(KEY);$('names').value='';$('error').textContent='';render()};
render();