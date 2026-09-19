import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { Env, User, RuleRow, Candidate, Item } from './types.ts';
import { PRESETS, baseRule, validateRule, boundedInt, RUBRIC } from './core.ts';
import { checkpoint, getFeed, itemsByIds, rowItem, rateLimit, takeBudget, storeItem } from './db.ts';
import { enqueue, dispatch } from './tasks.ts';
import { hn, validateItem } from './sources.ts';
import { randomToken, sha256, same, hashPassword, verifyPassword, passwordValid, assertSameOrigin, localDevelopment, escapeHTML as e, richText } from './security.ts';
import { layout, controls, feedBody, itemBody, authForm, rulesBody, csrfInput, itemRows } from './views.ts';

type App={Bindings:Env;Variables:{user:User|null;csrf:string}};
type Ctx=Context<App>;
class UserError extends Error {
  status:400|401|403|404|409|410|429|503;
  constructor(message:string,status:UserError['status']=400){super(message);this.status=status;}
}
const app=new Hono<App>();
app.use('*',bodyLimit({maxSize:20000,onError:c=>c.text('Request too large',413)}));
function cookieName(c:Ctx,suffix:string){return `${localDevelopment(c.req.raw,c.env)?'jev_':'__Host-jev_'}${suffix}`;}
function cookie(c:Ctx,name:string,value:string,maxAge=1209600){
  setCookie(c,cookieName(c,name),value,{httpOnly:true,secure:!localDevelopment(c.req.raw,c.env),sameSite:'Lax',path:'/',maxAge});
}
app.use('*',async(c,next)=>{
  c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','strict-origin-when-cross-origin');
  c.header('Cache-Control','private, no-store');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://hn.algolia.com");
  c.set('user',null);c.set('csrf','');
  if(c.req.path==='/healthz'){await next();return;}
  const token=getCookie(c,cookieName(c,'session'));
  if(token&&token.length<100){
    const session=await c.env.DB.prepare('SELECT u.id,u.username,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(sha256(token),Date.now()).first<User>();
    if(session)c.set('user',session);
  }
  let csrf=c.get('user')?.csrf||getCookie(c,cookieName(c,'csrf'));
  if(!csrf||!/^[\w-]{43}$/.test(csrf)){csrf=randomToken();cookie(c,'csrf',csrf,3600);}
  c.set('csrf',csrf);await next();
});
app.onError((error,c)=>{
  const message=error instanceof UserError?error.message:'The request could not be completed. Please try again.';
  return c.html(layout('Request error',`<p class="notice">${e(message)}</p><p class="post-text"><a href="/">return home</a></p>`,c.get('user')||null,c.get('csrf')||''),error instanceof UserError?error.status:500);
});
app.notFound(c=>c.html(layout('Not found','<p class="notice">Page not found.</p>',c.get('user'),c.get('csrf')),404));
function user(c:Ctx):User{
  const u=c.get('user');if(!u)throw new UserError('Please log in to your JevNews account.',401);return u;
}
async function form(c:Ctx){
  try{assertSameOrigin(c.req.raw);}catch{throw new UserError('Cross-origin form submissions are not accepted.',403);}
  const data=await c.req.parseBody();const value=(name:string)=>typeof data[name]==='string'?data[name] as string:'';
  if(!same(value('csrf'),c.get('csrf')))throw new UserError('The form expired. Reload the page and try again.',403);return value;
}
async function challenge(c:Ctx,token:string){
  const ip=c.req.header('CF-Connecting-IP')||'local';
  if(!await rateLimit(c.env,'auth:'+sha256(ip),15))throw new UserError('Too many authentication attempts. Try again shortly.',429);
  if(localDevelopment(c.req.raw,c.env))return;
  if(!c.env.TURNSTILE_SECRET_KEY||!c.env.TURNSTILE_SITE_KEY||!c.env.TURNSTILE_HOSTNAME)throw new UserError('Registration and login are not configured yet.',503);
  const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:c.env.TURNSTILE_SECRET_KEY,response:token,remoteip:ip}),signal:AbortSignal.timeout(10000)});
  const d=await r.json() as {success:boolean;hostname:string;action:string};
  if(!r.ok||!d.success||d.hostname!==c.env.TURNSTILE_HOSTNAME||d.action!=='auth')throw new UserError('Please complete the security check.',403);
}
async function startSession(c:Ctx,id:string){
  const token=randomToken(),csrf=randomToken();
  await c.env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').bind(sha256(token),id,csrf,Date.now()+14*86400000).run();
  cookie(c,'session',token);c.set('csrf',csrf);
}
const usernameValid=(s:string)=>/^[a-zA-Z0-9_-]{3,24}$/.test(s);
app.get('/healthz',c=>c.json({service:'jevnews',version:'0.1.0',status:'ok'}));
for(const kind of ['login','register','recover'] as const){
  app.get('/'+kind,c=>c.html(layout(kind,authForm(kind,c.get('csrf'),localDevelopment(c.req.raw,c.env)?'':c.env.TURNSTILE_SITE_KEY),c.get('user'),c.get('csrf'))));
}
app.post('/register',async c=>{
  const f=await form(c);
  if(c.env.REGISTRATION_OPEN!=='true')throw new UserError('Registration is currently closed.',403);
  await challenge(c,f('cf-turnstile-response'));
  const name=f('username'),password=f('password');
  if(!usernameValid(name)||!passwordValid(password))throw new UserError('Use a 3–24 character username and a 12–128 character password.');
  if(!await takeBudget(c.env,'registrations',1,100))throw new UserError('Daily registration limit reached. Please return tomorrow.',429);
  const id=randomToken(),recovery=randomToken(),hash=await hashPassword(password);
  try{await c.env.DB.prepare('INSERT INTO users(id,username,password_hash,recovery_hash,created_at) VALUES(?,?,?,?,?)').bind(id,name,hash,sha256(recovery),Date.now()).run();}
  catch{throw new UserError('This username is unavailable.',409);}
  await startSession(c,id);
  return c.html(layout('Recovery code',`<div class="form-page"><h2>Save your recovery code</h2><p>This code is shown once. Email recovery is not enabled.</p><pre>${e(recovery)}</pre><p><a href="/rules">continue to my rules</a></p></div>`,{id,username:name,csrf:c.get('csrf')},c.get('csrf')));
});
app.post('/login',async c=>{
  const f=await form(c);await challenge(c,f('cf-turnstile-response'));
  const name=f('username'),password=f('password');
  if(!usernameValid(name)||!passwordValid(password))throw new UserError('Incorrect username or password.',401);
  if(!await rateLimit(c.env,'account-auth:'+sha256(name.toLowerCase()),8,60))throw new UserError('Too many attempts for this account.',429);
  const row=await c.env.DB.prepare('SELECT id,password_hash FROM users WHERE username=?').bind(name).first<{id:string;password_hash:string}>();
  const dummy='scrypt$32768$8$3$dummy-comparison-salt$'+'0'.repeat(64);
  const correct=await verifyPassword(password,row?.password_hash||dummy);
  if(!row||!correct)throw new UserError('Incorrect username or password.',401);
  await startSession(c,row.id);return c.redirect('/');
});
app.post('/recover',async c=>{
  const f=await form(c);await challenge(c,f('cf-turnstile-response'));
  if(!passwordValid(f('password'))||!usernameValid(f('username')))throw new UserError('Invalid recovery request.');
  const row=await c.env.DB.prepare('SELECT id,recovery_hash FROM users WHERE username=?').bind(f('username')).first<{id:string;recovery_hash:string}>();
  if(!row||!same(sha256(f('recovery')),row.recovery_hash))throw new UserError('Invalid recovery details.',401);
  const recovery=randomToken(),passwordHash=await hashPassword(f('password'));
  const changed=await c.env.DB.prepare('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=? RETURNING id').bind(passwordHash,sha256(recovery),row.id,row.recovery_hash).first();
  if(!changed)throw new UserError('This recovery code was already used.',409);
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.id).run();cookie(c,'session','',0);
  return c.html(layout('Recovered',`<div class="form-page"><p>Password changed. Save your NEW recovery code; the previous code is invalid.</p><pre>${e(recovery)}</pre><a href="/login">login</a></div>`,null,c.get('csrf')));
});
app.post('/logout',async c=>{
  await form(c);const token=getCookie(c,cookieName(c,'session'));
  if(token)await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(sha256(token)).run();
  cookie(c,'session','',0);cookie(c,'csrf','',0);return c.redirect('/');
});
app.get('/account',c=>{
  const u=user(c);
  return c.html(layout('Account',`<div class="form-page"><h2>${e(u.username)}</h2><p>Your JevNews account is separate from your HN profile.</p><a href="/rules">private rules</a> | <a href="/saved">saved</a> | <a href="/hidden">hidden</a><h3>Delete account</h3><form method="post" action="/account/delete">${csrfInput(c.get('csrf'))}<label>password: <input name="password" type="password" required></label><button>delete my account, rules and reading state</button></form></div>`,u,c.get('csrf')));
});
app.post('/account/delete',async c=>{
  const u=user(c),f=await form(c);
  if(!await rateLimit(c.env,'delete:'+u.id,5))throw new UserError('Try again later.',429);
  const row=await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(u.id).first<{password_hash:string}>();
  if(!row||!await verifyPassword(f('password'),row.password_hash))throw new UserError('Incorrect password.',401);
  const feeds=await c.env.DB.prepare('SELECT object_key FROM feeds WHERE owner_id=?').bind(u.id).all<{object_key:string}>();
  for(const r of feeds.results)await c.env.CONTENT.delete(r.object_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM jobs WHERE json_extract(payload,'$.owner')=?").bind(u.id),
    c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(u.id)
  ]);cookie(c,'session','',0);return c.redirect('/');
});
async function annotated(env:Env,ids:number[]):Promise<Candidate[]>{
  const out=new Map<number,Candidate>();
  for(let i=0;i<ids.length;i+=80){
    const p=ids.slice(i,i+80);if(!p.length)continue;
    const r=await env.DB.prepare(`SELECT h.*,d.content_hash,a.data_json FROM hn_items h LEFT JOIN documents d ON d.id=h.document_id LEFT JOIN analyses a ON a.content_hash=d.content_hash AND a.model=? AND a.rubric=? WHERE h.id IN (${p.map(()=>'?').join(',')})`).bind(env.JEV_MODEL,RUBRIC,...p).all<Record<string,unknown>>();
    for(const x of r.results)out.set(Number(x.id),{item:rowItem(x),analysis:x.data_json?JSON.parse(String(x.data_json)):null,documentHash:x.content_hash as string});
  }return ids.flatMap(id=>out.has(id)?[out.get(id)!]:[]);
}
async function livePublicRows(list:string,page=1):Promise<Candidate[]>{
  const ids=await hn<number[]>(list);
  if(!Array.isArray(ids))throw new Error('invalid_hn_list');
  const items=await Promise.all(ids.slice((page-1)*30,page*30).map(async id=>{
    try{return validateItem(await hn<unknown>(`item/${id}`),id);}
    catch{return null;}
  }));
  return items.filter((item):item is NonNullable<typeof item>=>!!item).map(item=>({item,analysis:null}));
}
async function listPage(c:Ctx,list?:string){
  const u=c.get('user'),url=new URL(c.req.url);
  let preset=c.req.query('preset')||getCookie(c,'jev_preset')||'balanced';
  if(!Object.hasOwn(PRESETS,preset))preset='balanced';
  if(c.req.query('preset'))setCookie(c,'jev_preset',preset,{sameSite:'Lax',secure:!localDevelopment(c.req.raw,c.env),path:'/',maxAge:31536000});
  const raw=c.req.query('view')==='hn'||!!list;
  let view=raw?`hn:${list||'topstories'}`:`jev:${preset}`,owner:string|null=null;let notice='';
  const ruleId=c.req.query('rule');
  if(ruleId){
    const account=user(c);const row=await c.env.DB.prepare('SELECT * FROM private_rules WHERE id=? AND owner_id=?').bind(ruleId,account.id).first<RuleRow>();
    if(!row)throw new UserError('Rule not found.',404);
    view=`private:${account.id}:${ruleId}:${row.version}`;owner=account.id;
    if(!await rateLimit(c.env,'private-feed:'+owner,30))throw new UserError('Please wait before rebuilding a private feed.',429);
    await enqueue(c.env,'private-feed',`${owner}:${ruleId}:${row.version}:${Math.floor(Date.now()/600000)}`,{owner,ruleId});
    c.executionCtx.waitUntil(dispatch(c.env));
    if(row.state!=='saved')notice='Showing the last saved rule. A new natural-language draft has not been applied.';
  }
  const page=boundedInt(c.req.query('page'),1,1,1000),picks=c.req.query('picks')==='1';
  let feed=null,rows:Candidate[]=[];
  try{
    feed=await getFeed(c.env,view,c.req.query('snapshot'),owner);
    if(c.req.query('snapshot')&&!feed)throw new UserError('This reading snapshot expired or does not belong to this view. Start again from the current list.',410);
    if(!feed&&!ruleId){await enqueue(c.env,'publish',String(Math.floor(Date.now()/600000)),{});c.executionCtx.waitUntil(dispatch(c.env));}
    const ids=(picks?feed?.picks:feed?.ids)||[];
    rows=await annotated(c.env,ids.slice((page-1)*30,page*30));
    if(u){
      const hidden=await c.env.DB.prepare('SELECT item_id FROM user_item_state WHERE owner_id=? AND hidden=1').bind(u.id).all<{item_id:number}>();
      const excluded=new Set(hidden.results.map(x=>x.item_id));rows=rows.filter(r=>!excluded.has(r.item.id));
    }
    if(!await checkpoint(c.env,'last_sync'))notice+=(notice?' ':'')+'No successful HN synchronization yet. An operator must configure and start the data pipeline.';
  }catch(error){
    if(ruleId||(!raw&&view.startsWith('private:'))||(c.req.query('snapshot')&&error instanceof UserError))throw error;
    rows=await livePublicRows(list||'newstories',page);
    notice+=(notice?' ':'')+(c.req.query('snapshot')?'Live Hacker News page while the saved snapshot is temporarily unavailable.':'Live Hacker News view while the shared feed is temporarily unavailable.');
  }
  return c.html(layout('JevNews',controls(preset,raw?'hn':'jev',picks)+(ruleId?'<p class="feed-meta">Private rule · <a href="/rules">edit</a></p>':'')+feedBody(rows,feed,url,page,u,c.get('csrf')),u,c.get('csrf'),notice));
}
app.get('/',c=>listPage(c));
app.get('/news',c=>listPage(c,c.req.query('view')==='hn'?'topstories':undefined));
for(const [route,list] of Object.entries({newest:'newstories',ask:'askstories',show:'showstories',jobs:'jobstories',best:'beststories'}))app.get('/'+route,c=>listPage(c,list));
app.get('/api/feed-version',async c=>{
  const view=c.req.query('view')||'';if(view.length>200)throw new UserError('Invalid view');
  if(view.startsWith('private:')&&!view.startsWith(`private:${c.get('user')?.id}:`))throw new UserError('Private view.',403);
  const row=await c.env.DB.prepare('SELECT feed_id AS id FROM feed_heads WHERE view_key=?').bind(view).first();return c.json(row||{id:null});
});
app.get('/item',async c=>{
  const id=boundedInt(c.req.query('id'),0,1,Number.MAX_SAFE_INTEGER);if(!id)throw new UserError('Invalid item ID.');
  const ip=sha256(c.req.header('CF-Connecting-IP')||'local');if(!await rateLimit(c.env,'item:'+ip,60))throw new UserError('Please slow down.',429);
  let root=(await itemsByIds(c.env,[id]))[0];
  if(!root){const remote=validateItem(await hn(`item/${id}`),id);if(!remote)throw new UserError('Item not found.',404);root=remote;await storeItem(c.env,root);}
  else await enqueue(c.env,'item',`${id}:${Math.floor(Date.now()/120000)}`,{id});
  const map=new Map<number,Item>();const pending=[...(root.kids||[])];let fetched=0;
  while(pending.length&&fetched<60){
    const ids=pending.splice(0,Math.min(10,60-fetched));const cached=await itemsByIds(c.env,ids);const known=new Map(cached.map(x=>[x.id,x]));
    for(const childId of ids){
      let child=known.get(childId);
      if(!child){try{const data=validateItem(await hn(`item/${childId}`),childId);if(data){child=data;await storeItem(c.env,child);}}catch{}}
      if(child){await enqueue(c.env,'item',`${child.id}:${Math.floor(Date.now()/120000)}`,{id:child.id});map.set(child.id,child);pending.push(...(child.kids||[]).filter(n=>!map.has(n)));}
      fetched++;
    }
  }
  c.executionCtx.waitUntil(dispatch(c.env));return c.html(layout(root.title||'Discussion',itemBody(root,map),c.get('user'),c.get('csrf')));
});
app.get('/user',async c=>{
  const name=c.req.query('id')||'';if(!/^[\w-]{1,40}$/.test(name))throw new UserError('Invalid HN username.');
  if(!await rateLimit(c.env,'profile:'+sha256(c.req.header('CF-Connecting-IP')||'local'),30))throw new UserError('Please slow down.',429);
  const cache=await checkpoint(c.env,'hn-user:'+name);let record=cache?JSON.parse(cache):null;
  if(!record||record.at<Date.now()-900000){
    const data=await hn<unknown>(`user/${name}`);if(!data)throw new UserError('HN user not found.',404);record={at:Date.now(),data};
    await c.env.DB.prepare('INSERT INTO checkpoints(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('hn-user:'+name,JSON.stringify(record),Date.now()).run();
  }
  const d=record.data;return c.html(layout(name,`<div class="form-page"><p>user: ${e(name)}</p><p>karma: ${e(d.karma)}</p><div>${richText(String(d.about||''))}</div><a href="https://news.ycombinator.com/user?id=${encodeURIComponent(name)}">profile on Hacker News</a></div>`,c.get('user'),c.get('csrf')));
});
app.get('/rules',async c=>{
  const u=user(c);const rows=await c.env.DB.prepare('SELECT * FROM private_rules WHERE owner_id=? ORDER BY created_at DESC').bind(u.id).all<RuleRow>();
  return c.html(layout('Private rules',rulesBody(rows.results,c.get('csrf')),u,c.get('csrf')));
});
app.post('/rules',async c=>{
  const u=user(c),f=await form(c);
  if(!await takeBudget(c.env,'rule-edits:'+u.id,1,20))throw new UserError('Daily rule editing limit reached.',429);
  const name=f('name').trim(),prompt=f('prompt').trim();if(!name||name.length>60||prompt.length>2000)throw new UserError('Invalid rule name or prompt.');
  const id=randomToken();
  try{await c.env.DB.prepare('INSERT INTO private_rules(id,owner_id,name,prompt,compiled_json,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,u.id,name,prompt,JSON.stringify(baseRule(f('base'))),prompt?'compiling':'saved',Date.now()).run();}
  catch{throw new UserError('You may save at most three rules.',409);}
  if(prompt){await enqueue(c.env,'compile',`${id}:1`,{ruleId:id,owner:u.id,version:1});c.executionCtx.waitUntil(dispatch(c.env));}
  return c.redirect('/rules');
});
app.post('/rules/recompile',async c=>{
  const u=user(c),f=await form(c);const prompt=f('prompt').trim();
  if(!prompt||prompt.length>2000)throw new UserError('Provide 1–2000 characters of reading standards.');
  if(!await takeBudget(c.env,'rule-edits:'+u.id,1,20))throw new UserError('Daily rule editing limit reached.',429);
  const row=await c.env.DB.prepare("UPDATE private_rules SET prompt=?,state='compiling',draft_json=NULL,version=version+1 WHERE id=? AND owner_id=? AND version=? RETURNING id,version").bind(prompt,f('id'),u.id,Number(f('version'))).first<{id:string;version:number}>();
  if(!row)throw new UserError('Rule changed or was not found.',409);
  await enqueue(c.env,'compile',`${row.id}:${row.version}`,{ruleId:row.id,owner:u.id,version:row.version});
  c.executionCtx.waitUntil(dispatch(c.env));return c.redirect('/rules');
});
app.post('/rules/save',async c=>{
  const u=user(c),f=await form(c);
  if(!await takeBudget(c.env,'rule-edits:'+u.id,1,20))throw new UserError('Daily rule editing limit reached.',429);
  let rule;try{rule=validateRule(JSON.parse(f('compiled')));}catch{throw new UserError('Invalid rule JSON. Only the documented rule schema is supported.');}
  if(rule.unsupported.length&&f('acknowledge')!=='1')throw new UserError('Acknowledge unsupported requirements before applying this rule.');
  const row=await c.env.DB.prepare("UPDATE private_rules SET compiled_json=?,draft_json=NULL,state='saved',version=version+1 WHERE id=? AND owner_id=? AND version=? RETURNING id,version").bind(JSON.stringify(rule),f('id'),u.id,Number(f('version'))).first<{id:string;version:number}>();
  if(!row)throw new UserError('The rule changed or was not found. Reload before saving.',409);
  await enqueue(c.env,'private-feed',`${u.id}:${row.id}:${row.version}`,{owner:u.id,ruleId:row.id});
  c.executionCtx.waitUntil(dispatch(c.env));return c.redirect('/?rule='+encodeURIComponent(row.id));
});
app.post('/rules/delete',async c=>{
  const u=user(c),f=await form(c);await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM jobs WHERE json_extract(payload,'$.owner')=? AND json_extract(payload,'$.ruleId')=?").bind(u.id,f('id')),
    c.env.DB.prepare('DELETE FROM private_rules WHERE id=? AND owner_id=?').bind(f('id'),u.id)
  ]);return c.redirect('/rules');
});
app.post('/item-state',async c=>{
  const u=user(c),f=await form(c);const id=boundedInt(f('id'),0,1,Number.MAX_SAFE_INTEGER),action=f('action');
  if(!id||!['hide','unhide','save','unsave'].includes(action))throw new UserError('Invalid reading-state request.');
  if(!await rateLimit(c.env,'state:'+u.id,60))throw new UserError('Please slow down.',429);
  const field=action.includes('hide')?'hidden':'saved';const value=action.startsWith('un')?0:1;
  await c.env.DB.prepare(`INSERT INTO user_item_state(owner_id,item_id,${field}) VALUES(?,?,?) ON CONFLICT(owner_id,item_id) DO UPDATE SET ${field}=excluded.${field}`).bind(u.id,id,value).run();
  return c.redirect(action.includes('hide')?'/hidden':'/saved');
});
for(const [path,field] of [['saved','saved'],['hidden','hidden']] as const){
  app.get('/'+path,async c=>{
    const u=c.get('user');
    if(!u)return c.html(layout(path,`<div class="form-page"><h2>${path} locally</h2><p>Only this browser's IDs are stored. Register to save reading state across devices.</p><ul id="local-state" data-state="${field==='hidden'?'hidden':'saved'}"></ul><noscript>Local reading state needs JavaScript.</noscript></div>`,null,c.get('csrf')));
    const ids=await c.env.DB.prepare(`SELECT item_id FROM user_item_state WHERE owner_id=? AND ${field}=1 ORDER BY item_id DESC LIMIT 300`).bind(u.id).all<{item_id:number}>();
    const rows=await annotated(c.env,ids.results.map(r=>r.item_id));
    return c.html(layout(path,`<div class="form-page"><h2>${path}</h2><p>JevNews state only; does not change HN.</p></div><table class="itemlist">${itemRows(rows,0,u,c.get('csrf'))}</table><div class="form-page">${ids.results.map(r=>`<form method="post" action="/item-state">${csrfInput(c.get('csrf'))}<input type="hidden" name="id" value="${r.item_id}"><button name="action" value="${field==='hidden'?'unhide':'unsave'}">${field==='hidden'?'unhide':'unsave'} #${r.item_id}</button></form>`).join('')}</div>`,u,c.get('csrf')));
  });
}
app.get('/about',c=>c.html(layout('About',`<div class="form-page"><h2>JevNews</h2><p>Independent Hacker News reader with shared article analysis and your own reading standards. No HN credentials are accepted. Votes, replies and submissions happen on HN.</p><h3>Privacy</h3><p>We store your username, salted password hash, recovery-code hash, hashed sessions, private rules and saved/hidden item IDs. Authentication and costly actions are rate limited. Rule text is sent to Cloudflare Workers AI; article text and special conditions may be sent to TypeSafe. We do not send passwords or session tokens to AI providers.</p><p>Account deletion removes account-bound records and accessible private snapshots. Operational AI-call records contain no prompt text. Source text is internal, not a public mirror. Cloudflare R2 lifecycle expiration must be enabled as described in the deployment guide.</p><p>Analysis is probabilistic and may be incomplete; no universal quality or factual-correctness score is promised. Site operators must publish their contact information before a public launch.</p></div>`,c.get('user'),c.get('csrf'))));
function admin(c:Ctx){
  const token=c.env.ADMIN_TOKEN;if(!token||token.length<32||!same(c.req.header('authorization')||'',`Bearer ${token}`))throw new UserError('Not found.',404);
}
app.post('/internal/sync',async c=>{
  admin(c);const object=c.env.SYNC.get(c.env.SYNC.idFromName('hn-global-v1'));return object.fetch(new Request('https://internal/run',{method:'POST'}));
});
app.get('/internal/status',async c=>{
  admin(c);const jobs=await c.env.DB.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all();
  const progress=await c.env.DB.prepare("SELECT key,value,updated_at FROM checkpoints WHERE key IN ('last_sync','scan_cursor','observed_max','coverage_since','backfill_cursor','sync_error')").all();
  const budget=await c.env.DB.prepare('SELECT scope,amount FROM budgets WHERE day=?').bind(new Date().toISOString().slice(0,10)).all();
  return c.json({jobs:jobs.results,progress:progress.results,budget:budget.results});
});
export default app;
