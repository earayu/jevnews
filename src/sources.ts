import type { Item } from './types.ts';
import { publicURL, publicIP, plainText } from './security.ts';
const HN='https://hacker-news.firebaseio.com/v0/';
export async function limitedText(response:Response,max=2000000):Promise<string>{
  if(Number(response.headers.get('content-length'))>max)throw new Error('source_too_large');
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error('source_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return new TextDecoder().decode(bytes);
}
export async function hn<T>(path:string,fetcher:typeof fetch=fetch):Promise<T>{
  if(!/^(newstories|topstories|beststories|askstories|showstories|jobstories|maxitem|updates|item\/\d+|user\/[\w-]+)$/.test(path))throw new Error('invalid_hn_path');
  const r=await fetcher(HN+path+'.json',{signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(`hn_http_${r.status}`);return JSON.parse(await limitedText(r,1000000)) as T;
}
export function validateItem(value:unknown,id:number):Item|null{
  if(value===null)return null;const v=value as Item;if(!v||v.id!==id||typeof v.type!=='string')throw new Error('invalid_hn_item');
  return {...v,title:typeof v.title==='string'?v.title.slice(0,1000):'',text:typeof v.text==='string'?v.text.slice(0,200000):'',kids:Array.isArray(v.kids)?v.kids.filter(n=>Number.isSafeInteger(n)&&n>0):[]};
}
export async function verifyDNS(host:string,fetcher:typeof fetch=fetch){
  const answers=await Promise.all(['A','AAAA'].map(async type=>{
    const r=await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw new Error('dns_failed');const d=JSON.parse(await limitedText(r,50000)) as {Status:number;Answer?:{type:number;data:string}[]};
    if(d.Status!==0)throw new Error('dns_failed');return d.Answer||[];
  }));
  const ips=answers.flat().filter(a=>a.type===1||a.type===28).map(a=>a.data);
  if(!ips.length||ips.some(ip=>!publicIP(ip)))throw new Error('private_or_unknown_dns');
}
export function robotsAllowed(text:string,path:string):boolean{
  const groups:{agents:string[];rules:{allow:boolean;path:string}[]}[]=[];
  let group:{agents:string[];rules:{allow:boolean;path:string}[]}|null=null;
  for(const raw of text.split(/\r?\n/)){
    const line=raw.split('#')[0]!.trim(),index=line.indexOf(':');if(index<0)continue;
    const k=line.slice(0,index).trim().toLowerCase(),v=line.slice(index+1).trim();
    if(k==='user-agent'){if(!group||group.rules.length){group={agents:[],rules:[]};groups.push(group);}group.agents.push(v.toLowerCase());}
    else if(group&&(k==='allow'||k==='disallow')&&v)group.rules.push({allow:k==='allow',path:v});
  }
  const specific=groups.filter(g=>g.agents.some(a=>a==='jevnews'));const applicable=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
  let best=-1,allow=true;
  for(const r of applicable.flatMap(g=>g.rules)){
    const pattern=r.path.replace(/[.+?^{}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');
    if(new RegExp('^'+pattern).test(path)&&(r.path.length>best||r.path.length===best&&r.allow)){best=r.path.length;allow=r.allow;}
  }return allow;
}
export async function fetchDocument(raw:string,fetcher:typeof fetch=fetch):Promise<{text:string;scope:'extracted'|'truncated';url:string}>{
  let url=publicURL(raw);const checked=new Map<string,string>();
  for(let redirects=0;redirects<5;redirects++){
    await verifyDNS(url.hostname,fetcher);
    if(!checked.has(url.origin)){
      const robots=await fetcher(url.origin+'/robots.txt',{redirect:'manual',headers:{'user-agent':'JevNews/0.1 (+https://github.com/earayu/jevnews)'},signal:AbortSignal.timeout(8000)});
      if(robots.status>=300&&robots.status!==404&&robots.status!==410)throw new Error('robots_unavailable_or_redirected');
      checked.set(url.origin,robots.ok?await limitedText(robots,200000):'');
    }
    if(!robotsAllowed(checked.get(url.origin)||'',url.pathname+url.search))throw new Error('robots_disallowed');
    const r=await fetcher(url.href,{redirect:'manual',headers:{'user-agent':'JevNews/0.1 (+https://github.com/earayu/jevnews)',accept:'text/html,text/plain;q=0.9'},signal:AbortSignal.timeout(12000)});
    if(r.status>=300&&r.status<400){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw new Error('invalid_redirect');url=publicURL(new URL(location,url).href);continue;}
    if(!r.ok)throw new Error(`source_http_${r.status}`);
    const type=r.headers.get('content-type')||'';if(!/text\/(html|plain)|application\/xhtml\+xml/.test(type)){await r.body?.cancel();throw new Error('unsupported_source_type');}
    const source=await limitedText(r);const main=source.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2]||source;
    const text=type.includes('text/plain')?source:plainText(main);if(text.length<120)throw new Error('insufficient_source_text');
    return {text:text.slice(0,28000),scope:text.length>28000?'truncated':'extracted',url:url.href};
  }throw new Error('too_many_redirects');
}
