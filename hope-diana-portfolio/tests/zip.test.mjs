import test from 'node:test';import assert from 'node:assert/strict';import {writeZip} from '../moments_web/zip.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('streaming ZIP64 preserves original bytes and filenames (independent Python reader)',async()=>{
 const source=[new TextEncoder().encode('first photograph bytes'),new Uint8Array([0,255,17,44,50])],chunks=[];
 await writeZip(source.map((bytes,i)=>({id:String(i),filename:i?'second.jpg':'first.jpg',bytes:bytes.length})),async f=>new Response(source[Number(f.id)]),{async write(b){chunks.push(b)},async close(){}});
 const all=Buffer.concat(chunks.map(x=>Buffer.from(x)));assert.equal(all.readUInt32LE(0),0x04034b50);assert(all.includes(Buffer.from([0x50,0x4b,0x06,0x06])));
 const folder=await mkdtemp(path.join(os.tmpdir(),'hs-zip-'));try{const file=path.join(folder,'photos.zip');await writeFile(file,all);const check=spawnSync('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==['001-first.jpg','002-second.jpg']; assert z.read(z.namelist()[0])==b'first photograph bytes'; assert z.read(z.namelist()[1])==bytes([0,255,17,44,50]); assert z.testzip() is None",file],{encoding:'utf8'});if(check.error?.code==='ENOENT')return;assert.equal(check.status,0,check.stderr);}finally{await rm(folder,{recursive:true,force:true});}
});
test('incomplete downloads abort ZIP creation',async()=>{await assert.rejects(()=>writeZip([{id:'x',filename:'photo.jpg',bytes:10}],async()=>new Response(new Uint8Array([1,2])),{async write(){},async close(){}}),/incomplete/);});
