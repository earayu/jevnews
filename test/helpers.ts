import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/types.ts';

export function makeEnv(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  function statement(sql:string,values:unknown[]=[]):any{
    return {bind:(...v:unknown[])=>statement(sql,v),
      first:async(column?:string)=>{const r=sqlite.prepare(sql).get(...values as any[]) as Record<string,unknown>|undefined;return r?(column?r[column]:r):null;},
      all:async()=>({results:sqlite.prepare(sql).all(...values as any[]),success:true,meta:{}}),
      run:async()=>{const r=sqlite.prepare(sql).run(...values as any[]);return {success:true,meta:{changes:Number(r.changes)}};}
    };
  }
  const db={prepare:statement,batch:async(statements:any[])=>{
    sqlite.exec('BEGIN');
    try{const results=[];for(const s of statements)results.push(await s.all());sqlite.exec('COMMIT');return results;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }};
  const objects=new Map<string,string>();const messages:{id:string}[]=[];
  const env={DB:db,CONTENT:{put:async(k:string,v:string)=>{objects.set(k,v);},get:async(k:string)=>objects.has(k)?{text:async()=>objects.get(k)!,json:async()=>JSON.parse(objects.get(k)!)}:null,delete:async(k:string)=>{objects.delete(k);}},TASKS:{send:async(p:{id:string})=>{messages.push(p);}},
    APP_ENV:'development',SYNC_ENABLED:'false',SYNC_INTERVAL_MS:'60000',ANALYSIS_ENABLED:'false',REGISTRATION_OPEN:'true',JEV_MODEL:'jev-1.13.0',RULE_MODEL:'@cf/meta/llama-3.1-8b-instruct',DAILY_TOKEN_BUDGET:'20000000',DAILY_COMPILE_BUDGET:'100',MAX_SCAN_IDS:'10',MAX_CANDIDATES:'10000',TURNSTILE_SITE_KEY:'',TURNSTILE_HOSTNAME:'',ADMIN_TOKEN:'unit-test-not-a-real-secret-0123456789'
  } as unknown as Env;
  const pending:Promise<unknown>[]=[];
  const ctx={waitUntil:(p:Promise<unknown>)=>{pending.push(p);},passThroughOnException:()=>{},props:{}} as ExecutionContext;
  return {env,sqlite,objects,messages,ctx,pending};
}
