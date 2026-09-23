// Established spreadsheet column order: doubles (two players, or one pair
// column); MLP (team name, then the configured member slots).
export function parseRosterRows(rows,format,memberCount=2) {
  const data=rows.map(row=>row.map(cell=>String(cell??'').trim())).filter(row=>row.some(Boolean));
  if (!data.length) throw new Error('File không có dữ liệu.');
  const header=data[0].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (/ten doi|vdv|vđv|cap vd|cap vđ|player|team name|nam 1|nu 1/.test(header)) data.shift();
  if (!data.length) throw new Error('File chỉ có tiêu đề.');
  return data.map((row,index)=>{
    const names=format==='mlp'?row.slice(1,memberCount+1):row[1]?row.slice(0,2):row[0].split(/\s+[-–—/]\s+/);
    const required=format==='mlp'?memberCount:2;
    if(names.length!==required||names.some(name=>!name.trim()))throw new Error(`Dòng ${index+1}: cần đủ ${required} tên VĐV.`);
    const name=format==='mlp'?row[0]:names.join(' - ');
    if(!name)throw new Error(`Dòng ${index+1}: thiếu tên đội.`);
    return {name,names:names.map(name=>name.trim())};
  });
}
