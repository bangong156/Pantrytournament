import {VideoError,cloudflareURL} from './video-security.js';
export function cloudflareStream({accountId,apiToken,fetcher=fetch}){
  if(!/^[a-f0-9]{32}$/i.test(accountId||'')||!apiToken)throw new VideoError(503,'LIVE chưa được cấu hình.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs`;
  async function api(path,method,body,key){
    const r=await fetcher(base+path,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(method==='DELETE'&&r.status===404)return;
    if(method==='GET'&&r.status===404)return;
    if(!r.ok)throw new VideoError(502,'Không thể kết nối Cloudflare. Vui lòng thử lại.');
    if(r.status===204)return;
    const result=await r.json();if(!result.success)throw new VideoError(502,'Cloudflare chưa hoàn tất yêu cầu.');return result.result;
  }
  return {
    async active(uid){
      if(!/^[a-f0-9]{32}$/i.test(uid||''))return false;
      const input=await api('/'+uid,'GET');
      return ['connected','reconnected'].includes(input?.status);
    },
    async create(row){
      const input=await api('','POST',{meta:{name:`Pantry match ${row.match_id}`,pantry_session:row.id},recording:{mode:'off'}},row.id);
      if(!/^[a-f0-9]{32}$/i.test(input?.uid||''))throw new VideoError(502,'Cloudflare chưa tạo được LIVE.');
      return {uid:input.uid,publish:cloudflareURL(input.webRTC?.url,{suffix:'/webRTC/publish'}),playback:cloudflareURL(input.webRTCPlayback?.url,{suffix:'/webRTC/play'})};
    },
    async publish(url,sdp){
      const endpoint=cloudflareURL(url,{suffix:'/webRTC/publish'});
      const r=await fetcher(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/sdp'},body:sdp});
      if(r.status!==201)throw new VideoError(502,'Không thể bắt đầu phát. Hãy nhờ quản trị viên tạo QR mới.');
      const location=r.headers.get('Location');
      if(!location)throw new VideoError(502,'Cloudflare chưa cung cấp phiên LIVE.');
      const session=cloudflareURL(new URL(location,endpoint).href,{origin:new URL(endpoint).origin});
      const answer=await r.text();if(answer.length>100000||!answer.startsWith('v=0'))throw new VideoError(502,'Cloudflare trả về phiên LIVE không hợp lệ.');
      return {answer,session};
    },
    async endSession(url){if(!url)return;const r=await fetcher(cloudflareURL(url),{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok&&r.status!==404&&r.status!==410)throw new VideoError(502,'Chưa ngắt được kết nối LIVE.');},
    async remove(uid){if(!/^[a-f0-9]{32}$/i.test(uid||''))throw new VideoError(502,'LIVE cần được kiểm tra.');await api('/'+uid,'DELETE');}
  };
}
