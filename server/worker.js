import { ChannelRoom } from './channel.js';
import { AuthStore,randomToken,digest,record,consume,session,isOwner,configured,handleAuth,access } from './auth.js';
import { handleDeveloper,logWorkerError } from './developer.js';
import { handleUploads } from './uploads.js';
export {ChannelRoom,AuthStore};
const enabledChannel=channel=>channel==='nesszerra';
function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
// Raw call into a ChannelRoom. Adds the internal secret and channel binding; the caller owns method/body.
function roomFetch(request,env,channel,path,init={}){
  const h=new Headers(init.headers||{});h.set('X-Mini-Internal',env.INTERNAL_SECRET);h.set('X-Mini-Channel',channel);
  if(request?.headers.get('Upgrade'))h.set('Upgrade','websocket');
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
async function staticCatalog(env,url){const r=await env.ASSETS.fetch(new Request(url.origin+'/assets/characters.json'));return r.ok?await r.json():[];}
export default {async fetch(request,env,ctx){
  let path='';
  try{
    const url=new URL(request.url), mutating=!['GET','HEAD','OPTIONS'].includes(request.method);path=url.pathname;
    if(mutating&&path!=='/api/relay/pair'&&request.headers.get('Origin')!==url.origin)return json({error:'Same-origin request required'},403);
    if(path.startsWith('/auth/'))return handleAuth(request,env);
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(!env.INTERNAL_SECRET||!env.AUTH_SECRET)return json({error:'Server secrets are not configured'},503);
    const s=await session(request,env),user=s?.user||null,owner=await isOwner(env,user);
    if(path==='/api/session')return json({user,owner,configured:configured(env),channels:['nesszerra'],productionEnabled:false});
    if(path==='/api/health')return json({ok:true,version:'0.2.0',twitchConfigured:configured(env),productionEnabled:false});
    if(path.startsWith('/api/dev/'))return await handleDeveloper(request,env,{user,owner,url,path,bodyJson,roomFetch:(channel,p,init)=>roomFetch(null,env,channel,p,init),waitUntil:p=>ctx?.waitUntil?.(p)});
    if(path==='/api/relay/code'){
      if(!owner)return json({error:'Owner only'},403);
      if(request.method!=='POST')return json({error:'Use POST'},405);
      const code=randomToken();await record(env,'pair:'+await digest(code),{channel:'nesszerra'},Date.now()+300000);
      return json({code,channel:'nesszerra',expiresIn:300});
    }
    if(path==='/api/relay/pair'){
      if(request.method!=='POST')return json({error:'Use POST'},405);
      const {code}=await bodyJson(request,2000);
      if(typeof code!=='string'||!/^[a-f0-9]{64}$/.test(code))return json({error:'Invalid pairing code'},400);
      const hash=await digest(code),pair=await consume(env,'pair:'+hash);
      if(!pair)return json({error:'Pairing code expired'},403);
      const credential=randomToken(),credentialHash=await digest(credential),generation=randomToken();
      await record(env,'relay:'+credentialHash,{channel:pair.channel,generation},Date.now()+90*86400000);
      await record(env,'relay-generation:'+pair.channel,{generation},Date.now()+90*86400000);
      return json({credential,channel:pair.channel,expiresIn:90*86400});
    }
    if(path==='/api/relay/revoke'){
      if(!owner)return json({error:'Owner only'},403);
      if(request.method!=='POST')return json({error:'Use POST'},405);
      await record(env,'relay-generation:nesszerra',{generation:randomToken()},Date.now()+90*86400000);
      return internal(request,env,'nesszerra','/admin',{actorId:user.id,action:'disconnectRelay'});
    }
    const match=path.match(/^\/api\/(state|live|profile|leaderboard|catalog|access|admin|assets|relay)\/([a-z0-9_]{1,25})(?:\/([a-z0-9_-]{1,64}))?$/);
    if(!match)return json({error:'Not found'},404);
    const [,route,channel,id]=match;
    if(!enabledChannel(channel))return json({error:'miolafff onboarding awaits its owner authorization'},403);
    if(route==='relay'){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket upgrade required'},426);
      const credential=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if(!credential)return json({error:'Relay credential required'},401);
      const r=await record(env,'relay:'+await digest(credential)),g=await record(env,'relay-generation:'+channel);
      if(!r||r.channel!==channel||r.generation!==g?.generation)return json({error:'Relay credential invalid or revoked'},403);
      return internal(request,env,channel,'/relay');
    }
    if(route==='live'&&request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket upgrade required'},426);
    if(route==='access')return json(await access(env,user,channel));
    if(route==='assets')return await handleUploads(request,env,{user,owner,channel,id:id||'',url,bodyJson,access:()=>access(env,user,channel),roomFetch:(p,init)=>roomFetch(null,env,channel,p,init)});
    if(route==='profile'){
      if(!user)return json({error:'Sign in to customize your profile'},401);
      if(request.method==='GET')return internal(request,env,channel,'/profile?userId='+encodeURIComponent(user.id));
      if(request.method!=='POST')return json({error:'Use GET or POST'},405);
      const {avatar,color,defaultAbility}=await bodyJson(request,4000);
      if(typeof avatar!=='string'||!/^[a-z0-9_-]{1,64}$/.test(avatar)||typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)||!['strike','heavy','heal'].includes(defaultAbility))return json({error:'Invalid profile fields'},400);
      const dynamicRes=await internal(request,env,channel,'/catalog');const dynamic=dynamicRes.ok?await dynamicRes.json():[];
      if(![...await staticCatalog(env,url),...dynamic].some(x=>x.id===avatar))return json({error:'Unknown character'},400);
      return internal(request,env,channel,'/profile',{userId:user.id,username:user.login,displayName:user.displayName,avatar,color,defaultAbility});
    }
    if(route==='admin'){
      if(request.method!=='GET'&&request.method!=='POST')return json({error:'Use GET or POST'},405);
      const roles=await access(env,user,channel);if(!roles.canManage)return json({error:roles.reason||'Moderator role required'},user?403:401);
      if(request.method==='GET'){
        const r=await internal(request,env,channel,'/admin');if(!r.ok)return r;
        return json({...await r.json(),access:roles});
      }
      const data=await bodyJson(request,12000);
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
    return json({error:error.status?error.message:'Service unavailable; check owner diagnostics'},error.status||503);
  }
}};
