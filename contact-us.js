export function openContactUs(){
  if(document.querySelector('.contact-dialog'))return;
  const previousFocus=document.activeElement,previousOverflow=document.body.style.overflow;
  const dialog=document.createElement('dialog');dialog.className='guide-dialog contact-dialog';
  dialog.setAttribute('aria-labelledby','contact-title');
  dialog.innerHTML=`<div class="guide-shell"><div class="guide-header"><h2 id="contact-title">CONTACT US</h2><button type="button" class="guide-close" aria-label="Close contact us" autofocus>×</button></div><div class="contact-content"><p>@Copyright by Lan Do ( The Pantry Founder )</p><p>Contact: <a href="tel:0943775990">0943775990</a></p></div></div>`;
  document.body.append(dialog);document.body.style.overflow='hidden';dialog.showModal();
  dialog.querySelector('.guide-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
  dialog.addEventListener('close',()=>{
    document.body.style.overflow=previousOverflow;dialog.remove();
    (previousFocus?.isConnected?previousFocus:document.querySelector('#contactUsButton'))?.focus();
  },{once:true});
}
