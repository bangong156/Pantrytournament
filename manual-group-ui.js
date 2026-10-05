// Presentation-only cleanup for the manual group board.
// The existing select and its assignment handlers remain untouched.
function cleanMoveGroupLabels(root=document){
  root.querySelectorAll('select[data-move-team]').forEach(select=>{
    const label=select.closest('label');
    if(!label)return;
    [...label.childNodes].forEach(node=>{
      if(node.nodeType===Node.TEXT_NODE && node.textContent.trim().toUpperCase()==='CHUYỂN BẢNG') node.remove();
    });
    select.title='Chọn bảng';
    const team=select.closest('.group-team')?.querySelector('b')?.textContent?.trim();
    select.setAttribute('aria-label',team?`Chọn bảng cho ${team}`:'Chọn bảng');
  });
}

const observer=new MutationObserver(records=>{
  for(const record of records){
    for(const node of record.addedNodes){
      if(node.nodeType!==Node.ELEMENT_NODE)continue;
      if(node.matches?.('select[data-move-team], .group-board, .group-team') || node.querySelector?.('select[data-move-team]')){
        cleanMoveGroupLabels(node.matches?.('select[data-move-team]')?node.parentElement:node);
      }
    }
  }
});

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',()=>{
    cleanMoveGroupLabels();
    observer.observe(document.body,{childList:true,subtree:true});
  },{once:true});
}else{
  cleanMoveGroupLabels();
  observer.observe(document.body,{childList:true,subtree:true});
}
