import {VideoError,validUUID} from './video-security.js';

// Resolve ownership from the current match, never from client-supplied IDs.
export async function requireVideoMatch(repository,matchId){
  if(!validUUID(matchId))throw new VideoError(400,'Mã trận đấu không hợp lệ.');
  const match=await repository.match(matchId);
  if(!match)throw new VideoError(404,'Trận đấu không còn tồn tại.');
  if(!validUUID(match.event_id)||!validUUID(match.tournament_id)){
    throw new VideoError(409,'Trận đấu chưa có thông tin giải đấu hợp lệ.');
  }
  return match;
}

// Sessions retain cleanup state after deletion or regrouping, but must no
// longer authorize publishing or viewing a match whose ownership changed.
export async function requireVideoSessionMatch(repository,session){
  const match=await requireVideoMatch(repository,session.match_id);
  if(match.event_id!==session.event_id||match.tournament_id!==session.tournament_id){
    throw new VideoError(409,'Trận đấu đã đổi nội dung hoặc giải đấu. Hãy tạo phiên LIVE mới.');
  }
  return match;
}
