const KEY='pantry-quick-rotating-partners-v2';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={names:[],matches:[]};
try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved&&Array.isArray(saved.names)&&Array.isArray(saved.matches))state=saved}catch{}
const save=()=>localStorage.setItem(KEY,JSON.stringify(state));
function shuffle(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function parseNames(text){
 const names=text.split(/\r?\n/).map(x=>x.replace(/^\s*(?:#\s*)?\d{1,4}\s*(?:[.)]|[-–—:]\s+|\t)\s*/,'').trim()).filter(Boolean);
 if(names.length<4||names.length%4!==0)throw Error('Chế độ xoay partner cần 4, 8, 12, 16… người (bội số của 4) để mọi người chơi đủ mỗi lượt.');
 if(names.length>64)throw Error('Tối đa 64 người.');
 if(new Set(names.map(x=>x.toLocaleLowerCase('vi'))).size!==names.length)throw Error('Tên VĐV bị trùng. Hãy thêm biệt danh để phân biệt.');
 return names;
}
function schedule(names){
 // Circle-method 1-factorization: each unordered partner pair occurs exactly once.
 const ids=shuffle(names.map((_,i)=>i)),n=ids.length;
 let ring=[...ids],matches=[];
 for(let round=0;round<n-1;round++){
  const pairs=[];
  for(let i=0;i<n/2;i++)pairs.push([ring[i],ring[n-1-i]]);
  // Randomize pair-versus-pair arrangement without changing the partner uniqueness invariant.
  const paired=shuffle(pairs);
  for(let i=0;i<paired.length;i+=2){
   matches.push({id:'m'+matches.length,round:round+1,a:paired[i],b:paired[i+1],sa:'',sb:''});
  }
  ring=[ring[0],ring[n-1],...ring.slice(1,n-1)];
 }
 return matches;
}
function generate(reshuffle=false){
 $('error').textContent='';
 try{
  const names=reshuffle?state.names:parseNames($('names').value);
  if(state.matches.some(m=>m.sa!==''||m.sb!=='')&&!confirm('Xáo lại lịch sẽ xóa toàn bộ tỉ số đã nhập. Tiếp tục?'))return;
  state={names,matches:schedule(names)};save();render();
 }catch(e){$('error').textContent=e.message}
}
function render(){
 $('names').value=state.names.join('\n');
 const exists=state.names.length>0;
 ['teamsPanel','matchesPanel','rankingPanel'].forEach(id=>$(id).hidden=!exists);
 $('reshuffle').hidden=!exists;
 if(!exists)return;
 $('teamsPanel').querySelector('h2').textContent='2. VĐV tham gia';
 $('teams').innerHTML=state.names.map((name,i)=>'<div class="team"><b>VĐV '+(i+1)+'</b>'+esc(name)+'</div>').join('');
 const done=state.matches.filter(m=>m.sa!==''&&m.sb!==''&&m.sa!==m.sb).length;
 $('progress').textContent=done+' / '+state.matches.length+' trận có kết quả · '+(state.names.length-1)+' lượt · Mỗi người '+(state.names.length-1)+' trận.';
 $('matches').innerHTML=Array.from({length:state.names.length-1},(_,i)=>i+1).map(r=>'<div class="round">LƯỢT '+r+'</div>'+state.matches.filter(m=>m.round===r).map(m=>'<div class="match"><div>'+m.a.map(id=>esc(state.names[id])).join(' + ')+'</div><input type="number" min="0" max="999" step="1" aria-label="Điểm đội A" data-match="'+m.id+'" data-side="sa" value="'+esc(m.sa)+'"><span class="vs">:</span><input type="number" min="0" max="999" step="1" aria-label="Điểm đội B" data-match="'+m.id+'" data-side="sb" value="'+esc(m.sb)+'"><div class="right">'+m.b.map(id=>esc(state.names[id])).join(' + ')+'</div></div>').join('')).join('');
 $('matches').querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>{
  const match=state.matches.find(m=>m.id===input.dataset.match);if(!match)return;
  const value=input.value.trim();
  if(value!==''&&(!/^\d+$/.test(value)||Number(value)>999)){input.value=match[input.dataset.side];$('error').textContent='Điểm phải là số nguyên 0–999.';return}
  match[input.dataset.side]=value;$('error').textContent='';save();renderRanking();
  $('progress').textContent=state.matches.filter(m=>m.sa!==''&&m.sb!==''&&m.sa!==m.sb).length+' / '+state.matches.length+' trận có kết quả · '+(state.names.length-1)+' lượt.';
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
$('generate').onclick=()=>generate();
$('reshuffle').onclick=()=>generate(true);
$('reset').onclick=()=>{if(!confirm('Xóa danh sách, lịch và kết quả Round Robin xoay partner trên trình duyệt này?'))return;state={names:[],matches:[]};localStorage.removeItem(KEY);$('names').value='';$('error').textContent='';render()};
render();