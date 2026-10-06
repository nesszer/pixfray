import { ChannelRoom } from './channel.js';
import site from '../site.config.js';
import { AuthStore,record,session,isOwner,configured,handleAuth,access,CHANNELS,touchBroadcaster,markModsConnected } from './auth.js';
import { handleDeveloper,logWorkerError } from './developer.js';
import { handleUploads } from './uploads.js';
import { handlePets } from './pets.js';
import { EVENTSUB_PATH,BOT_LOGIN_URL,handleEventsub,connectChat,disconnectChat,sendChatMessages,twitchUserId } from './eventsub.js';
import { handleStreamElements,seCommandLines,seHelpText,SE_SUBSCRIPTION_ID } from './streamelements.js';
import { channelState,isOn,offError,setPaused,publicChannels,listRecords } from './channels.js';
import { COSMETIC_KINDS,COSMETIC_FIELDS,MAX_BUILDS } from './cosmetics.js';
import { siteOrigin,channelPageRedirect,isPage } from './hosts.js';
export {ChannelRoom,AuthStore};
// A turned-off channel keeps its admin page (to turn it back on) and its public lists; the overlay feed, the viewer
// page's state and profile saves are refused.
const OPEN_WHEN_PAUSED=['access','admin','leaderboard','catalog','assets','pets'];
function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
// Shop kinds: pets, hats, build slots and the cosmetics of server/cosmetics.js (the room checks the ids and prices).
const SHOP_KINDS=['pet','hat','slot',...COSMETIC_KINDS];
// The price a buyer saw is optional; when sent it must match the current one (409 price_changed).
const shopPrice=(p)=>p===undefined||(Number.isInteger(p)&&p>=0&&p<=1000000);
// The cosmetics and build slot a profile save may carry, all optional: { ok, fields }.
function loadoutFields(data){
  const fields={};
  for(const kind of COSMETIC_KINDS){const f=COSMETIC_FIELDS[kind],v=data[f];if(v===undefined)continue;if(typeof v!=='string'||v.length>32)return {ok:false};fields[f]=v;}
  if(data.build!==undefined){if(!Number.isInteger(data.build)||data.build<0||data.build>=MAX_BUILDS)return {ok:false};fields.build=data.build;}
  return {ok:true,fields};
}
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
  // CHAT_BOT (test site): chat is read and answered by the PixFray bot account (bot:twitch, signed in at /auth/login?bot=1).
  if(env.CHAT_BOT==='1'){
    const bot=await record(env,'bot:twitch');
    if(!bot?.id)throw Object.assign(new Error('Sign in the PixFray bot account first at '+BOT_LOGIN_URL),{status:409,reconnect:BOT_LOGIN_URL});
    const broadcasterId=channel===site.defaultChannel&&env.OWNER_TWITCH_ID||await twitchUserId(env,channel);
    if(!broadcasterId)throw Object.assign(new Error('Twitch has no channel named '+channel),{status:404});
    const sub=await connectChat(env,{broadcasterId,userId:bot.id,channel,origin:env.PUBLIC_ORIGIN||url.origin,url,takeover});
    return room('/chat',{action:'connected',...sub});
  }
  const broadcasterId=env.OWNER_TWITCH_ID||(await record(env,'owner:'+channel))?.id||'';
  const sub=await connectChat(env,{broadcasterId,origin:env.PUBLIC_ORIGIN||url.origin,url,takeover});
  return room('/chat',{action:'connected',...sub});
}
// Pages pass through the Worker (run_worker_first), and public/_headers doesn't reach responses a Worker returns,
// so the page headers are set here: no framing by other sites (clickjacking), and the staging and test sites stay out of search.
async function page(request,env,url){
  const r=await env.ASSETS.fetch(request);
  if(!isPage(url.pathname))return r;
  const out=new Response(r.body,r);
  out.headers.set('Content-Security-Policy',"frame-ancestors 'none'");out.headers.set('X-Frame-Options','DENY');
  out.headers.set('X-Content-Type-Options','nosniff');out.headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  if(/^(staging|test)\./.test(url.hostname))out.headers.set('X-Robots-Tag','noindex, nofollow');
  return out;
}
// robots.txt and sitemap.xml follow the host: the production site lists its public pages, and the test site stays out of search.
const PUBLIC_PAGES=['/','/start/','/intro/'];
function seoFile(url,path){
  const text=(body,type)=>new Response(body,{headers:{'Content-Type':type+'; charset=utf-8','Cache-Control':'public, max-age=3600'}});
  const main=url.origin===site.origins.production;
  if(path==='/sitemap.xml'){
    if(!main)return new Response('Not found',{status:404});
    return text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+PUBLIC_PAGES.map(p=>'  <url><loc>'+url.origin+p+'</loc></url>\n').join('')+'</urlset>\n','application/xml');
  }
  if(url.origin===site.origins.test||/^(staging|test)\./.test(url.hostname))return text('User-agent: *\nDisallow: /\n','text/plain');
  return text('User-agent: *\nDisallow: /api/\nDisallow: /auth/\n'+(main?'\nSitemap: '+url.origin+'/sitemap.xml\n':''),'text/plain');
}
// Admin-only view of the StreamElements setup: the key and the paste-ready command replies.
function seView(env,url,channel,se){
  if(!se?.secret)return null;
  const origin=siteOrigin(env,url,channel);
  return {key:se.secret,names:se.names,origin,lastCommandAt:se.lastCommandAt||0,rejectedAt:se.rejectedAt||0,seen:se.seen||{},duelModuleOff:!!se.duelModuleOff,commands:seCommandLines(origin,channel,se.secret,se.names),timerText:seHelpText({names:se.names,origin,channel})};
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
async function devUser(env){const id=env.OWNER_TWITCH_ID||(await record(env,'owner:'+site.owner.login))?.id||'';return id?{id,login:site.owner.login,displayName:site.owner.login+' (dev token)'}:null;}
// Dev-token routes: save a profile for any account (test bots, an alt), or feed one chat line through the room as if
// Twitch had delivered it. The room repeats the DEV_TOOLS_TOKEN check.
async function handleDevtools(request,env,channel,action,data){
  // {live:true} starts a pretend stream for !checkin (a new stream id each time), {live:false} ends it, {live:null} asks Twitch again.
  if(action==='live')return roomFetch(null,env,channel,'/dev-live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({live:data.live??null,streamId:String(data.streamId||'').slice(0,40)})});
  const userId=String(data.userId||''),username=String(data.username||'').toLowerCase(),displayName=String(data.displayName||username).slice(0,48);
  if(!/^[a-zA-Z0-9_:-]{1,64}$/.test(userId)||!/^[a-z0-9_]{1,25}$/.test(username))return json({error:'userId and username required'},400);
  if(action==='profile'){
    const {avatar='player',color='#4FA3FF',defaultAbility='strike',pet}=data,loadout=loadoutFields(data);
    if(!validProfile({avatar,color,defaultAbility})||pet!==undefined&&(typeof pet!=='string'||pet.length>64)||!loadout.ok)return json({error:'Invalid profile fields'},400);
    return internal(request,env,channel,'/profile',{userId,username,displayName,avatar,color,defaultAbility,pet,...loadout.fields});
  }
  // A bot buys a pet, a hat, a cosmetic or a build slot, the same room call as POST /api/shop.
  if(action==='shop'){
    const {kind,id='',price}=data;
    if(!SHOP_KINDS.includes(kind)||typeof id!=='string'||id.length>64||!shopPrice(price))return json({error:'Invalid item'},400);
    return internal(request,env,channel,'/shop',{userId,kind,id,price});
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
      return await handleEventsub(request,env,{channels:CHANNELS,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init),origin:channel=>siteOrigin(env,url,channel),
        findChannel:async id=>id&&(await listRecords(env,'channel:')).find(x=>x.value?.id===id)?.value?.login||'',
        isEnabled:async channel=>isOn(await channelState(env,channel)),
        botUserId:async()=>env.CHAT_BOT==='1'?String((await record(env,'bot:twitch'))?.id||''):'',
        // The bot's reply goes out after Twitch has its 204; what Twitch said goes back to the room (bot status and owner log).
        sendChat:args=>ctx?.waitUntil?.(sendChatMessages(env,args).then(results=>roomFetch(null,env,args.channel,'/bot-sent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({results})})).catch(e=>console.warn('bot reply report failed',e?.message)))});
    }
    // StreamElements custom commands ($(customapi ...)): GET with the channel's key, answered with one chat line.
    if(path.startsWith('/api/se/')){
      if(!env.INTERNAL_SECRET)return new Response('PixFray is not configured',{status:503});
      return await handleStreamElements(request,env,{url,origin:siteOrigin(env,url,path.split('/')[3]||''),channelState:channel=>channelState(env,channel),roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init),
        // StreamElements took over from a Twitch EventSub subscription: delete it so Twitch stops sending chat.
        dropSubscription:subscriptionId=>ctx?.waitUntil?.(disconnectChat(env,{subscriptionId,url}).catch(e=>console.warn('eventsub drop failed',e?.message)))});
    }
    // A dev token is not a browser credential, so it skips the same-origin check; a wrong one is refused outright.
    const dev=request.headers.has('Authorization')?await devToken(request,env):false;
    if(request.headers.has('Authorization')&&!dev&&path.startsWith('/api/'))return json({error:'Invalid dev token'},401);
    if(mutating&&!dev&&request.headers.get('Origin')!==url.origin)return json({error:'Same-origin request required'},403);
    if(path.startsWith('/auth/'))return handleAuth(request,env);
    if(path==='/robots.txt'||path==='/sitemap.xml')return seoFile(url,path);
    if(!path.startsWith('/api/'))return channelPageRedirect(env,url)||await page(request,env,url);
    if(!env.INTERNAL_SECRET||!env.AUTH_SECRET)return json({error:'Server secrets are not configured'},503);
    const s=dev?null:await session(request,env),user=dev?await devUser(env):s?.user||null,owner=await isOwner(env,user);
    const devMatch=path.match(/^\/api\/devtools\/([a-z0-9_]{1,25})\/(profile|chat|live|shop|export)$/);
    if(path.startsWith('/api/devtools/')){
      if(!dev||!devMatch)return json({error:'Not found'},404);
      const st=await channelState(env,devMatch[1]);if(!isOn(st))return json(offError(st),403);
      // A copy of the channel for a site of its own (branch miolaf-frozen imports it): room tables and mod access.
      if(devMatch[2]==='export'){
        if(request.method!=='GET')return json({error:'Use GET'},405);
        const r=await roomFetch(null,env,devMatch[1],'/export');if(!r.ok)return json(await r.json(),r.status);
        const [broadcaster,modsconnected]=await Promise.all([record(env,'broadcaster:'+devMatch[1]),record(env,'modsconnected:'+devMatch[1])]);
        return json({channel:devMatch[1],at:Date.now(),tables:await r.json(),auth:{broadcaster,modsconnected}});
      }
      if(request.method!=='POST')return json({error:'Use POST'},405);
      return await handleDevtools(request,env,devMatch[1],devMatch[2],await bodyJson(request,4000));
    }
    if(path==='/api/session')return json({user,owner,configured:configured(env),channels:CHANNELS,productionEnabled:false});
    // The bare site asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
    if(path==='/api/channels')return json({channels:await publicChannels(env),defaultChannel:site.defaultChannel});
    if(path==='/api/health')return json({ok:true,version:'0.2.0',twitchConfigured:configured(env),productionEnabled:false});
    if(path.startsWith('/api/dev/'))return await handleDeveloper(request,env,{user,owner,dev,url,path,bodyJson,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init),chatAction:(channel,action,opts)=>chatAction(env,url,channel,action,opts),waitUntil:p=>ctx?.waitUntil?.(p)});
    const match=path.match(/^\/api\/(state|live|profile|leaderboard|looks|catalog|access|admin|assets|pets|shop)\/([a-z0-9_]{1,25})(?:\/([a-z0-9_-]{1,64}))?$/);
    if(!match)return json({error:'Not found'},404);
    const [,route,channel,id]=match;
    const state=await channelState(env,channel);
    // The shop list and the viewer's own profile stay readable while paused (like pets), so viewers still see their
    // fighter and what they own; saving and buying stay closed.
    const openWhenPaused=OPEN_WHEN_PAUSED.includes(route)||((route==='shop'||route==='profile')&&request.method==='GET');
    if(!isOn(state)&&!(state==='paused'&&openWhenPaused))return json(offError(state),403);
    if(route==='live'&&request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket upgrade required'},426);
    if(route==='access')return json(await access(env,user,channel));
    if(route==='assets')return await handleUploads(request,env,{user,owner,channel,id:id||'',url,bodyJson,access:()=>access(env,user,channel),roomFetch:(p,init)=>roomFetch(null,env,channel,p,init)});
    // Pets (server/pets.js): the public catalog and images; mods upload and delete their own.
    if(route==='pets')return await handlePets(request,env,{user,id:id||'',bodyJson,access:()=>access(env,user,channel),roomFetch:(p,init)=>roomFetch(null,env,channel,p,init)});
    // Shop: the public list with this channel's prices (GET), and a signed-in viewer buying with PixFray dollars (POST).
    if(route==='shop'){
      if(request.method==='GET'&&!id)return internal(request,env,channel,'/shop');
      if(request.method!=='POST'||id)return json({error:'Use GET or POST'},405);
      if(!user)return json({error:'Sign in to shop'},401);
      const {kind,id:item='',price}=await bodyJson(request,1000);
      if(!SHOP_KINDS.includes(kind)||typeof item!=='string'||item.length>64||!shopPrice(price))return json({error:'Invalid item'},400);
      return internal(request,env,channel,'/shop',{userId:user.id,kind,id:item,price});
    }
    if(route==='profile'){
      if(!user)return json({error:'Sign in to customize your profile'},401);
      if(request.method==='GET')return internal(request,env,channel,'/profile?userId='+encodeURIComponent(user.id));
      if(request.method!=='POST')return json({error:'Use GET or POST'},405);
      const body=await bodyJson(request,4000),{avatar,color,defaultAbility,stats,hat,pet}=body,loadout=loadoutFields(body);
      if(!validProfile({avatar,color,defaultAbility})||!loadout.ok)return json({error:'Invalid profile fields'},400);
      // stats/hat are optional; the room checks them against the saved wins (server/upgrades.js).
      if(stats!==undefined&&(!stats||typeof stats!=='object'||Array.isArray(stats))||hat!==undefined&&typeof hat!=='string'||pet!==undefined&&(typeof pet!=='string'||pet.length>64))return json({error:'Invalid profile fields'},400);
      const dynamicRes=await internal(request,env,channel,'/catalog');const dynamic=dynamicRes.ok?await dynamicRes.json():[];
      if(![...await staticCatalog(env,url),...dynamic].some(x=>x.id===avatar))return json({error:'Unknown character'},400);
      return internal(request,env,channel,'/profile',{userId:user.id,username:user.login,displayName:user.displayName,avatar,color,defaultAbility,stats,hat,pet,...loadout.fields});
    }
    if(route==='admin'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Use GET or POST'},405);
      const roles=await access(env,user,channel);if(!roles.canManage)return json({error:roles.reason||'Moderator role required'},user?403:401);
      if(request.method==='GET'){
        const r=await internal(request,env,channel,'/admin');if(!r.ok)return r;
        const data=await r.json();
        // modsReady: the broadcaster's token is stored, so moderators can be checked and open this page too.
        // modsLapsed: mod access was connected once (modsconnected:<login>, never expires) but the token has expired since.
        // Viewing this page keeps a stored token alive, and a token seen without its marker (connected before the marker
        // existed) gets one.
        const [broadcaster,marker]=await Promise.all([record(env,'broadcaster:'+channel),record(env,'modsconnected:'+channel)]);
        const modsReady=!!broadcaster,modsLapsed=!modsReady&&!!marker;
        if(broadcaster)await Promise.all([touchBroadcaster(env,channel,broadcaster),marker?null:markModsConnected(env,channel)]).catch(e=>console.warn('mods record refresh failed',e?.message));   // rare writes: weekly, and once per channel
        const bot=env.CHAT_BOT==='1'?await record(env,'bot:twitch'):null;
        return json({...data,streamelements:seView(env,url,channel,data.streamelements),access:roles,checkinTestAllowed:channel===site.defaultChannel,seOnly:env.SE_ONLY==='1',chatBot:env.CHAT_BOT==='1'?{login:bot?.login||'',debug:env.BOT_DEBUG==='1'}:null,modsReady,modsLapsed,channelState:state});
      }
      const data=await bodyJson(request,12000);
      // Turn PixFray off or back on: the broadcaster or the owner, never a mod. Fighters and ranks are kept.
      if(data.action==='pauseChannel'||data.action==='resumeChannel'){
        if(!roles.owner&&!roles.broadcaster)return json({error:'Only '+channel+' can turn PixFray off or on'},403);
        await setPaused(env,channel,data.action==='pauseChannel',roles.owner?'owner':'broadcaster');
        return json({ok:true,channelState:data.action==='pauseChannel'?'paused':'on'});
      }
      // Can't be undone, or moves chat away from another site: the broadcaster or the owner, never a mod.
      const only=data.action==='resetAllRanks'?'reset all ranks':data.action==='rotateSeKey'?'make a new StreamElements key':data.takeover===true?'move chat from another site':'';
      if(only&&!roles.owner&&!roles.broadcaster)return json({error:'Only '+channel+' can '+only,reason:'broadcaster_only'},403);
      if(data.action==='rotateSeKey'||data.action==='setSeNames'||data.action==='setDuelModuleOff'){
        const r=await roomFetch(null,env,channel,'/se-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:data.action,names:data.names,value:data.value===true})});
        const out=await r.json();if(!r.ok)return json(out,r.status);
        return json({ok:true,streamelements:seView(env,url,channel,out.streamelements)});
      }
      // Check-in test mode: !checkin answers while offline for 15 minutes, saving nothing. Any mod can turn it on or off,
      // on the site's own channel only, so a test never reaches another streamer's chat.
      if(data.action==='checkinTest'){
        if(channel!==site.defaultChannel)return json({error:'Check-in test mode is only for '+site.defaultChannel+"'s channel"},403);
        const r=await roomFetch(null,env,channel,'/checkin-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:data.value===true,by:user.displayName||user.login})});
        return json(await r.json(),r.status);
      }
      if(data.action==='connectChat'&&env.CHAT_BOT!=='1'&&(channel!==site.defaultChannel||env.SE_ONLY==='1'))return json({error:'This channel uses StreamElements for chat. Choose Use StreamElements.'},400);
      if(data.action==='connectChat'||data.action==='disconnectChat'||data.action==='useStreamElements')return await chatAction(env,url,channel,data.action,{takeover:data.takeover===true});
      return internal(request,env,channel,'/admin',{...data,actorId:user.id,actorName:user.displayName||user.login});
    }
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    if(route==='catalog'){
      const [s,d]=await Promise.all([staticCatalog(env,url),internal(request,env,channel,'/catalog')]);
      return json([...s,...(d.ok?await d.json():[])]);
    }
    // Saved looks for the overlay: public, the same fields the leaderboard shows.
    if(route==='live')return internal(request,env,channel,url.searchParams.get('role')==='overlay'?'/live?role=overlay':'/live');
    if(route==='looks')return internal(request,env,channel,'/looks?u='+encodeURIComponent((url.searchParams.get('u')||'').slice(0,600)));
    // The leaderboard is public; ?private=1 (the mod page) adds dollars for mods and the owner only.
    if(route==='leaderboard'&&url.searchParams.get('private')==='1'){
      if(!(await access(env,user,channel)).canManage)return json({error:'Moderator role required'},user?403:401);
      return internal(request,env,channel,'/leaderboard?private=1');
    }
    return internal(request,env,channel,'/'+route);
  }catch(error){
    if(!error.status)ctx?.waitUntil?.(logWorkerError(env,error,{path}));
    return json({error:error.status?error.message:'Service unavailable; check owner diagnostics',...(error.reconnect?{reconnect:error.reconnect}:{}),...(error.connectedElsewhere?{connectedElsewhere:error.connectedElsewhere}:{})},error.status||503);
  }
}};
