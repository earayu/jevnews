import type { Env, Item, Candidate, Analysis, Feed } from './types.ts';
import { RUBRIC, boundedInt } from './core.ts';
import { randomToken } from './security.ts';

export async function checkpoint(env:Env,key:string):Promise<string|null>{return (await env.DB.prepare('SELECT value FROM checkpoints WHERE key=?').bind(key).first<{value:string}>())?.value??null;}
export async function putCheckpoint(env:Env,key:string,value:string){await env.DB.prepare('INSERT INTO checkpoints(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,value,Date.now()).run();}
export function rowItem(r:Record<string,unknown>):Item {
  return {id:Number(r.id),type:String(r.type),title:r.title as string,url:r.url as string,by:r.author as string,time:Number(r.posted_at),score:Number(r.score),descendants:Number(r.descendants),parent:r.parent?Number(r.parent):undefined,kids:JSON.parse(String(r.kids_json||'[]')),text:String(r.text_html||''),deleted:!!r.deleted,dead:!!r.dead};
}
export async function itemsByIds(env:Env,ids:number[]):Promise<Item[]>{
  const map=new Map<number,Item>();
  for(let start=0;start<ids.length;start+=80){
    const part=ids.slice(start,start+80);
    const rows=await env.DB.prepare(`SELECT * FROM hn_items WHERE id IN (${part.map(()=>'?').join(',')})`).bind(...part).all<Record<string,unknown>>();
    for(const r of rows.results){const i=rowItem(r);map.set(i.id,i);}
  }
  return ids.flatMap(id=>map.has(id)?[map.get(id)!]:[]);
}
export async function storeItem(env:Env,item:Item){
  await env.DB.prepare(`INSERT INTO hn_items(id,type,title,url,author,posted_at,score,descendants,parent,kids_json,text_html,deleted,dead,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,title=excluded.title,url=excluded.url,author=excluded.author,posted_at=excluded.posted_at,score=excluded.score,descendants=excluded.descendants,parent=excluded.parent,kids_json=excluded.kids_json,text_html=excluded.text_html,deleted=excluded.deleted,dead=excluded.dead,synced_at=excluded.synced_at WHERE hn_items.type IS NOT excluded.type OR hn_items.title IS NOT excluded.title OR hn_items.url IS NOT excluded.url OR hn_items.author IS NOT excluded.author OR hn_items.posted_at IS NOT excluded.posted_at OR hn_items.score IS NOT excluded.score OR hn_items.descendants IS NOT excluded.descendants OR hn_items.parent IS NOT excluded.parent OR hn_items.kids_json IS NOT excluded.kids_json OR hn_items.text_html IS NOT excluded.text_html OR hn_items.deleted IS NOT excluded.deleted OR hn_items.dead IS NOT excluded.dead`).bind(item.id,item.type||'unknown',item.title??null,item.url??null,item.by??null,item.time||0,item.score||0,item.descendants||0,item.parent??null,JSON.stringify(item.kids||[]),item.deleted?'':item.text||'',+!!item.deleted,+!!item.dead,Date.now()).run();
}
export async function candidates(env:Env):Promise<{rows:Candidate[];limited:boolean}>{
  const cap=boundedInt(env.MAX_CANDIDATES,10000,100,20000);
  const rows=await env.DB.prepare(`SELECT h.*,d.content_hash,a.data_json FROM hn_items h LEFT JOIN documents d ON d.id=h.document_id LEFT JOIN analyses a ON a.content_hash=d.content_hash AND a.model=? AND a.rubric=? WHERE h.type IN ('story','poll') AND h.posted_at>=? AND h.deleted=0 AND h.dead=0 ORDER BY h.posted_at DESC LIMIT ?`).bind(env.JEV_MODEL,RUBRIC,Math.floor(Date.now()/1000)-7*86400,cap+1).all<Record<string,unknown>>();
  return {limited:rows.results.length>cap,rows:rows.results.slice(0,cap).map(r=>({item:rowItem(r),analysis:r.data_json?JSON.parse(String(r.data_json)) as Analysis:null,documentHash:r.content_hash?String(r.content_hash):undefined}))};
}
export async function saveFeed(env:Env,view:string,ids:number[],picks:number[],coverage:string,owner:string|null=null):Promise<Feed>{
  const now=Date.now(),id=randomToken(),key=`snapshots/${id}.json`;
  const feed:Feed={id,view,owner,ids,picks,coverage,createdAt:now,expiresAt:now+(owner?86400:172800)*1000};
  await env.CONTENT.put(key,JSON.stringify(feed),{httpMetadata:{contentType:'application/json'}});
  await env.DB.batch([
    env.DB.prepare('INSERT INTO feeds(id,view_key,owner_id,object_key,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,view,owner,key,now,feed.expiresAt),
    env.DB.prepare('INSERT INTO feed_heads(view_key,feed_id) VALUES(?,?) ON CONFLICT(view_key) DO UPDATE SET feed_id=excluded.feed_id').bind(view,id)
  ]);return feed;
}
export async function getFeed(env:Env,view:string,id:string|undefined,owner:string|null):Promise<Feed|null>{
  const row=id?await env.DB.prepare('SELECT * FROM feeds WHERE id=?').bind(id).first<Record<string,unknown>>():await env.DB.prepare('SELECT f.* FROM feed_heads p JOIN feeds f ON f.id=p.feed_id WHERE p.view_key=?').bind(view).first<Record<string,unknown>>();
  if(!row||row.view_key!==view||row.owner_id!==owner||Number(row.expires_at)<Date.now())return null;
  const object=await env.CONTENT.get(String(row.object_key));return object?object.json<Feed>():null;
}
export async function takeBudget(env:Env,scope:string,amount:number,limit:number):Promise<boolean>{
  if(!Number.isSafeInteger(amount)||amount<1||!Number.isFinite(limit)||amount>limit)return false;
  const row=await env.DB.prepare(`INSERT INTO budgets(day,scope,amount) VALUES(?,?,?) ON CONFLICT(day,scope) DO UPDATE SET amount=amount+excluded.amount WHERE amount+excluded.amount<=? RETURNING amount`).bind(new Date().toISOString().slice(0,10),scope,amount,limit).first();return !!row;
}
export async function rateLimit(env:Env,key:string,limit:number,seconds=60):Promise<boolean>{
  const row=await env.DB.prepare(`INSERT INTO request_limits(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`).bind(key,Math.floor(Date.now()/1000/seconds),limit).first();return !!row;
}
