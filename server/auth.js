import { DurableObject } from 'cloudflare:workers';
export class AuthStore extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');}
  async fetch(request){
    if(!this.env.INTERNAL_SECRET || request.headers.get('X-Mini-Internal')!==this.env.INTERNAL_SECRET)return Response.json({error:'Forbidden'},{status:403});
    const url=new URL(request.url), key=url.searchParams.get('key');
    if(!key || key.length>200)return Response.json({error:'Invalid key'},{status:400});
    const sql=this.ctx.storage.sql;
    if(url.pathname==='/consume' && request.method==='POST'){
      const value=this.ctx.storage.transactionSync(()=>{
        const rows=[...sql.exec('SELECT value,expires FROM entries WHERE key=?',key)];
        sql.exec('DELETE FROM entries WHERE key=?',key);
        return rows[0]&&rows[0].expires>Date.now()?JSON.parse(rows[0].value):null;
      });
      return Response.json(value);
    }
    if(request.method==='GET'){
      const rows=[...sql.exec('SELECT value,expires FROM entries WHERE key=?',key)];
      return Response.json(rows[0]&&rows[0].expires>Date.now()?JSON.parse(rows[0].value):null);
    }
    if(request.method==='POST'){
      const {value,expires}=await request.json();
      if(!Number.isFinite(expires)||expires>Date.now()+100*86400000)return Response.json({error:'Invalid expiry'},{status:400});
      if(JSON.stringify(value).length>20000)return Response.json({error:'Record too large'},{status:413});
      sql.exec('INSERT INTO entries(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires',key,JSON.stringify(value),expires);
      await this.ctx.storage.setAlarm(Date.now()+3600000);
      return Response.json({ok:true});
    }
    if(request.method==='DELETE'){sql.exec('DELETE FROM entries WHERE key=?',key);return Response.json({ok:true});}
    return new Response('Method not allowed',{status:405});
  }
  async alarm(){this.ctx.storage.sql.exec('DELETE FROM entries WHERE expires<=?',Date.now());const [{n}]=[...this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM entries')];if(n)await this.ctx.storage.setAlarm(Date.now()+3600000);}
}
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
export async function record(env,key,value,expires){
  const stub=env.AUTH.get(env.AUTH.idFromName('auth'));
  const res=await stub.fetch('https://auth/entry?key='+encodeURIComponent(key),{method:value===undefined?'GET':value===null?'DELETE':'POST',headers:{'X-Mini-Internal':env.INTERNAL_SECRET,'Content-Type':'application/json'},...(value!==undefined&&value!==null?{body:JSON.stringify({value,expires})}:{})});
  if(!res.ok)throw new Error('Auth storage unavailable');return res.json();
}
export async function consume(env,key){
  const stub=env.AUTH.get(env.AUTH.idFromName('auth'));
  const r=await stub.fetch('https://auth/consume?key='+encodeURIComponent(key),{method:'POST',headers:{'X-Mini-Internal':env.INTERNAL_SECRET}});
  if(!r.ok)throw new Error('Auth storage unavailable');return r.json();
}
export async function seal(env,value){
  const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.AUTH_SECRET)),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(value))));
  return {iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...cipher))};
}
export async function unseal(env,value){
  const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.AUTH_SECRET)),{name:'AES-GCM'},false,['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(atob(value.iv),x=>x.charCodeAt(0))},key,Uint8Array.from(atob(value.data),x=>x.charCodeAt(0)))));
}
export function configured(env){return !!(env.TWITCH_CLIENT_ID&&env.TWITCH_CLIENT_SECRET&&env.AUTH_SECRET&&env.INTERNAL_SECRET);}
export async function session(request,env){
  const raw=request.headers.get('Cookie')?.match(/(?:^|;\s*)mini_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return raw?record(env,'session:'+await digest(raw)):null;
}
export async function isOwner(env,user){
  if(!user)return false;
  if(env.OWNER_TWITCH_ID)return user.id===env.OWNER_TWITCH_ID;
  const owner=await record(env,'owner:nesszerra');return owner?.id===user.id;
}
export function cookie(name,value,age){return name+'='+value+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age='+age;}
export async function handleAuth(request,env){
  const url=new URL(request.url), path=url.pathname;
  if(path==='/auth/logout'){
    if(request.method!=='POST')return new Response('Use POST',{status:405});
    const raw=request.headers.get('Cookie')?.match(/mini_session=([a-f0-9]{64})/)?.[1];if(raw)await record(env,'session:'+await digest(raw),null);
    return new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':cookie('mini_session','',0)}});
  }
  if(!configured(env))return Response.json({error:'Twitch app is not configured yet. Add the app client ID and secret to the Worker.'},{status:503});
  const callback=(env.PUBLIC_ORIGIN||url.origin)+'/auth/callback';
  if(path==='/auth/login'){
    const channel=url.searchParams.get('channel')||'nesszerra';
    if(channel!=='nesszerra')return Response.json({error:'Production channel onboarding is not enabled'},{status:403});
    const nonce=randomToken(), connect=url.searchParams.get('connect')==='1';
    await record(env,'oauth:'+nonce,{channel,connect},Date.now()+600000);
    const target=new URL('https://id.twitch.tv/oauth2/authorize');
    Object.entries({client_id:env.TWITCH_CLIENT_ID,redirect_uri:callback,response_type:'code',scope:connect?'moderation:read':'',state:nonce,force_verify:'true'}).forEach(([k,v])=>target.searchParams.set(k,v));
    return new Response(null,{status:302,headers:{Location:target.href,'Set-Cookie':cookie('mini_oauth',nonce,600)}});
  }
  if(path!=='/auth/callback')return new Response('Not found',{status:404});
  const state=url.searchParams.get('state'),cookieState=request.headers.get('Cookie')?.match(/(?:^|;\s*)mini_oauth=([a-f0-9]{64})/)?.[1];
  if(!state||state!==cookieState)return Response.json({error:'OAuth state mismatch. Restart sign-in.'},{status:400});
  const pending=await consume(env,'oauth:'+state);
  if(!pending||!url.searchParams.get('code'))return Response.json({error:'Authorization expired or denied'},{status:400});
  const tokenRes=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:env.TWITCH_CLIENT_ID,client_secret:env.TWITCH_CLIENT_SECRET,code:url.searchParams.get('code'),grant_type:'authorization_code',redirect_uri:callback})});
  if(!tokenRes.ok)return Response.json({error:'Twitch token exchange failed'},{status:502});
  const tokens=await tokenRes.json(), headers={'Client-Id':env.TWITCH_CLIENT_ID,Authorization:'Bearer '+tokens.access_token};
  const [identityRes,validationRes]=await Promise.all([fetch('https://api.twitch.tv/helix/users',{headers}),fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+tokens.access_token}})]);
  if(!identityRes.ok||!validationRes.ok)return Response.json({error:'Twitch identity validation failed'},{status:502});
  const identity=(await identityRes.json()).data?.[0], validation=await validationRes.json();
  if(!identity||validation.client_id!==env.TWITCH_CLIENT_ID||validation.user_id!==identity.id)return Response.json({error:'Twitch identity mismatch'},{status:403});
  const user={id:identity.id,login:identity.login,displayName:identity.display_name};
  // Resolve the channel's current immutable ID from Twitch, never from a claimed form field.
  const ownerRes=await fetch('https://api.twitch.tv/helix/users?login=nesszerra',{headers});
  if(!ownerRes.ok)return Response.json({error:'Cannot resolve channel owner'},{status:502});
  const owner=(await ownerRes.json()).data?.[0];
  if(!owner)return Response.json({error:'Test channel not found'},{status:502});
  if(env.OWNER_TWITCH_ID&&env.OWNER_TWITCH_ID!==owner.id)return Response.json({error:'Owner configuration mismatch'},{status:403});
  await record(env,'owner:nesszerra',{id:owner.id},Date.now()+90*86400000);
  if(pending.connect){
    if(user.id!==owner.id)return Response.json({error:'Only nesszerra can connect broadcaster authorization'},{status:403});
    if(!validation.scopes?.includes('moderation:read'))return Response.json({error:'Moderator permission was not granted'},{status:403});
    await record(env,'broadcaster:nesszerra',await seal(env,{...tokens,userId:user.id,validatedAt:Date.now()}),Date.now()+90*86400000);
  }
  const key=randomToken();await record(env,'session:'+await digest(key),{user,createdAt:Date.now()},Date.now()+6*3600000);
  const response=new Response(null,{status:303,headers:{Location:'/?signed_in=1'}});
  response.headers.append('Set-Cookie',cookie('mini_session',key,21600));response.headers.append('Set-Cookie',cookie('mini_oauth','',0));return response;
}
export async function access(env,user,channel){
  const owner=await isOwner(env,user);
  if(owner)return {owner:true,moderator:false,canManage:true};
  if(!user)return {owner:false,moderator:false,canManage:false,reason:'Sign in with Twitch'};
  const encrypted=await record(env,'broadcaster:'+channel);
  if(!encrypted)return {owner:false,moderator:false,canManage:false,reason:'Broadcaster must connect moderator authorization'};
  let token=await unseal(env,encrypted);
  const authHeaders=()=>({'Client-Id':env.TWITCH_CLIENT_ID,Authorization:'Bearer '+token.access_token});
  const renew=async()=>{
    const r=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:env.TWITCH_CLIENT_ID,client_secret:env.TWITCH_CLIENT_SECRET})});
    if(!r.ok)throw new Error('Broadcaster must reconnect Twitch');
    token={...token,...await r.json(),validatedAt:0};
  };
  if(Date.now()-token.validatedAt>3600000){
    let r=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+token.access_token}});
    if(r.status===401){await renew();r=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+token.access_token}});}
    if(!r.ok)throw new Error('Twitch authorization unavailable');
    const v=await r.json();if(v.user_id!==token.userId||v.client_id!==env.TWITCH_CLIENT_ID||!v.scopes?.includes('moderation:read'))throw new Error('Broadcaster authorization is invalid');
    token.validatedAt=Date.now();await record(env,'broadcaster:'+channel,await seal(env,token),Date.now()+90*86400000);
  }
  let r=await fetch('https://api.twitch.tv/helix/moderation/moderators?broadcaster_id='+token.userId+'&user_id='+encodeURIComponent(user.id),{headers:authHeaders()});
  if(r.status===401){await renew();await record(env,'broadcaster:'+channel,await seal(env,token),Date.now()+90*86400000);r=await fetch('https://api.twitch.tv/helix/moderation/moderators?broadcaster_id='+token.userId+'&user_id='+encodeURIComponent(user.id),{headers:authHeaders()});}
  if(!r.ok)throw new Error('Current moderator role cannot be verified');
  const moderator=(await r.json()).data?.some(x=>x.user_id===user.id)||false;
  return {owner:false,moderator,canManage:moderator,reason:moderator?'':'Current Twitch moderator role required'};
}
