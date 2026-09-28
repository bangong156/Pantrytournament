export const ORGANIZER_EXPIRED='Quyền vận hành đã hết hạn hoặc đã bị thu hồi.';
export const organizerValid=state=>Boolean(state?.valid&&state.account?.is_active);
export const organizerManages=(state,id)=>organizerValid(state)&&[...(state.owned_ids||[]),...(state.assigned_ids||[])].includes(id);

// Friendly errors even for existing callers which do not inspect zero-row writes.
// The database independently enforces authorization; this is only UI feedback.
export function organizerFetch(getRole,onRevoked){
  return async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url||String(input));
    const method=(init.method||input.method||'GET').toUpperCase();
    const readRPCs=['organizer_access_state','can_manage_tournament','public_event_roster','public_tournament_roster','get_referee_session','referee_live_state','admin_event_referee_codes','pantry_knockout_inputs'];
    const writes=!['GET','HEAD','OPTIONS'].includes(method)&&(
      (url.pathname.startsWith('/rest/v1/')&&!readRPCs.includes(url.pathname.split('/').pop()))||url.pathname.startsWith('/storage/v1/object')
    );
    if(getRole()==='organizer'&&writes){
      const headers=new Headers(init.headers||input.headers);headers.set('Content-Type','application/json');
      const stateResponse=await fetch(new URL('/rest/v1/rpc/organizer_access_state',url),{method:'POST',headers,body:'{}'});
      if(!stateResponse.ok)return stateResponse;
      const state=await stateResponse.json();
      if(!organizerValid(state)){
        onRevoked();
        return new Response(JSON.stringify({code:'42501',message:ORGANIZER_EXPIRED}),{status:403,headers:{'Content-Type':'application/json'}});
      }
    }
    return fetch(input,init);
  };
}
