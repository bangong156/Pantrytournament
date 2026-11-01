// Shared PWA installation and service worker setup.
const isNative=window.Capacitor?.isNativePlatform?.()||['localhost','127.0.0.1'].includes(location.hostname);
if(!isNative&&'serviceWorker' in navigator&&location.protocol==='https:'){
 window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(err=>console.warn('PWA service worker:',err)));
}
let deferredPrompt;
window.addEventListener('beforeinstallprompt',event=>{
 event.preventDefault();deferredPrompt=event;
 const button=document.getElementById('pantry-install-app');
 if(button)button.hidden=false;
});
window.addEventListener('appinstalled',()=>{deferredPrompt=null;const button=document.getElementById('pantry-install-app');if(button)button.hidden=true});
function installButton(){
 if(isNative||window.matchMedia('(display-mode: standalone)').matches)return;
 const button=document.createElement('button');
 button.id='pantry-install-app';button.type='button';button.textContent='📲 Cài ứng dụng';button.hidden=!deferredPrompt;
 button.style.cssText='position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:9999;padding:11px 15px;border-radius:12px;background:#2d3924;color:white;border:1px solid #cde69b;box-shadow:0 4px 18px #0004;font:700 13px system-ui;cursor:pointer';
 button.addEventListener('click',async()=>{
  if(!deferredPrompt)return;
  const prompt=deferredPrompt;deferredPrompt=null;button.hidden=true;
  await prompt.prompt();
  await prompt.userChoice.catch(()=>{});
 });
 document.body.append(button);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installButton);else installButton();
