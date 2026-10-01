// Twitch EventSub over webhooks: the only chat source. Twitch POSTs channel.chat.message to /api/eventsub,
// so no local process is needed and everything runs on Cloudflare (1 Worker request + 1 DO request per message).
import { record, seal, unseal, randomToken } from './auth.js';
export const EVENTSUB_PATH='/api/eventsub';
export const MAX_EVENTSUB_BYTES=64*1024;
export const RECONNECT_URL='/auth/login?connect=1';
const HELIX='https://api.twitch.tv/helix';
const enc=new TextEncoder();
const hex=buf=>Array.from(new Uint8Array(buf),x=>x.toString(16).padStart(2,'0')).join('');
const fail=(message,status,extra={})=>Object.assign(new Error(message),{status,...extra});
const text=(body,status)=>new Response(body,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
const hmacKey=(secret,usage)=>crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);
function concat(...parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;}

// Derived, not a new binding: hex(HMAC-SHA256(AUTH_SECRET, 'mini-chat:eventsub:v1')). Cached per isolate.
let cached=null;
export async function eventsubSecret(env){
  if(cached?.from!==env.AUTH_SECRET)cached={from:env.AUTH_SECRET,value:hmacKey(env.AUTH_SECRET,'sign').then(k=>crypto.subtle.sign('HMAC',k,enc.encode('mini-chat:eventsub:v1'))).then(hex)};
  return cached.value;
}
// 'sha256=' + hex(HMAC-SHA256(secret, messageId + timestamp + rawBody)). Exported for tests.
export async function signEventsub(secret,messageId,timestamp,raw){
  const body=typeof raw==='string'?enc.encode(raw):raw;
  return 'sha256='+hex(await crypto.subtle.sign('HMAC',await hmacKey(secret,'sign'),concat(enc.encode(messageId),enc.encode(timestamp),body)));
}
async function verify(env,messageId,timestamp,raw,signature){
  const m=/^sha256=([0-9a-f]{64})$/i.exec(signature);if(!m)return false;
  const mac=Uint8Array.from(m[1].match(/../g),x=>parseInt(x,16));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC',await hmacKey(await eventsubSecret(env),'verify'),mac,concat(enc.encode(messageId),enc.encode(timestamp),raw));
}
// Twitch sends RFC3339 with up to nanosecond fractions; Date.parse wants at most milliseconds.
export function parseTwitchTime(value){
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(value))return NaN;
  return Date.parse(value.replace(/\.(\d{1,3})\d*/,'.$1'));
}
async function readRaw(request,limit){
  if(Number(request.headers.get('Content-Length'))>limit)throw fail('Request too large',413);
  const reader=request.body?.getReader();if(!reader)return new Uint8Array(0);
  const chunks=[];let bytes=0;
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw fail('Request too large',413);}chunks.push(value);}
  return concat(...chunks);
}

const str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
function slimEvent(ev){
  if(!ev||typeof ev!=='object')return null;
  // caps sit above every valid length, so the room's own validation still decides
  return {broadcaster_user_login:str(ev.broadcaster_user_login,64),chatter_user_id:str(ev.chatter_user_id,100),chatter_user_login:str(ev.chatter_user_login,64),
    chatter_user_name:str(ev.chatter_user_name,100),color:str(ev.color,16),message_id:str(ev.message_id,100),message:{text:str(ev.message?.text,512)}};
}

// POST /api/eventsub. No session, no same-origin check: the HMAC signature is the authentication.
export async function handleEventsub(request,env,{channels,roomFetch,now=Date.now()}){
  if(request.method!=='POST')return text('Use POST',405);
  const h=name=>request.headers.get('Twitch-Eventsub-'+name)||'';
  const id=h('Message-Id'),timestamp=h('Message-Timestamp'),signature=h('Message-Signature'),type=h('Message-Type'),subType=h('Subscription-Type');
  if(!id||!timestamp||!signature||!type||!subType||id.length>100||timestamp.length>40)return text('Missing EventSub headers',400);
  const raw=await readRaw(request,MAX_EVENTSUB_BYTES);   // read once
  if(!await verify(env,id,timestamp,raw,signature))return text('Invalid signature',403);
  const at=parseTwitchTime(timestamp);
  if(!Number.isFinite(at)||now-at>600000||at-now>60000)return text('Stale message',403);
  let body;try{body=JSON.parse(new TextDecoder().decode(raw));}catch{return text('Invalid JSON',400);}
  if(!body||typeof body!=='object')return text('Invalid JSON',400);
  const subscription=body.subscription&&typeof body.subscription==='object'?body.subscription:{};
  const message={messageId:id,messageType:type,subscriptionType:subType,timestamp:at,subscription:{id:String(subscription.id||'').slice(0,100),status:String(subscription.status||'').slice(0,64)}};
  // Only the fields the room reads are forwarded (fragments, badges, reply and cheer are dropped), so an emote-heavy
  // message stays a few hundred bytes. A room 4xx for a validly signed message is acknowledged (204) so Twitch does not
  // retry it into notification_failures_exceeded; only real room failures (5xx) answer 503 for a retry.
  const send=async channel=>{
    const r=await roomFetch(channel,'/eventsub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...message,event:slimEvent(body.event)})});
    if(r.status>=500)throw new Error('Room rejected EventSub message ('+r.status+')');
  };
  if(type==='webhook_callback_verification'){
    if(typeof body.challenge!=='string'||!body.challenge||body.challenge.length>1000)return text('Missing challenge',400);
    if(subType==='channel.chat.message')for(const channel of channels)await send(channel);
    return text(body.challenge,200);
  }
  if(type==='revocation'){
    if(subType==='channel.chat.message')for(const channel of channels)await send(channel);   // rooms ignore ids they don't own
    return new Response(null,{status:204});
  }
  if(type==='notification'&&subType==='channel.chat.message'){
    const channel=String(body.event?.broadcaster_user_login||'').toLowerCase();
    if(channels.includes(channel))await send(channel);
  }
  return new Response(null,{status:204});   // other channels, subscription types and message types are ignored
}

// ---------- Helix subscription lifecycle (app access token) ----------
const loopback=host=>host==='127.0.0.1'||host==='localhost'||host==='[::1]';
// Test-only: chat can be marked connected without Twitch ONLY in a local `cf dev` started with MINI_LOCAL_TEST=1
// (cloudflare.config.ts refuses to build or deploy with it), with a loopback PUBLIC_ORIGIN and a loopback request.
export function localTestMode(env,url){
  if(env.MINI_LOCAL_TEST!=='1'||!env.PUBLIC_ORIGIN)return false;
  try{return loopback(new URL(env.PUBLIC_ORIGIN).hostname)&&loopback(url.hostname);}catch{return false;}
}
export async function appToken(env,fresh=false){
  if(!fresh){
    const sealed=await record(env,'app-token:twitch');
    if(sealed){try{const t=await unseal(env,sealed);if(t.expiresAt>Date.now()+60000)return t.access_token;}catch{}}
  }
  const r=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:env.TWITCH_CLIENT_ID,client_secret:env.TWITCH_CLIENT_SECRET,grant_type:'client_credentials'})});
  if(!r.ok)throw fail('Twitch app token request failed ('+r.status+')',502);
  const t=await r.json();if(!t.access_token)throw fail('Twitch app token request failed',502);
  const expiresAt=Date.now()+Math.min(Number(t.expires_in)||3600,99*86400)*1000;
  await record(env,'app-token:twitch',await seal(env,{access_token:t.access_token,expiresAt}),expiresAt);
  return t.access_token;
}
async function helix(env,method,path,body){
  const call=async token=>fetch(HELIX+path,{method,headers:{'Client-Id':env.TWITCH_CLIENT_ID,Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let r=await call(await appToken(env));
  if(r.status===401)r=await call(await appToken(env,true));
  return r;
}
export async function listChatSubscriptions(env){
  const all=[];let after='';
  for(let page=0;page<10;page++){
    const r=await helix(env,'GET','/eventsub/subscriptions?type=channel.chat.message'+(after?'&after='+encodeURIComponent(after):''));
    if(!r.ok)throw fail('Twitch subscription list failed ('+r.status+')',502);
    const d=await r.json();all.push(...(d.data||[]));after=d.pagination?.cursor||'';if(!after)break;
  }
  return all;
}
async function deleteSubscription(env,id){
  const r=await helix(env,'DELETE','/eventsub/subscriptions?id='+encodeURIComponent(id));
  if(!r.ok&&r.status!==404)throw fail('Twitch subscription delete failed ('+r.status+')',502);
}
const summary=s=>({subscriptionId:String(s.id),status:String(s.status||'pending'),createdAt:Date.parse(s.created_at)||Date.now()});
// Twitch allows one subscription per type + condition, whatever the callback. Both sites share one Twitch app, so only
// one site at a time can receive chat: a live subscription for the same condition on another callback is a conflict
// (409, connectedElsewhere) unless the caller asks to take it over, which deletes it there.
const callbackOrigin=s=>{try{return new URL(s.transport.callback).origin;}catch{return s.transport?.method||'another callback';}};
const conflict=where=>fail('Chat is connected to '+where+'. Only one site can receive chat at a time: disconnect it there, or take it over here.',409,{connectedElsewhere:where});
// Ensures exactly one enabled channel.chat.message v1 webhook for this callback; stale or duplicate ones are deleted.
export async function connectChat(env,{broadcasterId,origin,url,takeover=false}){
  if(localTestMode(env,url))return {subscriptionId:'local-'+randomToken().slice(0,16),status:'enabled',createdAt:Date.now()};
  if(!broadcasterId)throw fail('Sign in as nesszerra with '+RECONNECT_URL+' before connecting chat',409,{reconnect:RECONNECT_URL});
  if(!/^https:\/\//.test(origin))throw fail('PUBLIC_ORIGIN must be https for Twitch webhooks',400);
  const callback=origin+EVENTSUB_PATH;
  const all=await listChatSubscriptions(env);
  const ours=s=>s.transport?.method==='webhook'&&s.transport.callback===callback;
  const sameCondition=s=>s.condition?.broadcaster_user_id===broadcasterId&&s.condition?.user_id===broadcasterId;
  const elsewhere=all.filter(s=>!ours(s)&&sameCondition(s));
  const live=elsewhere.find(s=>s.status==='enabled'||s.status==='webhook_callback_verification_pending');
  if(live&&!takeover)throw conflict(callbackOrigin(live));
  for(const s of elsewhere)await deleteSubscription(env,s.id);   // dead ones always; live ones only on takeover
  const mine=all.filter(ours);
  const keep=mine.find(s=>s.status==='enabled'&&s.version==='1'&&sameCondition(s));
  for(const s of mine)if(s!==keep)await deleteSubscription(env,s.id);
  if(keep)return summary(keep);
  const r=await helix(env,'POST','/eventsub/subscriptions',{type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:broadcasterId,user_id:broadcasterId},transport:{method:'webhook',callback,secret:await eventsubSecret(env)}});
  if(r.status===401||r.status===403)throw fail('Twitch rejected the chat subscription: missing authorization. Reconnect Twitch at '+RECONNECT_URL+', then click Connect chat.',403,{reconnect:RECONNECT_URL});
  if(r.status===409)throw conflict('another site');   // created elsewhere between our list and our create
  if(!r.ok)throw fail('Twitch rejected the chat subscription ('+r.status+')',502);
  const created=(await r.json()).data?.[0];if(!created?.id)throw fail('Twitch returned no subscription',502);
  return summary(created);
}
export async function disconnectChat(env,{subscriptionId,url}){
  if(!subscriptionId||subscriptionId.startsWith('local-')||subscriptionId.startsWith('se-')||localTestMode(env,url))return;
  await deleteSubscription(env,subscriptionId);
}
// Hourly alarm check. Returns the subscription status, 'missing', or null when Twitch can't be reached (no change then).
export async function checkChatSubscription(env,subscriptionId){
  try{const s=(await listChatSubscriptions(env)).find(x=>x.id===subscriptionId);return s?String(s.status):'missing';}
  catch{return null;}
}
