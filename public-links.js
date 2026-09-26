export function linkedTournament(search){
  const id=new URLSearchParams(search).get('tournament');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')?id:null;
}
export function tournamentURL(id){
  const url=new URL('/',location.origin);
  url.searchParams.set('tournament',id);
  url.searchParams.set('view','info');
  return url.href;
}
export async function shareTournament(id,name){
  const url=tournamentURL(id);
  if(navigator.share){
    try{await navigator.share({title:name,text:name,url});return 'Đã chia sẻ'}
    catch(error){if(error.name==='AbortError')return '';}
  }
  await navigator.clipboard.writeText(url);
  return 'Đã sao chép link giải';
}

// Detail links require an explicit event; never fall back to the default event.
export function publicRoute(search){
  const params=new URLSearchParams(search),tournament=linkedTournament(search);
  const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
  const event=params.get('event'),match=params.get('match'),team=params.get('team');
  const detail=params.has('match')||params.has('team');
  return {tournament,event,match,team,info:params.get('view')==='info',invalid:!tournament||(params.has('event')&&!uuid(event))||(detail&&(!uuid(event)||(params.has('match')&&!uuid(match))||(params.has('team')&&!uuid(team))||!!(match&&team)))};
}
export function competitionURL(tournament,event){
  const url=new URL('/',location.origin);url.searchParams.set('tournament',tournament);
  if(event)url.searchParams.set('event',event);
  return url.href;
}
export function matchURL(tournament,event,match){
  const url=new URL(competitionURL(tournament,event));url.searchParams.set('match',match);return url.href;
}
export function teamURL(tournament,event,team){
  const url=new URL(competitionURL(tournament,event));url.searchParams.set('team',team);return url.href;
}
async function sharePublicURL(url,title,copied){
  if(navigator.share){
    try{await navigator.share({title,text:title,url});return 'Đã chia sẻ'}
    catch(error){if(error.name==='AbortError')return '';}
  }
  await navigator.clipboard.writeText(url);return copied;
}
export const shareMatch=(tournament,event,match,title)=>sharePublicURL(matchURL(tournament,event,match),title,'Đã sao chép link trận');
export const shareTeam=(tournament,event,team,title)=>sharePublicURL(teamURL(tournament,event,team),title,'Đã sao chép link hành trình');
