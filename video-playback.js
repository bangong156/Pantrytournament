import './video-playback.css';
import {competitionClient} from './event-scope.js';

let dispose=()=>{};
export function stopPublicVideo(){dispose();dispose=()=>{};}

async function requestWithTimeout(url,options,consume){
  const controller=new AbortController(),parent=options.signal;
  const abort=()=>controller.abort();
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,12000);
  try{return await consume(await fetch(url,{...options,signal:controller.signal}));}
  finally{clearTimeout(timer);parent?.removeEventListener('abort',abort);}
}

async function readStreams(scope,signal){
  return requestWithTimeout('/.netlify/functions/video-playback?'+new URLSearchParams(scope),{cache:'no-store',signal},async response=>{
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Không thể tải video LIVE.');
    return result.streams;
  });
}

export function mountPublicVideo(scope,onStreams=()=>{},client){
  stopPublicVideo();
  const slots=[...document.querySelectorAll('[data-public-video]')];
  const controller=new AbortController();let timer,closePlayer=()=>{};
  dispose=()=>{clearTimeout(timer);controller.abort();closePlayer();};
  const refresh=async()=>{
    try{
      const streams=await readStreams(scope,controller.signal);
      if(controller.signal.aborted)return;
      const active=new Map(streams.map(row=>[row.match_id,row]));
      onStreams(streams);
      const count=document.querySelector('[data-live-count]');
      if(count)count.textContent=` • ${active.size>0?'🔴 ':''}${active.size} LIVE`;
      document.querySelectorAll('[data-match-state]').forEach(node=>{node.textContent=active.has(node.dataset.matchState)?'🔴 ĐANG ĐẤU':node.dataset.baseStatus;});
      for(const slot of slots){
        slot.replaceChildren();
        if(active.has(slot.dataset.publicVideo)){
          const button=document.createElement('button');button.textContent='XEM LIVE';button.className='public-video-button';
          button.onclick=()=>{closePlayer();closePlayer=openPlayer({...scope,match_id:slot.dataset.publicVideo},slot.dataset.videoLabel,()=>{slot.textContent='Video ngoại tuyến / đã kết thúc';},client);};
          slot.append(button);
        }else slot.textContent='';
      }
    }catch{
      if(!controller.signal.aborted){const count=document.querySelector('[data-live-count]');if(count)count.textContent='';document.querySelectorAll('[data-match-state]').forEach(node=>{node.textContent=node.dataset.baseStatus;});slots.forEach(slot=>{slot.textContent='Chưa xác định trạng thái video';});}
    }finally{if(!controller.signal.aborted)timer=setTimeout(refresh,10000);}
  };
  refresh();
}

export function mountHomepageVideo(client){
  stopPublicVideo();
  const section=document.querySelector('#homepageLive'),cards=section.querySelector('.discovery-grid');
  const controller=new AbortController();let timer,closePlayer=()=>{};
  dispose=()=>{clearTimeout(timer);controller.abort();closePlayer();};
  const refresh=async()=>{
    try{
      const streams=await readStreams({homepage:'1'},controller.signal);
      if(controller.signal.aborted)return;
      cards.replaceChildren();section.hidden=!streams.length;
      for(const stream of streams){
        const card=document.createElement('article');card.className='discovery-card homepage-live-card';
        const add=(tag,text,className)=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;card.append(node);return node;};
        add('span','● LIVE','homepage-live-indicator');
        add('h3',stream.tournament_name);
        add('p',`${stream.event_name} · ${stream.match_code||'Trận đấu'}${Number.isInteger(stream.court_number)&&stream.court_number>0?' • SÂN '+stream.court_number:''}`);
        add('strong',`${stream.team_a} vs ${stream.team_b}`);
        const button=add('button','XEM LIVE');
        button.onclick=()=>{closePlayer();closePlayer=openPlayer({tournament_id:stream.tournament_id,event_id:stream.event_id,match_id:stream.match_id},stream.match_code,()=>{card.remove();section.hidden=!cards.children.length;},client);};
        cards.append(card);
      }
    }catch{if(!controller.signal.aborted){cards.replaceChildren();section.hidden=true;}}
    finally{if(!controller.signal.aborted)timer=setTimeout(refresh,10000);}
  };
  refresh();
}

function openPlayer(scope,label,onOffline,client){
  const host=document.querySelector('#modal');
  host.innerHTML='<div class="overlay"><section class="modal public-video-player" role="dialog" aria-modal="true" aria-label="Video trực tiếp"><div class="modalhead"><h2></h2><button class="x" aria-label="Đóng">×</button></div><div class="public-video-frame"><video controls autoplay muted playsinline></video><div class="live-scoreboard" hidden aria-label="Tỉ số trận đấu"><div class="live-scoreboard-head"><span data-score-status></span><span data-score-code></span></div><div class="live-scoreboard-row"><span data-score-name="1"></span><strong data-score-value="1"></strong></div><div class="live-scoreboard-row"><span data-score-name="2"></span><strong data-score-value="2"></strong></div></div></div><p role="status" aria-live="polite">Đang kết nối video LIVE…</p><button class="secondary" data-retry>Thử lại</button></section></div>';
  const panel=host.querySelector('.public-video-player'),video=panel.querySelector('video'),message=panel.querySelector('p'),retry=panel.querySelector('[data-retry]');
  panel.querySelector('h2').textContent=`Video LIVE · ${label||'Trận đấu'}`;
  const stopScoreboard=mountScoreboard(panel,scope,client);
  const controller=new AbortController();let peer,viewerURL,timer,sessionId,closed=false,checking=false;
  const release=()=>{
    if(peer){peer.onconnectionstatechange=null;peer.close();peer=null;}
    video.srcObject?.getTracks().forEach(track=>track.stop());video.srcObject=null;
    if(viewerURL){fetch(viewerURL,{method:'DELETE',keepalive:true}).catch(()=>{});viewerURL=null;}
  };
  const close=()=>{if(closed)return;closed=true;stopScoreboard();clearTimeout(timer);controller.abort();release();if(panel.isConnected)host.replaceChildren();window.removeEventListener('pagehide',close);};
  panel.querySelector('.x').onclick=close;
  host.querySelector('.overlay').onclick=event=>{if(event.target===panel.parentElement)close();};
  window.addEventListener('pagehide',close);
  const check=async()=>{
    if(closed||checking)return;checking=true;clearTimeout(timer);retry.disabled=true;
    try{
      const [stream]=await readStreams(scope,controller.signal);
      if(closed)return;
      if(!stream){release();sessionId=null;message.textContent='Video ngoại tuyến / buổi phát đã kết thúc.';onOffline();return;}
      if(peer&&sessionId===stream.session_id)return;
      release();sessionId=stream.session_id;
      if(!window.RTCPeerConnection)throw new Error('Trình duyệt chưa hỗ trợ video LIVE. Hãy mở bằng Safari hoặc Chrome.');
      peer=new RTCPeerConnection({bundlePolicy:'max-bundle'});
      const connection=peer,media=new MediaStream();video.srcObject=media;
      peer.addTransceiver('video',{direction:'recvonly'});peer.addTransceiver('audio',{direction:'recvonly'});
      peer.ontrack=event=>{media.addTrack(event.track);video.play().catch(()=>{message.textContent='Bấm phát trên video để xem LIVE.';});};
      peer.onconnectionstatechange=()=>{
        if(connection.connectionState==='connected')message.textContent='🔴 VIDEO LIVE · Bật âm thanh bằng nút trên video.';
        if(connection.connectionState==='disconnected')message.textContent='Video tạm gián đoạn. Đang kiểm tra lại…';
        if(connection.connectionState==='failed'){release();message.textContent='Mất kết nối video. Đang kiểm tra lại…';}
      };
      await connection.setLocalDescription(await connection.createOffer());
      // WHEP accepts the initial offer without client-side ICE trickling.
      const answer=await requestWithTimeout(stream.playback_url,{method:'POST',headers:{'Content-Type':'application/sdp'},body:connection.localDescription.sdp,signal:controller.signal},async response=>{
        if(response.status!==201)throw new Error('Video ngoại tuyến hoặc kết nối bị gián đoạn. Vui lòng thử lại.');
        const location=response.headers.get('Location');
        if(location){const url=new URL(location,stream.playback_url);if(url.origin===new URL(stream.playback_url).origin)viewerURL=url.href;}
        return response.text();
      });
      if(closed)return;
      await connection.setRemoteDescription({type:'answer',sdp:answer});
    }catch(error){if(!closed){release();message.textContent=error instanceof SyntaxError?'Không thể tải video LIVE lúc này.':error.message;}}
    finally{checking=false;if(!closed){retry.disabled=false;timer=setTimeout(check,10000);}}
  };
  retry.onclick=()=>{if(!checking){release();check();}};
  check();return close;
}

// Independent of stream discovery, connection state and player retries.
function mountScoreboard(panel,scope,client){
  if(!client||!scope.match_id||!scope.event_id)return ()=>{};
  const card=panel.querySelector('.live-scoreboard');
  let db;
  try{db=competitionClient(client,{id:scope.event_id,tournament_id:scope.tournament_id});}catch{return ()=>{};}
  let pending,timer,stopped=false,teamKey='',names={};
  const refresh=async()=>{
    const controller=new AbortController();pending=controller;
    const timeout=setTimeout(()=>controller.abort(),12000);
    try{
      const {data:match,error}=await db.from('matches').select('match_code,status,team1_id,team2_id,team1_score,team2_score,court_number').eq('tournament_id',scope.tournament_id).eq('id',scope.match_id).abortSignal(controller.signal).maybeSingle();
      if(error||!match||stopped||!panel.isConnected)return;
      const ids=[match.team1_id,match.team2_id].filter(Boolean),key=ids.join(',');
      if(key!==teamKey){
        const result=await db.from('teams').select('id,name').eq('tournament_id',scope.tournament_id).in('id',ids).abortSignal(controller.signal);
        if(result.error)return;
        names=Object.fromEntries((result.data||[]).map(team=>[team.id,team.name]));teamKey=key;
      }
      if(stopped||!panel.isConnected)return;
      card.querySelector('[data-score-status]').textContent=(match.status==='completed'?'✓ KẾT THÚC':'🔴 LIVE')+(Number.isInteger(match.court_number)&&match.court_number>0?' · SÂN '+match.court_number:'');
      card.querySelector('[data-score-code]').textContent=match.match_code||'';
      for(const n of [1,2]){
        const name=card.querySelector(`[data-score-name="${n}"]`);
        name.textContent=names[match[`team${n}_id`]]||'—';name.title=name.textContent;
        card.querySelector(`[data-score-value="${n}"]`).textContent=match[`team${n}_score`]??'—';
      }
      card.hidden=false;
    }catch{ /* Keep the last known score; never affect playback. */ }
    finally{clearTimeout(timeout);if(!stopped&&panel.isConnected)timer=setTimeout(refresh,2000);}
  };
  refresh();
  return ()=>{stopped=true;clearTimeout(timer);pending?.abort();};
}
