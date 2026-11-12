// Streaming ZIP64, stored (uncompressed) entries. No whole-gallery buffer is required.
const encoder=new TextEncoder();
const table=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
const packet=(length,signature)=>{const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);view.setUint32(0,signature,true);return {bytes,view};};
export async function writeZip(files,openFile,sink,progress=()=>{}){
 let offset=0n;const entries=[];
 const write=async bytes=>{await sink.write(bytes);offset+=BigInt(bytes.byteLength);};
 for(const [index,file]of files.entries()){
  const name=encoder.encode(String(index+1).padStart(3,'0')+'-'+file.filename.replace(/[\\/]/g,'_'));
  const expected=BigInt(file.bytes),start=offset;
  const local=packet(30+name.length+20,0x04034b50),v=local.view;
  v.setUint16(4,45,true);v.setUint16(6,0x0808,true);v.setUint16(12,0x21,true);
  v.setUint32(18,0xffffffff,true);v.setUint32(22,0xffffffff,true);v.setUint16(26,name.length,true);v.setUint16(28,20,true);
  local.bytes.set(name,30);v.setUint16(30+name.length,1,true);v.setUint16(32+name.length,16,true);v.setBigUint64(34+name.length,expected,true);v.setBigUint64(42+name.length,expected,true);
  await write(local.bytes);
  let crc=0xffffffff,total=0n;const response=await openFile(file);
  if(!response.ok||!response.body)throw Error('A photograph could not be downloaded. Please sign in and try again.');
  const reader=response.body.getReader();
  try{while(true){const{value,done}=await reader.read();if(done)break;total+=BigInt(value.byteLength);if(total>expected)throw Error('A photograph changed size. Please refresh and retry.');for(const byte of value)crc=table[(crc^byte)&255]^(crc>>>8);await write(value);progress(index+1,files.length,file.filename);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  if(total!==expected)throw Error('A photograph download was incomplete. Please try again.');
  crc=(crc^0xffffffff)>>>0;
  const descriptor=packet(24,0x08074b50);descriptor.view.setUint32(4,crc,true);descriptor.view.setBigUint64(8,total,true);descriptor.view.setBigUint64(16,total,true);await write(descriptor.bytes);
  entries.push({name,start,total,crc});
 }
 const centralStart=offset;
 for(const entry of entries){const{name,start,total,crc}=entry,c=packet(46+name.length+28,0x02014b50),v=c.view;
  v.setUint16(4,45,true);v.setUint16(6,45,true);v.setUint16(8,0x0808,true);v.setUint16(14,0x21,true);v.setUint32(16,crc,true);v.setUint32(20,0xffffffff,true);v.setUint32(24,0xffffffff,true);v.setUint16(28,name.length,true);v.setUint16(30,28,true);v.setUint32(42,0xffffffff,true);c.bytes.set(name,46);
  const p=46+name.length;v.setUint16(p,1,true);v.setUint16(p+2,24,true);v.setBigUint64(p+4,total,true);v.setBigUint64(p+12,total,true);v.setBigUint64(p+20,start,true);await write(c.bytes);
 }
 const centralSize=offset-centralStart,zip64Start=offset,count=BigInt(entries.length);
 const end64=packet(56,0x06064b50),v=end64.view;v.setBigUint64(4,44n,true);v.setUint16(12,45,true);v.setUint16(14,45,true);v.setBigUint64(24,count,true);v.setBigUint64(32,count,true);v.setBigUint64(40,centralSize,true);v.setBigUint64(48,centralStart,true);await write(end64.bytes);
 const locator=packet(20,0x07064b50);locator.view.setBigUint64(8,zip64Start,true);locator.view.setUint32(16,1,true);await write(locator.bytes);
 const end=packet(22,0x06054b50);end.view.setUint16(8,0xffff,true);end.view.setUint16(10,0xffff,true);end.view.setUint32(12,0xffffffff,true);end.view.setUint32(16,0xffffffff,true);await write(end.bytes);
 await sink.close();
}
