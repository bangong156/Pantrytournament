// Stable Auth identifier for username accounts; no email inbox is required.
const USERNAME_DOMAIN='accounts.pantry.invalid';
export function normalizeUsername(value){
 const username=String(value??'').trim().toLowerCase();
 if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))throw new Error('Tên đăng nhập từ 3–40 ký tự, gồm chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.');
 return username;
}
export function usernameEmail(value){return `${normalizeUsername(value)}@${USERNAME_DOMAIN}`}
export function loginEmail(value){
 const login=String(value??'').trim();
 // Existing accounts retain their original credentials.
 return login.includes('@')?login:usernameEmail(login);
}
export function accountLogin(email){
 const value=String(email??'');
 return value.endsWith(`@${USERNAME_DOMAIN}`)?value.slice(0,-USERNAME_DOMAIN.length-1):value;
}
