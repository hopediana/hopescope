import {writeZip} from './zip.js';
const PART_LIMIT=150*1024**2;
const notifyParent=type=>{if(parent!==window)parent.postMessage({type},location.origin==='null'?'*':location.origin);};
function groups(files){const result=[];let current=[],size=0;for(const file of files){if(current.length&&size+file.bytes>PART_LIMIT){result.push(current);current=[];size=0;}current.push(file);size+=file.bytes;}if(current.length)result.push(current);return result;}
async function writeFiles(files,sink,api,status){
 await writeZip(files,async file=>{const signed=await api(file.url_endpoint);return fetch(signed.url,{cache:'no-store',credentials:'omit'});},sink,(n,total)=>status(`Preparing photograph ${n} of ${total}…`));
}
async function memoryZip(files,name,api,status){
 const chunks=[];let size=0;
 await writeFiles(files,{async write(chunk){size+=chunk.byteLength;if(size>PART_LIMIT+1024*1024)throw Error('This ZIP part is too large for this browser. Please download individual originals.');chunks.push(chunk);},async close(){}},api,status);
 const url=URL.createObjectURL(new Blob(chunks,{type:'application/zip'}));const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);status('ZIP download requested. Check your browser downloads.');
}
function offerParts(parts,title,api,status){
 const dialog=document.createElement('dialog'),heading=document.createElement('h2'),note=document.createElement('p'),close=document.createElement('button');dialog.className='download-parts';heading.textContent='A little collection, in parts.';note.textContent='This browser downloads large collections as smaller ZIP files. Download each part below, one at a time.';close.textContent='Close';close.className='button navy';close.addEventListener('click',()=>dialog.close());dialog.append(heading,note);
 parts.forEach((files,index)=>{const button=document.createElement('button');button.className='button navy';const label=`Download part ${index+1} · ${files.length} photographs`;button.textContent=label;button.addEventListener('click',async()=>{button.disabled=true;try{await memoryZip(files,`Hopescope-Photos-Part-${index+1}.zip`,api,status);}catch(error){status(error.message);}finally{button.disabled=false;}});dialog.append(button);});dialog.append(close);document.body.append(dialog);dialog.addEventListener('close',()=>{notifyParent('hopescope-moments-modal-close');dialog.remove();});dialog.showModal();notifyParent('hopescope-moments-modal');
}
export async function downloadCollection(ids,{api,status}){
 let writable;
 try{
  // Called directly from a click; the save picker must open before any network await.
  let handle=null;if(window.showSaveFilePicker){try{handle=await window.showSaveFilePicker({suggestedName:'Hopescope-Photos.zip',types:[{description:'ZIP archive',accept:{'application/zip':['.zip']}}]});}catch(error){if(error.name==='AbortError')throw error;/* Fall back to ZIP parts if this browser blocks the save picker. */}}
  const manifest=ids?.length?await api('/api/client/zip',{method:'POST',body:JSON.stringify({ids})}):await api('/api/client/zip');
  if(handle){writable=await handle.createWritable();await writeFiles(manifest.files,writable,api,status);status('Your ZIP file has been saved.');}
  else{const parts=groups(manifest.files);if(parts.length>1)offerParts(parts,manifest.title,api,status);else await memoryZip(manifest.files,'Hopescope-Photos.zip',api,status);}
 }catch(error){if(writable)await writable.abort().catch(()=>{});status(error.name==='AbortError'?'Download cancelled.':error.message);}
}
