import { DurableObject } from 'cloudflare:workers';
import app from './web.ts';
import type { Env } from './types.ts';
import { syncTick, consume, cleanup } from './pipeline.ts';
import { dispatch } from './tasks.ts';
import { putCheckpoint } from './db.ts';
import { boundedInt } from './core.ts';

export class SyncCoordinator extends DurableObject<Env> {
  private running=false;
  async fetch(request:Request):Promise<Response>{
    if(this.env.SYNC_ENABLED!=='true'){await this.ctx.storage.deleteAlarm();return Response.json({enabled:false});}
    if(new URL(request.url).pathname==='/run'&&!this.running)await this.alarm();
    else if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1000);
    return Response.json({enabled:true,scheduled:await this.ctx.storage.getAlarm()});
  }
  async alarm():Promise<void>{
    if(this.env.SYNC_ENABLED!=='true'){await this.ctx.storage.deleteAlarm();return;}
    if(this.running)return;this.running=true;
    let delay=boundedInt(this.env.SYNC_INTERVAL_MS,60000,10000,300000);
    try{await syncTick(this.env);await this.ctx.storage.put('failures',0);}
    catch{
      const failures=(await this.ctx.storage.get<number>('failures')||0)+1;
      await this.ctx.storage.put('failures',failures);delay=Math.min(300000,delay*2**Math.min(5,failures));
      await putCheckpoint(this.env,'sync_error',`sync_failed:${new Date().toISOString()}`);
    }finally{this.running=false;await this.ctx.storage.setAlarm(Date.now()+delay);}
  }
}
export default {
  fetch:app.fetch,
  async scheduled(controller:ScheduledController,env:Env,ctx:ExecutionContext){
    ctx.waitUntil((async()=>{
      await env.SYNC.get(env.SYNC.idFromName('hn-global-v1')).fetch(new Request('https://internal/ensure'));
      await dispatch(env);if(controller.cron==='17 3 * * *')await cleanup(env);
    })());
  },
  async queue(batch:MessageBatch<{id:string}>,env:Env){await consume(env,batch);}
} satisfies ExportedHandler<Env,{id:string}>;
