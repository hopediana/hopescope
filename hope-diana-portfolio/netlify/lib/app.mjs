import {randomBytes,createHash,createHmac,scryptSync,timingSafeEqual} from 'node:crypto';
import {ServiceError} from './supabase.mjs';
const now=()=>Date.now()/1000;
export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export const nameKey=value=>String(value).normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu,' ');
export const codeKey=value=>String(value).toUpperCase().replace(/[\s-]/gu,'');
export function passwordHash(value,salt=randomBytes(16)){return salt.toString('hex')+'$'+scryptSync(value,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex');}
export function matches(value,stored){try{const[salt,wanted]=stored.split('$');const actual=scryptSync(value,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024});const expected=Buffer.from(wanted,'hex');return expected.length===actual.length&&timingSafeEqual(expected,actual);}catch{return false;}}
const equal=(a,b)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function newCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';const bytes=randomBytes(12);const code=[...bytes].map(n=>alphabet[n%alphabet.length]).join('');return 'HS-'+code.match(/.{4}/g).join('-');}
const safeName=value=>String(value).replaceAll('\\','/').split('/').pop().replace(/[^A-Za-z0-9._ -]/g,'_').replace(/^[ .]+|[ .]+$/g,'').slice(0,120)||'photograph';
export function createHandler(repo,env={}){
 const configured=!!(repo&&env.ADMIN_PASSWORD?.length>=12&&env.SESSION_SECRET?.length>=32&&env.PUBLIC_URL?.startsWith('https://'));
 const version=hash((env.SESSION_SECRET||'')+'\0'+(env.ADMIN_PASSWORD||''));
 const ownerHash=configured?passwordHash(env.ADMIN_PASSWORD):'';
 const dummy=passwordHash(randomBytes(20).toString('hex'));
 const limit=Math.max(0,Number(env.STORAGE_LIMIT_GB??100))*1024**3;
 const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...extra}});
 function field(body,key,max,required=false,trim=true){if(typeof(body[key]??'')!=='string')throw new ServiceError('Check '+key.replaceAll('_',' ')+'.',400);const value=trim?(body[key]||'').trim():(body[key]||'');if(value.length>max||(required&&!value))throw new ServiceError('Check '+key.replaceAll('_',' ')+'.',400);return value;}
 async function body(req){if(Number(req.headers.get('content-length')||0)>65536)throw new ServiceError('Request is too large.',413);const raw=await req.text();if(raw.length>65536)throw new ServiceError('Request is too large.',413);let data;try{data=JSON.parse(raw);}catch{throw new ServiceError('Please send a JSON object.',400);}if(!data||typeof data!=='object'||Array.isArray(data))throw new ServiceError('Please send a JSON object.',400);return data;}
 function cookie(req,key){return req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='))?.slice(key.length+1)||'';}
 async function session(req,kind='owner'){const row=await repo.findSession(hash(cookie(req,kind==='owner'?'hope_owner':'hope_client')));return row&&row.kind===kind&&row.expires>now()&&(kind!=='owner'||row.credential_version===version)?row:null;}
 async function owner(req,mutation=false){const row=await session(req);if(!row)throw new ServiceError('Please sign in to your admin workspace.',401);if(mutation&&!equal(req.headers.get('x-csrf-token')||'',row.csrf))throw new ServiceError('Refresh the page and try again.',403);return row;}
 async function gallery(id){const g=await repo.getGallery(id);if(!g)throw new ServiceError('Gallery not found.',404);return g;}
 async function client(req){const s=await session(req,'client');if(!s)throw new ServiceError('Please sign in with your legal name and gallery code.',401);const g=await gallery(s.gallery_id);if(!g.enabled||g.expires<=now())throw new ServiceError('This gallery is not available. Please contact Hope.',401);return g;}
 async function issue(req,kind,gallery_id=null){const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');const seconds=kind==='owner'?28800:86400;await repo.insertSession({token_hash:hash(token),kind,gallery_id,csrf,expires:now()+seconds,credential_version:kind==='owner'?version:''});const secure=new URL(req.url).protocol==='https:'?'; Secure':'';return `${kind==='owner'?'hope_owner':'hope_client'}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure}`;}
 async function attempt(context,kind){const key=createHmac('sha256',env.SESSION_SECRET).update(kind+'|'+(context.ip||'local')).digest('hex');if(!await repo.rateLimit(key))throw new ServiceError('Too many attempts. Please try again in 15 minutes.',429);}
 const photoJson=(p,prefix)=>({id:p.id,filename:p.filename,bytes:Number(p.bytes),preview:`${prefix}/${p.id}/preview`,download:`${prefix}/${p.id}/download`});
 async function galleryJson(g,req,full=false){const photos=await repo.photos(g.id);const base=(env.PUBLIC_URL||new URL(req.url).origin).replace(/\/$/,'');const result={id:g.id,title:g.title,client_name:g.client_name,client_email:g.client_email,note:g.note,expires:g.expires,enabled:g.enabled,created:g.created,share_url:base+'/#moments',password_protected:true,code_issued:!!g.code_hash,expired:g.expires<=now(),photo_count:photos.length,bytes:photos.reduce((n,p)=>n+Number(p.bytes),0),cover:photos.length?`/api/admin/photos/${photos[0].id}/preview`:null};if(full)result.photos=photos.map(p=>photoJson(p,'/api/admin/photos'));return result;}
 async function removePhoto(p){await repo.removeObjects([p.original_key,p.preview_key]);await repo.removePhoto(p.id);}
 async function checkedPhoto(id,galleryId=null){const p=await repo.getPhoto(id);if(!p||p.status!=='ready'||(galleryId&&p.gallery_id!==galleryId))throw new ServiceError('Photograph not found.',404);return p;}
 return async(req,context={})=>{
  try{
   const url=new URL(req.url),path=url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/,'/api');const method=req.method;
   if(configured&&url.origin!==new URL(env.PUBLIC_URL).origin)return json({detail:'Use the published portfolio address to access Your Moments.'},404);
   if(!['GET','HEAD','OPTIONS'].includes(method)){const origin=req.headers.get('origin');if(origin&&origin!==(env.PUBLIC_URL||url.origin).replace(/\/$/,''))return json({detail:'This request came from another website.'},403);}
   if(path==='/api/session'&&method==='GET'){
    if(!configured)return json({owner:false,client:false,configured:false,csrf:null,client_csrf:null,cloud_uploads:true,download_mode:'browser-zip',setup_kind:'netlify',storage_limit:limit});
    const o=await session(req),c=await session(req,'client');return json({owner:!!o,client:!!c,configured:true,csrf:o?.csrf||null,client_csrf:c?.csrf||null,cloud_uploads:true,download_mode:'browser-zip',setup_kind:'netlify',storage_limit:limit,portfolio_url:'/#home'});
   }
   if(!configured)throw new ServiceError('Your Moments is not connected yet. Complete NETLIFY-SETUP.md before accepting client uploads.',503);
   if(path==='/api/login'&&method==='POST'){await attempt(context,'owner');const data=await body(req);if(!matches(field(data,'password',1024,false,false),ownerHash))throw new ServiceError('That admin password did not match.',401);return json({ok:true},200,{'Set-Cookie':await issue(req,'owner')});}
   if(path==='/api/logout'&&method==='POST'){const row=await owner(req,true);await repo.deleteSession(row.token_hash);return json({ok:true},200,{'Set-Cookie':'hope_owner=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure'});}
   if(path==='/api/client/login'&&method==='POST'){
    await attempt(context,'client');const data=await body(req);const legal=nameKey(field(data,'legal_name',100)),code=codeKey(field(data,'code',100));const rows=await repo.galleriesByName(legal);let found=null;
    for(const g of rows){if(matches(code,g.code_hash||dummy)&&g.code_hash&&g.enabled&&g.expires>now()){found=g;break;}}
    if(!rows.length)matches(code,dummy);
    if(!found)throw new ServiceError('The name and code did not match an available gallery. Check both or contact Hope.',401);
    return json({ok:true},200,{'Set-Cookie':await issue(req,'client',found.id)});
   }
   if(path==='/api/client/logout'&&method==='POST'){const row=await session(req,'client');if(!row||!equal(req.headers.get('x-csrf-token')||'',row.csrf))throw new ServiceError('Refresh the page and try again.',403);await repo.deleteSession(row.token_hash);return json({ok:true},200,{'Set-Cookie':'hope_client=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure'});}
   if(path==='/api/client/gallery'&&method==='GET'){const g=await client(req);return json({title:g.title,client_name:g.client_name,note:g.note,expires:g.expires,photos:(await repo.photos(g.id)).map(p=>photoJson(p,'/api/client/photos'))});}
   if(path==='/api/client/zip'&&['GET','POST'].includes(method)){
    const g=await client(req);let photos=await repo.photos(g.id);let wanted=url.searchParams.get('ids')?.split(',')||null;
    if(method==='POST'){const row=await session(req,'client');if(!equal(req.headers.get('x-csrf-token')||'',row.csrf))throw new ServiceError('Refresh the page and try again.',403);const data=await body(req);if(!Array.isArray(data.ids)||!data.ids.length||data.ids.length>500||data.ids.some(id=>typeof id!=='string'||id.length>64))throw new ServiceError('Choose between 1 and 500 photographs.',400);wanted=data.ids;}
    if(wanted){const ids=new Set(wanted);if([...ids].some(id=>!photos.some(p=>p.id===id)))throw new ServiceError('A selected photograph is unavailable.',404);photos=photos.filter(p=>ids.has(p.id));}
    if(!photos.length)throw new ServiceError('There are no photographs to download yet.',400);
    return json({title:g.title,files:photos.map(p=>({id:p.id,filename:p.filename,bytes:Number(p.bytes),url_endpoint:`/api/client/photos/${p.id}/download-url`}))});
   }
   let match=path.match(/^\/api\/(admin|client)\/photos\/([a-f0-9]+)\/(preview|download|download-url)$/);
   if(match&&method==='GET'){
    let galleryId=null;if(match[1]==='admin')await owner(req);else galleryId=(await client(req)).id;
    const p=await checkedPhoto(match[2],galleryId),download=match[3]!=='preview';const signed=await repo.signDownload(download?p.original_key:p.preview_key,{download,filename:p.filename});
    return match[3]==='download-url'?json({url:signed}):new Response(null,{status:302,headers:{Location:signed,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
   }
   if(path==='/api/galleries'&&method==='GET'){await owner(req);const rows=await repo.listGalleries();return json({galleries:await Promise.all(rows.map(g=>galleryJson(g,req)))});}
   if(path==='/api/galleries'&&method==='POST'){
    await owner(req,true);const data=await body(req),title=field(data,'title',120,true),name=field(data,'client_name',100,true),email=field(data,'client_email',254),note=field(data,'note',2000);const days=Number(data.days??30);
    if(!Number.isInteger(days)||days<1||days>365)throw new ServiceError('Expiry must be 1–365 days.',400);
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new ServiceError('Check the email address.',400);
    const code=newCode(),g={id:randomBytes(12).toString('hex'),title,client_name:name,legal_key:nameKey(name),client_email:email,note,code_hash:passwordHash(codeKey(code)),expires:now()+days*86400,enabled:true,created:now()};
    await repo.insertGallery(g);return json({...await galleryJson(g,req,true),access_code:code});
   }
   match=path.match(/^\/api\/galleries\/([a-f0-9]+)$/);
   if(match){const id=match[1];await owner(req,method!=='GET');const g=await gallery(id);
    if(method==='GET')return json(await galleryJson(g,req,true));
    if(method==='DELETE'){const keys=(await repo.allPhotos(id)).flatMap(p=>[p.original_key,p.preview_key]);for(let i=0;i<keys.length;i+=200)await repo.removeObjects(keys.slice(i,i+200));await repo.revokeClients(id);await repo.deleteGallery(id);return json({ok:true});}
    if(method==='PATCH'){const data=await body(req);let patch,code;
     if(data.action==='toggle')patch={enabled:!g.enabled};else if(data.action==='extend')patch={expires:now()+30*86400};else if(data.action==='rotate'){code=newCode();patch={code_hash:passwordHash(codeKey(code))};await repo.revokeClients(id);}else throw new ServiceError('Unknown gallery action.',400);
     const changed=await repo.updateGallery(id,patch);return json({...await galleryJson(changed,req,true),...(code?{access_code:code}:{})});
    }
   }
   match=path.match(/^\/api\/galleries\/([a-f0-9]+)\/uploads$/);
   if(match&&method==='POST'){
    await owner(req,true);await gallery(match[1]);const data=await body(req),mime=field(data,'mime',50),bytes=Number(data.bytes);if(!['image/jpeg','image/png','image/webp'].includes(mime)||!Number.isInteger(bytes)||bytes<1||bytes>50*1024**2)throw new ServiceError('Use a JPEG, PNG, or WebP up to 50 MB.',400);
    const extension={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'}[mime];const filename=safeName(field(data,'filename',250,true)).replace(/\.[^.]*$/,'')+extension;
    await repo.cleanup();
    const p=await repo.reservePhoto({p_id:randomBytes(16).toString('hex'),p_gallery:match[1],p_filename:filename,p_mime:mime,p_bytes:bytes,p_limit:limit});
    try{return json({id:p.id,original_upload_url:await repo.signUpload(p.original_key),preview_upload_url:await repo.signUpload(p.preview_key)});}catch(error){await removePhoto(p);throw error;}
   }
   match=path.match(/^\/api\/uploads\/([a-f0-9]+)\/complete$/);
   if(match&&method==='POST'){await owner(req,true);const p=await repo.getPhoto(match[1]);if(!p||p.status!=='pending')throw new ServiceError('This upload is no longer available.',400);await repo.verifyHeaders(p);return json({photo:photoJson(await repo.finishPhoto(p.id),'/api/admin/photos')});}
   match=path.match(/^\/api\/admin\/photos\/([a-f0-9]+)$/);
   if(match&&method==='DELETE'){await owner(req,true);const p=await repo.getPhoto(match[1]);if(!p)throw new ServiceError('Photograph not found.',404);await removePhoto(p);return json({ok:true});}
   throw new ServiceError('This gallery action is unavailable.',404);
  }catch(error){return json({detail:error instanceof ServiceError?error.message:'The gallery service is temporarily unavailable. Please try again.'},error instanceof ServiceError?error.status:500);}
 };
}
