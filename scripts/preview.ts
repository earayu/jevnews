/** Local-only fixture preview. Does not fetch HN or call an AI provider. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import app from '../src/web.ts';
import { makeEnv } from '../test/helpers.ts';
import { storeItem, saveFeed } from '../src/db.ts';
import { PRESETS, baseRule, rank } from '../src/core.ts';
import type { Candidate } from '../src/types.ts';
const fixture=makeEnv();
const themes=['A database recovery experiment','Building a small task runner','Notes from an Agent evaluation','Why this query became slower','An optical instrument made at home','A product pricing field report','The mathematics behind a simple game'];
const candidates:Candidate[]=[];
for(let i=0;i<70;i++){
  const item={id:900000000+i,type:'story',title:`[DEMO] ${themes[i%themes.length]}`,url:`https://example.com/fixture/${i}`,by:'demo_reader',time:Math.floor(Date.now()/1000)-i*900,score:3+i%27,descendants:i%31};
  await storeItem(fixture.env,item);candidates.push({item,analysis:null});
}
for(const key of Object.keys(PRESETS)){const result=rank(candidates,baseRule(key));await saveFeed(fixture.env,'jev:'+key,result.ids,[],'DEMO — fictional fixture data; no model was called');}
for(const list of ['newstories','topstories','askstories','showstories','jobstories'])await saveFeed(fixture.env,'hn:'+list,candidates.map(x=>x.item.id),[],'DEMO — not a live HN feed');
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url||'/','http://127.0.0.1:4173').pathname;
    if(['/style.css','/app.js','/favicon.svg'].includes(path)){res.setHeader('content-type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'image/svg+xml');res.end(readFileSync(new URL('../public'+path,import.meta.url)));return;}
    if(req.method!=='GET'){res.statusCode=405;res.end('Read-only demo. Use npm run dev for the actual application.');return;}
    const response=await app.request('http://127.0.0.1:4173'+req.url,{headers:req.headers as Record<string,string>},fixture.env,fixture.ctx);
    res.statusCode=response.status;for(const [k,v] of response.headers)res.setHeader(k,v);res.end(await response.text());
  }catch{res.statusCode=500;res.end('Preview failed');}
});
server.listen(4173,'127.0.0.1',()=>console.log('Fixture preview: http://127.0.0.1:4173 — all stories are fictional.'));
