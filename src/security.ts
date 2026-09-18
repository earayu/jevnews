import { scrypt, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

export const randomToken=()=>randomBytes(32).toString('base64url');
export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
export function same(a:string,b:string){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function passwordValid(s:string){return s.length>=12 && s.length<=128 && Buffer.byteLength(s)<=512;}
function derive(password:string,salt:string):Promise<Buffer> {
  return new Promise((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
}
export async function hashPassword(password:string){
  if(!passwordValid(password))throw new Error('Password must have 12–128 characters');
  const salt=randomToken();return `scrypt$32768$8$3$${salt}$${(await derive(password,salt)).toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string){
  const p=encoded.split('$');
  if(p.length!==6||p[0]!=='scrypt'||p[1]!=='32768'||p[2]!=='8'||p[3]!=='3'||!passwordValid(password)||!/^[a-f0-9]{64}$/.test(p[5]!))return false;
  return same((await derive(password,p[4]!)).toString('hex'),p[5]!);
}
export function escapeHTML(x:unknown):string{
  return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
export function decodeEntities(s:string){return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(m,x:string)=>{
  if(x[0]==='#'){const n=x[1]?.toLowerCase()==='x'?parseInt(x.slice(2),16):Number(x.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'�';}
  return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[x.toLowerCase()]||m;
});}
export function safeLink(s:string,base='https://news.ycombinator.com/'):string {
  try{const u=new URL(s,base);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:'#';}catch{return '#';}
}
/** Reconstruct a tiny HTML allowlist; no source attribute or unknown tag is ever emitted. */
export function richText(source:string):string {
  const allowed=new Set(['p','i','em','b','strong','pre','code','ul','ol','li','blockquote']);
  const stack:string[]=[];let out='';
  for(const token of source.match(/<[^>]*>|[^<]+|</g)||[]){
    const closing=token.match(/^<\/(\w+)\s*>$/);
    if(closing){const tag=closing[1]!.toLowerCase();const i=stack.lastIndexOf(tag);if(i>=0)while(stack.length>i)out+=`</${stack.pop()}>`;continue;}
    const opening=token.match(/^<(\w+)(\s[^<>]*|\s*)>$/);
    if(opening){
      const tag=opening[1]!.toLowerCase();
      if(allowed.has(tag)){out+=`<${tag}>`;stack.push(tag);continue;}
      if(tag==='br'){out+='<br>';continue;}
      if(tag==='a'){
        const href=token.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        out+=`<a href="${escapeHTML(safeLink(decodeEntities(href?.[1]??href?.[2]??href?.[3]??'')))}" rel="nofollow noopener noreferrer">`;
        stack.push('a');continue;
      }
    }
    out+=escapeHTML(decodeEntities(token));
  }
  while(stack.length)out+=`</${stack.pop()}>`;return out;
}
export function plainText(html:string):string {
  return decodeEntities(html.replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<\/(p|div|li|h[1-6]|pre)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim();
}
export function publicURL(raw:string):URL {
  const u=new URL(raw);const h=u.hostname.toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||!h.includes('.')||h.includes(':')||/^\d[\d.]*$/.test(h)||h==='localhost'||/\.(localhost|local|internal|lan|test|invalid|example|onion)$/.test(h))throw new Error('unsafe_source_url');
  u.hash='';return u;
}
export function publicIP(ip:string):boolean {
  if(ip.includes(':'))return /^[23][0-9a-f]{0,3}:/i.test(ip)&&!/^2001:(db8|0):/i.test(ip);
  const p=ip.split('.').map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const [a,b]=p;
  return !(a===0||a===10||a===127||a!>=224||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0)||a===100&&b!>=64&&b!<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
}
export function assertSameOrigin(request:Request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('cross_origin');}
export function localDevelopment(request:Request,env:{APP_ENV:string}){
  return env.APP_ENV==='development'&&['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
}
