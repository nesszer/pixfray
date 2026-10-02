import { ChannelRoom } from './channel.js';
import { AuthStore,record,session,isOwner,configured,handleAuth,access,CHANNELS } from './auth.js';
import { handleDeveloper,logWorkerError } from './developer.js';
import { handleUploads } from './uploads.js';
import { EVENTSUB_PATH,handleEventsub,connectChat,disconnectChat } from './eventsub.js';
import { handleStreamElements,seCommandLines,SE_SUBSCRIPTION_ID } from './streamelements.js';
export {ChannelRoom,AuthStore};
const enabledChannel=channel=>CHANNELS.includes(channel);
function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
const validProfile=({avatar,color,defaultAbility})=>typeof avatar==='string'&&/^[a-z0-9_-]{1,64}$/.test(avatar)&&typeof color==='string'&&/^#[a-f0-9]{6}$/i.test(color)&&['strike','heavy','heal'].includes(defaultAbility);
// Raw call into a ChannelRoom. Adds the internal secret and channel binding; the caller owns method/body.
function roomFetch(request,env,channel,path,init={}){
  const h=new Headers(init.headers||{});h.set('X-Mini-Internal',env.INTERNAL_SECRET);h.set('X-Mini-Channel',channel);
  if(request?.headers.get('Upgrade')){h.set('Upgrade','websocket');const ip=request.headers.get('CF-Connecting-IP');if(ip)h.set('X-Mini-Client-Ip',ip);}
  return env.ROOMS.get(env.ROOMS.idFromName(channel)).fetch('https://room'+path,{...init,headers:h});
}
function internal(request,env,channel,path,body){
  const h={};
  if(body?.userId)h['X-Mini-User-Id']=body.userId;
  else if(body?.actorId)h['X-Mini-User-Id']=body.actorId;
  if(body!==undefined)h['Content-Type']='application/json';
  return roomFetch(request,env,channel,path,{method:body===undefined?'GET':'POST',headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function bodyJson(request,limit=2200000){
  if(Number(request.headers.get('Content-Length'))>limit)throw Object.assign(new Error('Request too large'),{status:413});
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw Object.assign(new Error('Request too large'),{status:413});}chunks.push(value);}
  const raw=new Uint8Array(bytes);let p=0;for(const v of chunks){raw.set(v,p);p+=v.length;}
  let value;try{value=bytes?JSON.parse(new TextDecoder().decode(raw)):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('JSON object required'),{status:400});
  return value;
}
// Chat source lifecycle (owner or mod via /api/admin, owner via /api/dev). The room only records the outcome.
async function chatAction(env,url,channel,action,{takeover=false}={}){
  const room=(path,body)=>roomFetch(null,env,channel,path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const current=await (await room('/chat')).json();
  if(action==='connectChat'&&env.SE_ONLY==='1')throw Object.assign(new Error('This site uses StreamElements for chat. Choose Use StreamElements.'),{status:400});
  if(action==='useStreamElements'){
    if(current.subscriptionId&&current.subscriptionId!==SE_SUBSCRIPTION_ID)await disconnectChat(env,{subscriptionId:current.subscriptionId,url});
    return room('/chat',{action:'connected',subscriptionId:SE_SUBSCRIPTION_ID,status:'enabled',createdAt:Date.now()});
  }
  if(action==='disconnectChat'){
    await disconnectChat(env,{subscriptionId:current.subscriptionId,url});
    return room('/chat',{action:'disconnected',reason:'disconnected'});
  }
  const broadcasterId=env.OWNER_TWITCH_ID||(await record(env,'owner:'+channel))?.id||'';
  const sub=await connectChat(env,{broadcasterId,origin:env.PUBLIC_ORIGIN||url.origin,url,takeover});
  return room('/chat',{action:'connected',...sub});
}
// Admin-only view of the StreamElements setup: the key and the paste-ready command replies.
function seView(env,url,channel,se){
  if(!se?.secret)return null;
  const origin=env.PUBLIC_ORIGIN||url.origin;
  return {key:se.secret,names:se.names,origin,lastCommandAt:se.lastCommandAt||0,rejectedAt:se.rejectedAt||0,commands:seCommandLines(origin,channel,se.secret,se.names)};
}
// Test site only: DEV_TOOLS_TOKEN is declared only by `cf deploy --mode test`, so production has no token to match.
// A matching "Authorization: Bearer" acts as the owner, for scripts/devtools.mjs (docs/DEVTOOLS.md).
async function devToken(request,env){
  const m=/^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.get('Authorization')||'');
  if(!env.DEV_TOOLS_TOKEN||env.DEV_TOOLS_TOKEN.length<32||!m)return false;
  const hash=async v=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
  const [a,b]=await Promise.all([hash(m[1]),hash(env.DEV_TOOLS_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0;
}
async function devUser(env){const id=env.OWNER_TWITCH_ID||(await record(env,'owner:nesszerra'))?.id||'';return id?{id,login:'nesszerra',displayName:'nesszerra (dev token)'}:null;}
// Dev-token routes: save a profile for any account (test bots, an alt), or feed one chat line through the room as if
// Twitch had delivered it. The room repeats the DEV_TOOLS_TOKEN check.
async function handleDevtools(request,env,channel,action,data){
  const userId=String(data.userId||''),username=String(data.username||'').toLowerCase(),displayName=String(data.displayName||username).slice(0,48);
  if(!/^[a-zA-Z0-9_:-]{1,64}$/.test(userId)||!/^[a-z0-9_]{1,25}$/.test(username))return json({error:'userId and username required'},400);
  if(action==='profile'){
    const {avatar='player',color='#4FA3FF',defaultAbility='strike'}=data;
    if(!validProfile({avatar,color,defaultAbility}))return json({error:'Invalid profile fields'},400);
    return internal(request,env,channel,'/profile',{userId,username,displayName,avatar,color,defaultAbility});
  }
  if(action==='chat'){
    const text=String(data.text||'').slice(0,500);if(!text.trim())return json({error:'text required'},400);
    return roomFetch(null,env,channel,'/dev-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,username,displayName,text})});
  }
  return json({error:'Not found'},404);
}
async function staticCatalog(env,url){const r=await env.ASSETS.fetch(new Request(url.origin+'/assets/characters.json'));return r.ok?await r.json():[];}
export default {async fetch(request,env,ctx){
  let path='';
  try{
    const url=new URL(request.url), mutating=!['GET','HEAD','OPTIONS'].includes(request.method);path=url.pathname;
    // Twitch EventSub posts here: no session and no Origin header; the HMAC signature authenticates it.
    if(path===EVENTSUB_PATH){
      if(!env.INTERNAL_SECRET||!env.AUTH_SECRET)return json({error:'Server secrets are not configured'},503);
      return await handleEventsub(request,env,{channels:CHANNELS,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init)});
    }
    // StreamElements custom commands ($(customapi ...)): GET with the channel's key, answered with one chat line.
    if(path.startsWith('/api/se/')){
      if(!env.INTERNAL_SECRET)return new Response('Mini Chat is not configured',{status:503});
      return await handleStreamElements(request,env,{url,origin:env.PUBLIC_ORIGIN||url.origin,channels:CHANNELS,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init)});
    }
    // A dev token is not a browser credential, so it skips the same-origin check; a wrong one is refused outright.
    const dev=request.headers.has('Authorization')?await devToken(request,env):false;
    if(request.headers.has('Authorization')&&!dev&&path.startsWith('/api/'))return json({error:'Invalid dev token'},401);
    if(mutating&&!dev&&request.headers.get('Origin')!==url.origin)return json({error:'Same-origin request required'},403);
    if(path.startsWith('/auth/'))return handleAuth(request,env);
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(!env.INTERNAL_SECRET||!env.AUTH_SECRET)return json({error:'Server secrets are not configured'},503);
    const s=dev?null:await session(request,env),user=dev?await devUser(env):s?.user||null,owner=await isOwner(env,user);
    const devMatch=path.match(/^\/api\/devtools\/([a-z0-9_]{1,25})\/(profile|chat)$/);
    if(path.startsWith('/api/devtools/')){
      if(!dev||!devMatch)return json({error:'Not found'},404);
      if(!enabledChannel(devMatch[1]))return json({error:'Mini Chat is not enabled for this channel'},403);
      if(request.method!=='POST')return json({error:'Use POST'},405);
      return await handleDevtools(request,env,devMatch[1],devMatch[2],await bodyJson(request,4000));
    }
    if(path==='/api/session')return json({user,owner,configured:configured(env),channels:CHANNELS,productionEnabled:false});
    if(path==='/api/health')return json({ok:true,version:'0.2.0',twitchConfigured:configured(env),productionEnabled:false});
    if(path.startsWith('/api/dev/'))return await handleDeveloper(request,env,{user,owner,dev,url,path,bodyJson,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init),chatAction:(channel,action,opts)=>chatAction(env,url,channel,action,opts),waitUntil:p=>ctx?.waitUntil?.(p)});
    const match=path.match(/^\/api\/(state|live|profile|leaderboard|catalog|access|admin|assets)\/([a-z0-9_]{1,25})(?:\/([a-z0-9_-]{1,64}))?$/);
    if(!match)return json({error:'Not found'},404);
    const [,route,channel,id]=match;
    if(!enabledChannel(channel))return json({error:'Mini Chat is not enabled for this channel'},403);
    if(route==='live'&&request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket upgrade required'},426);
    if(route==='access')return json(await access(env,user,channel));
    if(route==='assets')return await handleUploads(request,env,{user,owner,channel,id:id||'',url,bodyJson,access:()=>access(env,user,channel),roomFetch:(p,init)=>roomFetch(null,env,channel,p,init)});
    if(route==='profile'){
      if(!user)return json({error:'Sign in to customize your profile'},401);
      if(request.method==='GET')return internal(request,env,channel,'/profile?userId='+encodeURIComponent(user.id));
      if(request.method!=='POST')return json({error:'Use GET or POST'},405);
      const {avatar,color,defaultAbility}=await bodyJson(request,4000);
      if(!validProfile({avatar,color,defaultAbility}))return json({error:'Invalid profile fields'},400);
      const dynamicRes=await internal(request,env,channel,'/catalog');const dynamic=dynamicRes.ok?await dynamicRes.json():[];
      if(![...await staticCatalog(env,url),...dynamic].some(x=>x.id===avatar))return json({error:'Unknown character'},400);
      return internal(request,env,channel,'/profile',{userId:user.id,username:user.login,displayName:user.displayName,avatar,color,defaultAbility});
    }
    if(route==='admin'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Use GET or POST'},405);
      const roles=await access(env,user,channel);if(!roles.canManage)return json({error:roles.reason||'Moderator role required'},user?403:401);
      if(request.method==='GET'){
        const r=await internal(request,env,channel,'/admin');if(!r.ok)return r;
        const data=await r.json();
        return json({...data,streamelements:seView(env,url,channel,data.streamelements),access:roles,seOnly:env.SE_ONLY==='1'});
      }
      const data=await bodyJson(request,12000);
      if(data.action==='rotateSeKey'||data.action==='setSeNames'){
        const r=await roomFetch(null,env,channel,'/se-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:data.action,names:data.names})});
        const out=await r.json();if(!r.ok)return json(out,r.status);
        return json({ok:true,streamelements:seView(env,url,channel,out.streamelements)});
      }
      if(data.action==='connectChat'&&(channel!=='nesszerra'||env.SE_ONLY==='1'))return json({error:'This channel uses StreamElements for chat. Choose Use StreamElements.'},400);
      if(data.action==='connectChat'||data.action==='disconnectChat'||data.action==='useStreamElements')return await chatAction(env,url,channel,data.action,{takeover:data.takeover===true});
      return internal(request,env,channel,'/admin',{...data,actorId:user.id,actorName:user.displayName||user.login});
    }
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    if(route==='catalog'){
      const [s,d]=await Promise.all([staticCatalog(env,url),internal(request,env,channel,'/catalog')]);
      return json([...s,...(d.ok?await d.json():[])]);
    }
    return internal(request,env,channel,'/'+route);
  }catch(error){
    if(!error.status)ctx?.waitUntil?.(logWorkerError(env,error,{path}));
    return json({error:error.status?error.message:'Service unavailable; check owner diagnostics',...(error.reconnect?{reconnect:error.reconnect}:{}),...(error.connectedElsewhere?{connectedElsewhere:error.connectedElsewhere}:{})},error.status||503);
  }
}};
