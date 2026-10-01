import { ChannelRoom } from './channel.js';
import { AuthStore,randomToken,digest,record,consume,session,isOwner,configured,handleAuth,access } from './auth.js';
import { handleDeveloper } from './developer.js';
export {ChannelRoom,AuthStore};
const enabledChannel=channel=>channel==='nesszerra';
function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function internal(request,env,channel,path,body){
  const h=new Headers();h.set('X-Mini-Internal',env.INTERNAL_SECRET);h.set('X-Mini-Channel',channel);
  if(body?.userId)h.set('X-Mini-User-Id',body.userId);
  else if(body?.actorId)h.set('X-Mini-User-Id',body.actorId);
  if(request.headers.get('Upgrade'))h.set('Upgrade','websocket');
  if(body!==undefined)h.set('Content-Type','application/json');
  return env.ROOMS.get(env.ROOMS.idFromName(channel)).fetch('https://room'+path,{method:body===undefined?'GET':'POST',headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function bodyJson(request,limit=2200000){
  if(Number(request.headers.get('Content-Length'))>limit)throw Object.assign(new Error('Request too large'),{status:413});
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let bytes=0;for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw Object.assign(new Error('Request too large'),{status:413});}chunks.push(value);}
  const raw=new Uint8Array(bytes);let p=0;for(const v of chunks){raw.set(v,p);p+=v.length;}try{return JSON.parse(new TextDecoder().decode(raw));}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
}
export default {async fetch(request,env){
  try{
    const url=new URL(request.url), path=url.pathname, mutating=!['GET','HEAD','OPTIONS'].includes(request.method);
    if(mutating&&path!=='/api/relay/pair'&&request.headers.get('Origin')!==url.origin)return json({error:'Same-origin request required'},403);
    if(path.startsWith('/auth/'))return handleAuth(request,env);
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(!env.INTERNAL_SECRET||!env.AUTH_SECRET)return json({error:'Server secrets are not configured'},503);
    const s=await session(request,env),user=s?.user||null,owner=await isOwner(env,user);
    if(path==='/api/session')return json({user,owner,configured:configured(env),channels:['nesszerra'],productionEnabled:false});
    if(path==='/api/health')return json({ok:true,version:'0.2.0',twitchConfigured:configured(env),productionEnabled:false});
    if(path.startsWith('/api/dev/'))return handleDeveloper(request,env,{user,owner});
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
    if(route==='access')return json(await access(env,user,channel));
    if(route==='profile'){
      if(!user)return json({error:'Sign in to customize your profile'},401);
      if(request.method==='GET')return internal(request,env,channel,'/profile?userId='+encodeURIComponent(user.id));
      if(request.method!=='POST')return json({error:'Use GET or POST'},405);
      const data=await bodyJson(request,4000);
      const {avatar,color,defaultAbility}=data;
      if(!/^[a-z0-9_-]{1,64}$/.test(avatar||'')||!/^#[a-f0-9]{6}$/i.test(color||'')||!['strike','heavy','heal'].includes(defaultAbility))return json({error:'Invalid profile fields'},400);
      const staticRes=await env.ASSETS.fetch(new Request(url.origin+'/assets/characters.json'));
      const staticCatalog=staticRes.ok?await staticRes.json():[];
      const dynamicRes=await internal(request,env,channel,'/catalog');const dynamic=dynamicRes.ok?await dynamicRes.json():[];
      if(![...staticCatalog,...dynamic].some(x=>x.id===avatar))return json({error:'Unknown character'},400);
      return internal(request,env,channel,'/profile',{userId:user.id,username:user.login,displayName:user.displayName,avatar,color,defaultAbility});
    }
    if(route==='admin'||route==='assets'&&request.method==='POST'){
      if(request.method!=='POST')return json({error:'Use POST'},405);
      const roles=await access(env,user,channel);if(!roles.canManage)return json({error:roles.reason||'Moderator role required'},403);
      const data=await bodyJson(request,route==='assets'?2200000:12000);
      return internal(request,env,channel,route==='assets'?'/asset':'/admin',{...data,actorId:user.id});
    }
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    if(route==='catalog'){
      const [s,d]=await Promise.all([env.ASSETS.fetch(new Request(url.origin+'/assets/characters.json')),internal(request,env,channel,'/catalog')]);
      return json([...(s.ok?await s.json():[]),...(d.ok?await d.json():[])]);
    }
    if(route==='assets'){
      if(!id)return json({error:'Asset ID required'},400);
      return internal(request,env,channel,'/asset/'+id);
    }
    return internal(request,env,channel,'/'+route);
  }catch(error){return json({error:error.status?error.message:'Service unavailable; check owner diagnostics'},error.status||503);}
}};
