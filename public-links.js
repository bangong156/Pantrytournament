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
