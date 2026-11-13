export const timeoutSeconds=(expiresAt,now=Date.now())=>Math.max(0,Math.ceil((Date.parse(expiresAt)-now)/1000));
export function mountRefereeTimeouts(client,token,state,root){
 const buttons=[...root.querySelectorAll('[data-timeout-team]')];
 let rows=[],offset=0,loaded=false,busy=false,lastFetch=0;
 const paint=()=>buttons.forEach(button=>{
  const row=rows.find(r=>r.team===Number(button.dataset.timeoutTeam));
  const seconds=row?timeoutSeconds(row.expires_at,Date.now()+offset):0;
  button.disabled=!loaded||busy||!state.can_control||state.status!=='playing'||Boolean(row);
  button.textContent=row?(seconds?`⏱ TIME OUT · ${seconds}s`:'⏱ ĐÃ DÙNG TIME OUT'):'⏱ TIME OUT · 59s';
 });
 const request=async(team=null)=>{
  if(busy)return;busy=true;paint();
  const {data,error}=await client.rpc('referee_match_timeouts',{p_session_token:token,p_match_id:state.match_id,p_team:team});
  if(!root.isConnected)return;
  busy=false;lastFetch=Date.now();
  if(error){
   const feedback=root.querySelector('#scoreFeedback');if(feedback)feedback.textContent=`Time out: ${error.message}`;
   if(!loaded)buttons.forEach(b=>{b.textContent='Thử tải Time out';b.disabled=!state.can_control;b.onclick=()=>request()});
   else paint();return;
  }
  rows=data.timeouts;offset=Date.parse(data.server_now)-Date.now();loaded=true;paint();
  buttons.forEach(b=>b.onclick=()=>request(Number(b.dataset.timeoutTeam)));
 };
 const timer=setInterval(()=>{
  if(!root.isConnected){clearInterval(timer);return}
  paint();if(Date.now()-lastFetch>5000)request();
 },250);
 paint();request();
}
