import QRCode from 'qrcode';
import './video.css';

async function post(endpoint,body,token,signal){
  const response=await fetch(`/.netlify/functions/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal});
  let result;try{result=await response.json();}catch{throw new Error('Dịch vụ LIVE chưa sẵn sàng.');}
  if(!response.ok)throw Object.assign(new Error(result.error||'Không thể kết nối LIVE.'),{status:response.status});
  return result;
}

// Preserve a newly created invitation when the operator closes/reopens the QR.
const invitations=new Map();
export async function showBroadcasterQR(supabase,matchId){
  const host=document.querySelector('#modal');
  host.innerHTML='<div class="overlay"><section class="modal video-qr" role="dialog" aria-modal="true" aria-label="Bật LIVE"><div class="modalhead"><h2>Bật LIVE</h2><button class="x" aria-label="Đóng">×</button></div><p role="status">Đang tạo QR…</p><canvas hidden></canvas><a hidden target="_blank" rel="noopener noreferrer">Mở trang phát trên thiết bị này</a></section></div>';
  const panel=host.querySelector('.video-qr'),message=panel.querySelector('p');
  panel.querySelector('.x').onclick=()=>host.replaceChildren();
  try{
    let result=invitations.get(matchId);
    if(!result){
      const {data:{session}}=await supabase.auth.getSession();
      if(!session)throw new Error('Vui lòng đăng nhập lại.');
      result=await post('video-create',{match_id:matchId},session.access_token);
      invitations.set(matchId,result);
    }
    const url=new URL(result.broadcaster_url,location.origin);
    if(url.origin!==location.origin)throw new Error('Liên kết LIVE không hợp lệ.');
    const canvas=panel.querySelector('canvas');
    await QRCode.toCanvas(canvas,url.href,{width:280,margin:2});
    canvas.hidden=false;
    const link=panel.querySelector('a');link.href=url.href;link.hidden=false;
    message.textContent=`Quét QR bằng điện thoại quay trận. Chỉ gửi cho người phát LIVE. QR có hiệu lực đến ${new Date(result.invite_expires_at).toLocaleTimeString('vi-VN')}.`;
    const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='Hủy phiên / tạo QR mới';panel.append(cancel);
    cancel.onclick=async()=>{
      cancel.disabled=true;
      try{await post('video-broadcast',{action:'stop',session_id:result.session_id,token:result.invite_token});invitations.delete(matchId);host.replaceChildren();}
      catch(error){message.textContent=error.message;cancel.disabled=false;}
    };
  }catch(error){message.textContent=error.message;}
}

function gatherIce(peer){
  if(peer.iceGatheringState==='complete')return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',change);error?reject(error):resolve();};
    const change=()=>{if(peer.iceGatheringState==='complete')finish();};
    const timer=setTimeout(()=>finish(new Error('Kết nối mạng quá chậm. Vui lòng thử lại.')),12000);
    peer.addEventListener('icegatheringstatechange',change);
  });
}

export function renderBroadcaster(app){
  const params=new URLSearchParams(location.hash.slice(1));
  const session_id=params.get('session'),token=params.get('token');
  app.innerHTML='<main class="broadcaster"><small>THE PANTRY · LIVE</small><h1>Phát trực tiếp trận đấu</h1><p>Đặt điện thoại nằm ngang, hướng camera về sân. Giữ trang này mở khi phát.</p><video autoplay muted playsinline aria-label="Xem trước camera"></video><div class="broadcast-actions"><button id="camera">Cho phép camera & micro</button><button id="broadcast" disabled>Bắt đầu LIVE</button><button id="stopBroadcast" class="secondary" disabled>Dừng LIVE</button></div><p id="broadcastMessage" role="status" aria-live="polite"></p></main>';
  const video=app.querySelector('video'),camera=app.querySelector('#camera'),start=app.querySelector('#broadcast'),stop=app.querySelector('#stopBroadcast'),message=app.querySelector('#broadcastMessage');
  let media,peer,attempted=false,expiryTimer,heartbeatTimer,heartbeatRequest;
  const request=action=>({action,session_id,token});
  const release=()=>{clearTimeout(expiryTimer);clearInterval(heartbeatTimer);heartbeatRequest?.abort();if(peer){peer.onconnectionstatechange=null;peer.close();peer=null;}media?.getTracks().forEach(track=>track.stop());media=null;video.srcObject=null;};
  const heartbeat=async()=>{
    if(peer?.connectionState!=='connected'||heartbeatRequest)return;
    const connection=peer,controller=new AbortController();heartbeatRequest=controller;
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      await post('video-broadcast',request('heartbeat'),null,controller.signal);
      if(peer===connection)message.textContent='● Đang LIVE';
    }catch(error){
      if(peer!==connection)return;
      if([400,403,404,409,410].includes(error.status)){
        stop.click();
      }else message.textContent='Không gửi được tín hiệu LIVE. Đang thử lại…';
    }finally{clearTimeout(timeout);if(heartbeatRequest===controller)heartbeatRequest=null;}
  };
  if(!/^[0-9a-f-]{36}$/i.test(session_id||'')||!/^[A-Za-z0-9_-]{43}$/.test(token||'')){
    camera.disabled=true;message.textContent='Liên kết không hợp lệ. Hãy quét lại QR do quản trị viên cung cấp.';return;
  }
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection){
    camera.disabled=true;message.textContent='Hãy mở liên kết HTTPS trong Safari hoặc Chrome để dùng camera và micro.';return;
  }
  camera.onclick=async()=>{
    camera.disabled=true;message.textContent='Vui lòng cho phép camera và micro…';
    try{
      media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:true});
      video.srcObject=media;await video.play();start.disabled=false;stop.disabled=false;
      message.textContent='Camera đã sẵn sàng. Chưa phát LIVE.';
    }catch(error){release();camera.disabled=false;message.textContent=error.name==='NotAllowedError'?'Camera hoặc micro bị chặn. Hãy cấp quyền trong trình duyệt rồi thử lại.':'Không mở được camera và micro. Hãy đóng ứng dụng khác đang sử dụng camera rồi thử lại.';}
  };
  start.onclick=async()=>{
    start.disabled=true;stop.disabled=true;message.textContent='Đang kết nối LIVE…';
    try{
      peer=new RTCPeerConnection({bundlePolicy:'max-bundle'});
      media.getTracks().forEach(track=>peer.addTransceiver(track,{direction:'sendonly',streams:[media]}));
      peer.onconnectionstatechange=()=>{
        if(peer?.connectionState==='connected')message.textContent='● Đang LIVE';
        if(peer?.connectionState==='disconnected')message.textContent='Mạng gián đoạn. Đang chờ kết nối lại…';
        if(peer?.connectionState==='failed'){release();start.disabled=true;stop.disabled=false;message.textContent='Mất kết nối. Bấm Dừng LIVE rồi nhờ quản trị viên tạo QR mới.';}
      };
      await peer.setLocalDescription(await peer.createOffer());await gatherIce(peer);
      attempted=true;
      const result=await post('video-broadcast',{...request('start'),sdp:peer.localDescription.sdp});
      await peer.setRemoteDescription({type:'answer',sdp:result.sdp});
      stop.disabled=false;
      heartbeatTimer=setInterval(heartbeat,15000);
      heartbeat();
      expiryTimer=setTimeout(()=>stop.click(),Math.max(0,Date.parse(result.hard_expires_at)-Date.now()));
    }catch(error){release();stop.disabled=false;camera.disabled=attempted;message.textContent=error.message;}
  };
  stop.onclick=async()=>{
    stop.disabled=true;start.disabled=true;release();
    if(!attempted){camera.disabled=false;message.textContent='Đã tắt camera và micro.';return;}
    try{await post('video-broadcast',request('stop'));message.textContent='Đã kết thúc LIVE. Nhờ quản trị viên tạo QR mới nếu cần phát lại.';}
    catch(error){stop.disabled=false;message.textContent=`Đã tắt camera. ${error.message} Bấm Dừng LIVE để thử lại.`;}
  };
  window.addEventListener('pagehide',()=>{
    release();
    if(attempted)fetch('/.netlify/functions/video-broadcast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request('stop')),keepalive:true}).catch(()=>{});
  },{once:true});
}
