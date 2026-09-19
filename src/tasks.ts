import type { Env, Job } from './types.ts';
import { sha256, randomToken } from './security.ts';
export class Deferred extends Error {
  seconds:number;
  constructor(reason:string,seconds=3600){super(reason);this.seconds=seconds;}
}
export async function enqueue(env:Env,kind:string,key:string,payload:unknown,notBefore=Date.now()):Promise<string>{
  const id=sha256(`${kind}:${key}`);
  await env.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,not_before,created_at) VALUES(?,?,?,?,?)').bind(id,kind,JSON.stringify(payload),notBefore,Date.now()).run();return id;
}
/** D1 is the outbox and recovery ledger. Queue delivery is at least once. */
export async function dispatch(env:Env){
  const now=Date.now();
  // Keep the free Queue tier from being consumed by duplicate sends while a
  // slow consumer is still working through the durable outbox.
  const retryAfter=now-3600000;
  const rows=await env.DB.prepare(`SELECT id FROM jobs WHERE (status='pending' AND not_before<=? AND (dispatched_at=0 OR dispatched_at<?)) OR (status='running' AND lease_until<? AND dispatched_at<?) ORDER BY created_at LIMIT 10`).bind(now,retryAfter,now,retryAfter).all<{id:string}>();
  for(const r of rows.results){await env.TASKS.send({id:r.id});await env.DB.prepare('UPDATE jobs SET dispatched_at=? WHERE id=?').bind(now,r.id).run();}
}
export async function claim(env:Env,id:string):Promise<Job|null>{
  const now=Date.now(),token=randomToken();
  return env.DB.prepare(`UPDATE jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND attempts<5 AND ((status='pending' AND not_before<=?) OR (status='running' AND lease_until<?)) RETURNING *`).bind(token,now+300000,id,now,now).first<Job>();
}
export async function finish(env:Env,job:Job){
  await env.DB.prepare("UPDATE jobs SET status='done',lease_until=0,error=NULL WHERE id=? AND lease_token=?").bind(job.id,job.lease_token).run();
}
export async function fail(env:Env,job:Job,error:unknown){
  const deferred=error instanceof Deferred;const delay=deferred?error.seconds:Math.min(3600,30*2**job.attempts);
  // Do not persist raw upstream responses, personal text or credentials in error logs.
  const message=error instanceof Error&&/^[a-z0-9_:-]{1,120}$/i.test(error.message)?error.message:'task_error';
  await env.DB.prepare('UPDATE jobs SET status=?,not_before=?,lease_until=0,dispatched_at=0,attempts=attempts-?,error=? WHERE id=? AND lease_token=?').bind(!deferred&&job.attempts>=5?'failed':'pending',Date.now()+delay*1000,+deferred,message,job.id,job.lease_token).run();
}
