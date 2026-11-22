export function knockoutPodium(matches, teams, members = {}, saved = []) {
  const rounds = matches.filter(match => match.stage !== 'group');
  const losers = rounds.filter(match => match.stage === 'semifinal');
  const finals = rounds.filter(match => match.stage === 'final');
  const bronze = rounds.filter(match => match.stage === 'third_place');
  const names = new Map(teams.map(team => [team.id, team.name]));
  const valid = match => match.status === 'completed'
    && match.team1_id !== match.team2_id
    && names.has(match.team1_id) && names.has(match.team2_id)
    && [match.team1_id, match.team2_id].includes(match.winner_id);
  if (finals.length !== 1 || !rounds.every(valid) || bronze.length > 1) return [];
  const final = finals[0];
  const runnerUp = match => match.winner_id === match.team1_id ? match.team2_id : match.team1_id;
  const thirds = bronze.length ? [bronze[0].winner_id] :
    losers.sort((a,b) => String(a.match_code).localeCompare(String(b.match_code),'vi',{numeric:true})).map(runnerUp);
  const ids = [final.winner_id, runnerUp(final), ...thirds];
  if (thirds.length < 1 || thirds.length > 2 || new Set(ids).size !== ids.length) return [];
  return ids.map((team_id, i) => {
    const placement = Math.min(i + 1, 3);
    const placement_slot = i === 3 ? 2 : 1;
    const custom = saved.find(row => row.placement === placement && row.placement_slot === placement_slot && row.team_id === team_id);
    const players = members[team_id] || '';
    return {
      placement, placement_slot, team_id,
      team_name: custom?.team_name || names.get(team_id),
      player_names: custom?.player_names || (Array.isArray(players) ? players.join('\n') : players)
    };
  });
}

export function downloadAwardsPoster({title, event, awards}) {
  const canvas = document.createElement('canvas');
  canvas.width = 1440;
  canvas.height = 1800;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, '#314a31');
  background.addColorStop(.55, '#13251e');
  background.addColorStop(1, '#091916');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#e9d28c25';
  ctx.lineWidth = 4;
  ctx.strokeRect(48, 48, w - 96, h - 96);
  ctx.strokeRect(75, 75, w - 150, h - 150);
  ctx.beginPath();
  ctx.moveTo(80, 480); ctx.lineTo(1360, 480);
  ctx.moveTo(80, 1610); ctx.lineTo(1360, 1610);
  ctx.moveTo(720, 480); ctx.lineTo(720, 1610);
  ctx.stroke();

  function line(value, y, size, color, maxWidth = 1220, weight = 800) {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(value, w / 2, y, maxWidth);
  }
  line('T H E   P A N T R Y   P I C K L E B A L L', 167, 32, '#f2d996');
  line('VINH DANH', 310, 116, '#fff8e6');
  line(title, 394, 49, '#f6f2de');
  if (event && event !== title) line(event, 449, 36, '#cfd9b9', 1150, 550);

  const colors = {1:'#ffe091', 2:'#deebee', 3:'#f4ba91'};
  const labels = {1:'VÔ ĐỊCH', 2:'Á QUÂN', 3:'HẠNG BA'};
  const tied = awards.filter(row => row.placement === 3).length > 1;
  const start = 526;
  awards.forEach((award, i) => {
    const y = start + i * 267;
    const accent = colors[award.placement];
    const fill = ctx.createLinearGradient(110, y, 1330, y + 225);
    fill.addColorStop(0, '#203f31');
    fill.addColorStop(1, '#2d4936');
    ctx.beginPath();
    ctx.roundRect(112, y, 1216, 228, 26);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = award.placement === 1 ? 5 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(227, y + 114, 66, 0, 2 * Math.PI);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#17291f';
    ctx.font = '900 64px system-ui, sans-serif';
    ctx.fillText(String(award.placement), 227, y + 136);
    ctx.textAlign = 'left';
    ctx.fillStyle = accent;
    ctx.font = '800 27px system-ui, sans-serif';
    ctx.fillText(tied && award.placement === 3 ? 'ĐỒNG HẠNG BA' : labels[award.placement], 330, y + 62);
    ctx.fillStyle = '#fff9e9';
    ctx.font = `800 ${award.placement === 1 ? 57 : 48}px system-ui, sans-serif`;
    ctx.fillText(award.team_name || '', 330, y + 132, 940);
    const players = (award.player_names || '').split('\n').filter(Boolean).join('  ·  ');
    ctx.font = '500 30px system-ui, sans-serif';
    ctx.fillStyle = '#d2dfca';
    if (players) ctx.fillText(players, 330, y + 185, 940);
  });
  line('GIAIPANTRY.COM', 1695, 29, '#e9d28c');
  const link = document.createElement('a');
  link.download = 'vinh-danh-giai-pantry.png';
  link.href = canvas.toDataURL('image/png');
  document.body.append(link);
  link.click();
  link.remove();
}
