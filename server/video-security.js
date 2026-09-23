import {createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual} from 'node:crypto';
export class VideoError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const capability=()=>randomBytes(32).toString('base64url');
export const validUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function matchesToken(token,hash){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!hash)return false;
  const expected=Buffer.from(hash,'hex'),actual=Buffer.from(digest(token),'hex');
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
export function secretBox(base64Key){
  const key=Buffer.from(base64Key||'','base64');
  if(key.length!==32)throw new VideoError(503,'LIVE chưa được cấu hình.');
  return {
    seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');},
    open(value){const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8'));}
  };
}
export function cloudflareURL(value,{suffix,origin}={}){
  let u;try{u=new URL(value)}catch{throw new VideoError(502,'Cloudflare trả về địa chỉ không hợp lệ.');}
  if(u.protocol!=='https:'||!/^customer-[a-z0-9-]+\.cloudflarestream\.com$/.test(u.hostname)||u.port||u.username||u.password||u.hash||(origin&&u.origin!==origin)||(suffix&&!u.pathname.endsWith(suffix)))throw new VideoError(502,'Cloudflare trả về địa chỉ không hợp lệ.');
  return u.href;
}
