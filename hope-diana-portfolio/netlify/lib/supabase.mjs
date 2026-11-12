const BUCKET='hopescope-private';
export class ServiceError extends Error {constructor(message,status=500){super(message);this.status=status;}}
export class SupabaseRepository {
 constructor(url,key,fetcher=fetch){this.url=url.replace(/\/$/,'');this.key=key;this.auth={apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${key}`})};this.fetcher=fetcher;}
 async request(path,{method='GET',body,headers={}}={}){
  const response=await this.fetcher(this.url+path,{method,headers:{...this.auth,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{data=null;}
  if(!response.ok){const message=data?.message||data?.error||'The gallery storage service could not complete this request.';
   if(message.includes('GALLERY_FULL'))throw new ServiceError('This gallery has reached 500 photographs. Create another gallery for the remaining files.',400);
   if(message.includes('STORAGE_LIMIT'))throw new ServiceError('Your configured original-photo allowance is full.',413);
   if(message.includes('UPLOAD_')||message.includes('PREVIEW_'))throw new ServiceError('The uploaded files could not be verified. Please retry.',400);
   throw new ServiceError('The gallery storage service could not complete this request.',502);
  }return data;
 }
 table(name,query=''){return `/rest/v1/hs_${name}${query?'?'+query:''}`;}
 async findSession(hash){return (await this.request(this.table('sessions',new URLSearchParams({token_hash:'eq.'+hash,expires:'gt.'+Date.now()/1000,limit:'1'}))))?.[0]||null;}
 async insertSession(row){await this.request(this.table('sessions'),{method:'POST',body:row});}
 async deleteSession(hash){await this.request(this.table('sessions',new URLSearchParams({token_hash:'eq.'+hash})),{method:'DELETE'});}
 async revokeClients(id){await this.request(this.table('sessions',new URLSearchParams({gallery_id:'eq.'+id,kind:'eq.client'})),{method:'DELETE'});}
 async listGalleries(){return await this.request(this.table('galleries','order=created.desc'));}
 async getGallery(id){return (await this.request(this.table('galleries',new URLSearchParams({id:'eq.'+id,limit:'1'}))))?.[0]||null;}
 async galleriesByName(name){return await this.request(this.table('galleries',new URLSearchParams({legal_key:'eq.'+name})));}
 async insertGallery(row){await this.request(this.table('galleries'),{method:'POST',body:row});return row;}
 async updateGallery(id,patch){return (await this.request(this.table('galleries',new URLSearchParams({id:'eq.'+id})),{method:'PATCH',body:patch,headers:{Prefer:'return=representation'}}))?.[0];}
 async deleteGallery(id){await this.request(this.table('galleries',new URLSearchParams({id:'eq.'+id})),{method:'DELETE'});}
 async photos(id){return await this.request(this.table('photos',new URLSearchParams({gallery_id:'eq.'+id,status:'eq.ready',order:'created.asc,id.asc'})));}
 async allPhotos(id){return await this.request(this.table('photos',new URLSearchParams({gallery_id:'eq.'+id})));}
 async getPhoto(id){return (await this.request(this.table('photos',new URLSearchParams({id:'eq.'+id,limit:'1'}))))?.[0]||null;}
 async removePhoto(id){await this.request(this.table('photos',new URLSearchParams({id:'eq.'+id})),{method:'DELETE'});}
 async reservePhoto(args){return await this.request('/rest/v1/rpc/hs_reserve_photo',{method:'POST',body:args});}
 async finishPhoto(id){return await this.request('/rest/v1/rpc/hs_finish_photo',{method:'POST',body:{p_id:id}});}
 async rateLimit(key){return await this.request('/rest/v1/rpc/hs_rate_limit',{method:'POST',body:{p_key:key}});}
 async signUpload(key){const result=await this.request(`/storage/v1/object/upload/sign/${BUCKET}/${key}`,{method:'POST',body:{upsert:false}});const path=result.url||result.signedURL||result.signedUrl;if(!path)throw new ServiceError('Upload signing failed.',502);return path.startsWith('https://')?path:this.url+'/storage/v1'+(path.startsWith('/')?'':'/')+path;}
 async signDownload(key,{download=false,filename='photograph.jpg'}={}){
  const result=await this.request(`/storage/v1/object/sign/${BUCKET}/${key}`,{method:'POST',body:{expiresIn:120}});
  const path=result.signedURL||result.signedUrl;const url=new URL(path.startsWith('https://')?path:this.url+'/storage/v1'+path);
  if(download)url.searchParams.set('download',filename);return url.href;
 }
 async removeObjects(keys){if(keys.length)await this.request(`/storage/v1/object/${BUCKET}`,{method:'DELETE',body:{prefixes:keys}});}
 async verifyHeaders(photo){
  for(const [key,mime] of [[photo.original_key,photo.mime],[photo.preview_key,'image/jpeg']]){
   const response=await this.fetcher(`${this.url}/storage/v1/object/authenticated/${BUCKET}/${key}`,{headers:{...this.auth,Range:'bytes=0-31'}});
   if(!response.ok)throw new ServiceError('An uploaded photograph is missing.',400);
   const reader=response.body.getReader(),b=new Uint8Array(32);let total=0;try{while(total<12){const {value,done}=await reader.read();if(done)break;const part=value.subarray(0,32-total);b.set(part,total);total+=part.length;}}finally{await reader.cancel().catch(()=>{});}
   const valid=mime==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:mime==='image/png'?b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71:b[0]===82&&b[1]===73&&b[2]===70&&b[3]===70&&String.fromCharCode(...b.slice(8,12))==='WEBP';
   if(!valid)throw new ServiceError('The photo contents do not match its image type.',400);
  }
 }
 async cleanup(){
  const expired=await this.request(this.table('photos',new URLSearchParams({status:'eq.pending',pending_until:'lt.'+Date.now()/1000,limit:'100'})));
  if(expired.length){await this.removeObjects(expired.flatMap(p=>[p.original_key,p.preview_key]));await this.request(this.table('photos',new URLSearchParams({id:'in.('+expired.map(p=>p.id).join(',')+')'})),{method:'DELETE'});}
  await this.request(this.table('sessions',new URLSearchParams({expires:'lt.'+Date.now()/1000})),{method:'DELETE'});
  await this.request(this.table('login_limits',new URLSearchParams({started:'lt.'+(Date.now()/1000-86400)})),{method:'DELETE'});
 }
}
