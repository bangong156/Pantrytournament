import './video-playback.css';

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

export function mountPublicVideo(scope,onStreams=()=>{}){
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
          button.onclick=()=>{closePlayer();closePlayer=openPlayer({...scope,match_id:slot.dataset.publicVideo},slot.dataset.videoLabel,()=>{slot.textContent='Video ngoại tuyến / đã kết thúc';});};
          slot.append(button);
        }else slot.textContent='';
      }
    }catch{
      if(!controller.signal.aborted){const count=document.querySelector('[data-live-count]');if(count)count.textContent='';document.querySelectorAll('[data-match-state]').forEach(node=>{node.textContent=node.dataset.baseStatus;});slots.forEach(slot=>{slot.textContent='Chưa xác định trạng thái video';});}
    }finally{if(!controller.signal.aborted)timer=setTimeout(refresh,10000);}
  };
  refresh();
}

export function mountHomepageVideo(){
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
        button.onclick=()=>{closePlayer();closePlayer=openPlayer({tournament_id:stream.tournament_id,event_id:stream.event_id,match_id:stream.match_id},stream.match_code,()=>{card.remove();section.hidden=!cards.children.length;});};
        cards.append(card);
      }
    }catch{if(!controller.signal.aborted){cards.replaceChildren();section.hidden=true;}}
    finally{if(!controller.signal.aborted)timer=setTimeout(refresh,10000);}
  };
  refresh();
}

function openPlayer(scope,label,onOffline){
  const host=document.querySelector('#modal');
  host.innerHTML='<div class="overlay"><section class="modal public-video-player" role="dialog" aria-modal="true" aria-label="Video trực tiếp"><div class="modalhead"><h2></h2><button class="x" aria-label="Đóng">×</button></div><video controls autoplay muted playsinline></video><p role="status" aria-live="polite">Đang kết nối video LIVE…</p><button class="secondary" data-retry>Thử lại</button></section></div>';
  const panel=host.querySelector('.public-video-player'),video=panel.querySelector('video'),message=panel.querySelector('p'),retry=panel.querySelector('[data-retry]');
  panel.querySelector('h2').textContent=`Video LIVE · ${label||'Trận đấu'}`;
  const controller=new AbortController();let peer,viewerURL,timer,sessionId,closed=false,checking=false;
  const release=()=>{
    if(peer){peer.onconnectionstatechange=null;peer.close();peer=null;}
    video.srcObject?.getTracks().forEach(track=>track.stop());video.srcObject=null;
    if(viewerURL){fetch(viewerURL,{method:'DELETE',keepalive:true}).catch(()=>{});viewerURL=null;}
  };
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);controller.abort();release();if(panel.isConnected)host.replaceChildren();window.removeEventListener('pagehide',close);};
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
