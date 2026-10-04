import { DurableObject } from 'cloudflare:workers';
import { channelState, readInvite, claimInvite } from './channels.js';
import { authOrigin } from './hosts.js';
export class AuthStore extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');}
  async fetch(request){
    if(!this.env.INTERNAL_SECRET || request.headers.get('X-Mini-Internal')!==this.env.INTERNAL_SECRET)return Response.json({error:'Forbidden'},{status:403});
    const url=new URL(request.url), key=url.searchParams.get('key');
    if(!key || key.length>200)return Response.json({error:'Invalid key'},{status:400});
    const sql=this.ctx.storage.sql;
    if(url.pathname==='/consume' && request.method==='POST'){
      // One statement: the row is removed and returned atomically, so a code can only ever be read once.
      const row=sql.exec('DELETE FROM entries WHERE key=? RETURNING value,expires',key).toArray()[0];
      const value=row&&row.expires>Date.now()?JSON.parse(row.value):null;
      return Response.json(value);
    }
    if(url.pathname==='/list'&&request.method==='GET'){
      // Owner listings only: the channel registry and invites (server/channels.js). Never sessions or tokens.
      if(key!=='channel:'&&key!=='invite:')return Response.json({error:'Invalid prefix'},{status:400});
      const end=key.slice(0,-1)+';';   // ';' sorts right after ':'
      const rows=[...sql.exec('SELECT key,value FROM entries WHERE key>=? AND key<? AND expires>? ORDER BY key LIMIT 500',key,end,Date.now())];
      return Response.json(rows.map(r=>({key:r.key,value:JSON.parse(r.value)})));
    }
    if(request.method==='GET'){
      const rows=[...sql.exec('SELECT value,expires FROM entries WHERE key=?',key)];
      return Response.json(rows[0]&&rows[0].expires>Date.now()?JSON.parse(rows[0].value):null);
    }
    if(request.method==='POST'){
      const {value,expires}=await request.json();
      // Channel registry rows and the modsconnected markers live ~20 years; everything else at most 100 days.
      if(!Number.isFinite(expires)||expires>Date.now()+(/^(channel|modsconnected|bot):/.test(key)?21*365:100)*86400000)return Response.json({error:'Invalid expiry'},{status:400});
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
// Broadcaster token (Helix moderator checks): kept 90 days from its last use. `touched` sits beside the sealed fields, so
// a successful check or an admin page view can push the expiry out without opening the token.
const TOKEN_MS=90*86400000, TOUCH_MS=7*86400000, MARKER_MS=20*365*86400000;
export const keepBroadcaster=(env,channel,sealed)=>record(env,'broadcaster:'+channel,{...sealed,touched:Date.now()},Date.now()+TOKEN_MS);
export const touchBroadcaster=(env,channel,sealed)=>Date.now()-(sealed?.touched||0)>TOUCH_MS?keepBroadcaster(env,channel,sealed):null;
// modsconnected:<login> = {at}: written whenever mod access is connected and never expires, so the admin page can tell
// "never connected" from "connected, but the token lapsed" (modsLapsed).
export const markModsConnected=(env,channel)=>record(env,'modsconnected:'+channel,{at:Date.now()},Date.now()+MARKER_MS);
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
// connect=1 (nesszerra only): mod checks plus the chat-read scopes the EventSub channel.chat.message webhook needs.
// Channels the site serves. nesszerra (the site owner) can use EventSub; every other channel uses StreamElements.
export const CHANNELS=['nesszerra','miolafff'];
export const CONNECT_SCOPES=['moderation:read','user:read:chat','user:bot','channel:bot'];
// bot=1 (test site, CHAT_BOT): the BOT_LOGIN account lets the app read and send chat as it. Only its id is stored
// (bot:twitch); the app token does the rest. connect=bot: a broadcaster allows the bot in their chat (channel:bot).
export const BOT_SCOPES=['user:read:chat','user:write:chat','user:bot'];
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
  const callback=authOrigin(env,url)+'/auth/callback';
  if(path==='/auth/login'){
    const nonce=randomToken(), invite=url.searchParams.get('invite')||'';
    let pending, scope='';
    if(url.searchParams.get('bot')==='1'){
      if(env.CHAT_BOT!=='1'||!env.BOT_LOGIN)return Response.json({error:'This site has no PixFray chat bot'},{status:403});
      pending={bot:true,next:'/'};scope=BOT_SCOPES.join(' ');
    }else if(invite){
      // Signup from /start: moderation:read lets the channel's mods open the admin page (mods=0 skips it).
      const inv=await readInvite(env,invite);
      if(inv.status!=='valid')return startPage(invite,inv.status);
      const mods=url.searchParams.get('mods')!=='0';
      pending={channel:inv.login,invite,mods,next:'/admin/'};scope=mods?'moderation:read':'';
    }else{
      const channel=url.searchParams.get('channel')||'nesszerra';
      // A turned-off channel still signs in, so its broadcaster can turn it back on.
      if(!await channelState(env,channel))return Response.json({error:'PixFray is not enabled for this channel'},{status:403});
      const connect=url.searchParams.get('connect')==='1', connectBot=env.CHAT_BOT==='1'&&url.searchParams.get('connect')==='bot', connectMods=connectBot||url.searchParams.get('connect')==='mods';
      if(connect&&channel!=='nesszerra')return Response.json({error:'Chat for this channel comes through StreamElements; no Twitch connection needed'},{status:403});
      const asked=url.searchParams.get('next'),next=connectMods?'/admin/':['/admin/','/admin/dev/'].includes(asked)?asked:'/';
      pending={channel,connect,...(connectMods?{connectMods:true}:{}),...(connectBot?{connectBot:true}:{}),next};scope=connect?CONNECT_SCOPES.join(' '):connectBot?'moderation:read channel:bot':connectMods?'moderation:read':'';
    }
    await record(env,'oauth:'+nonce,pending,Date.now()+600000);
    const target=new URL('https://id.twitch.tv/oauth2/authorize');
    Object.entries({client_id:env.TWITCH_CLIENT_ID,redirect_uri:callback,response_type:'code',scope,state:nonce,force_verify:'true'}).forEach(([k,v])=>target.searchParams.set(k,v));
    return new Response(null,{status:302,headers:{Location:target.href,'Set-Cookie':cookie('mini_oauth',nonce,600)}});
  }
  if(path!=='/auth/callback')return new Response('Not found',{status:404});
  const state=url.searchParams.get('state'),cookieState=request.headers.get('Cookie')?.match(/(?:^|;\s*)mini_oauth=([a-f0-9]{64})/)?.[1];
  if(!state||state!==cookieState)return Response.json({error:'OAuth state mismatch. Restart sign-in.'},{status:400});
  const pending=await consume(env,'oauth:'+state);
  if(pending?.invite&&!url.searchParams.get('code'))return startPage(pending.invite,url.searchParams.get('error')==='access_denied'?'denied':'failed');
  if(pending?.connectMods&&!url.searchParams.get('code'))return adminPage(pending.channel,'mods=denied');
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
  // A failed lookup only blocks connecting chat; viewers still sign in and the last stored owner record stays.
  const ownerRes=await fetch('https://api.twitch.tv/helix/users?login=nesszerra',{headers}).catch(()=>null);
  const owner=ownerRes?.ok?(await ownerRes.json()).data?.[0]:null;
  if(owner){
    if(env.OWNER_TWITCH_ID&&env.OWNER_TWITCH_ID!==owner.id)return Response.json({error:'Owner configuration mismatch'},{status:403});
    await record(env,'owner:nesszerra',{id:owner.id},Date.now()+90*86400000);
  }else if(pending.connect)return Response.json({error:'Cannot resolve channel owner'},{status:502});
  if(pending.connect){
    if(user.id!==owner.id)return Response.json({error:'Only nesszerra can connect broadcaster authorization'},{status:403});
    const missing=CONNECT_SCOPES.filter(x=>!validation.scopes?.includes(x));
    if(missing.length)return Response.json({error:'Twitch permissions were not granted: '+missing.join(', ')+'. Restart at /auth/login?connect=1.'},{status:403});
    await keepBroadcaster(env,'nesszerra',await seal(env,{...tokens,userId:user.id,validatedAt:Date.now()}));await markModsConnected(env,'nesszerra');
  }
  if(pending.bot){
    if(String(user.login).toLowerCase()!==String(env.BOT_LOGIN).toLowerCase())return Response.json({error:'Sign in as the bot account '+env.BOT_LOGIN+', not '+user.login},{status:403});
    const missing=BOT_SCOPES.filter(x=>!validation.scopes?.includes(x));
    if(missing.length)return Response.json({error:'Twitch permissions were not granted: '+missing.join(', ')+'. Restart at /auth/login?bot=1.'},{status:403});
    await record(env,'bot:twitch',{id:user.id,login:user.login,at:Date.now()},Date.now()+20*365*86400000);
  }
  const modScope=validation.scopes?.includes('moderation:read');
  if(pending.invite){
    try{await claimInvite(env,pending.invite,user);}
    catch(e){if(!e.reason)throw e;return startPage(pending.invite,e.reason);}
    if(pending.mods&&modScope){await keepBroadcaster(env,pending.channel,await seal(env,{...tokens,userId:user.id,validatedAt:Date.now()}));await markModsConnected(env,pending.channel);}
  }
  if(pending.connectMods){
    if(String(user.login).toLowerCase()!==pending.channel)return adminPage(pending.channel,'mods=wrong_account');
    if(!modScope||pending.connectBot&&!validation.scopes?.includes('channel:bot'))return adminPage(pending.channel,'mods=denied');
    await keepBroadcaster(env,pending.channel,await seal(env,{...tokens,userId:user.id,validatedAt:Date.now()}));await markModsConnected(env,pending.channel);
  }
  const key=randomToken();await record(env,'session:'+await digest(key),{user,createdAt:Date.now()},Date.now()+6*3600000);
  const back=(['/admin/','/admin/dev/'].includes(pending.next)?pending.next:'/')+'?'+(pending.channel?'channel='+pending.channel+'&':'')+'signed_in=1'+(pending.connectBot?'&bot=allowed':pending.connectMods?'&mods=connected':'')+(pending.bot?'&bot=connected':'')+(pending.invite||pending.connectMods?'#chat':'');
  const response=new Response(null,{status:303,headers:{Location:back}});
  response.headers.append('Set-Cookie',cookie('mini_session',key,21600));response.headers.append('Set-Cookie',cookie('mini_oauth','',0));return response;
}
// Back to /start with the reason the invite didn't work (invalid, used, expired, wrong_account, full, denied, failed).
function startPage(invite,error){return new Response(null,{status:303,headers:{Location:'/start/?invite='+encodeURIComponent(invite)+'&error='+encodeURIComponent(error),'Set-Cookie':cookie('mini_oauth','',0)}});}
function adminPage(channel,query){return new Response(null,{status:303,headers:{Location:'/admin/?channel='+channel+'&'+query+'#chat','Set-Cookie':cookie('mini_oauth','',0)}});}
const verdict=moderator=>({owner:false,moderator,canManage:moderator,reason:moderator?'':'Current Twitch moderator role required'});
export async function access(env,user,channel){
  const owner=await isOwner(env,user);
  if(owner)return {owner:true,moderator:false,canManage:true};
  if(!user)return {owner:false,moderator:false,canManage:false,reason:'Sign in with Twitch'};
  // The broadcaster manages their own channel; the login comes from Twitch at sign-in, never from a form field.
  if(String(user.login||'').toLowerCase()===channel)return {owner:false,broadcaster:true,moderator:false,canManage:true};
  // The Helix verdict is cached for a minute so a raid of signed-in viewers can't exhaust the broadcaster's rate limit.
  const cacheKey='mod:'+channel+':'+user.id,cached=await record(env,cacheKey);
  if(cached!==null)return verdict(cached===true);
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
    token.validatedAt=Date.now();await keepBroadcaster(env,channel,await seal(env,token));
  }
  const checkMod=()=>fetch('https://api.twitch.tv/helix/moderation/moderators?broadcaster_id='+token.userId+'&user_id='+encodeURIComponent(user.id),{headers:authHeaders()});
  let r=await checkMod();
  if(r.status===401){await renew();await keepBroadcaster(env,channel,await seal(env,token));r=await checkMod();}
  if(!r.ok)throw new Error('Current moderator role cannot be verified');
  const moderator=(await r.json()).data?.some(x=>x.user_id===user.id)||false;
  await record(env,cacheKey,moderator,Date.now()+60000);
  return verdict(moderator);
}
