import {cp,mkdir,rm,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dist=path.join(root,'dist');
await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
// An allowlist prevents publishing data/, credentials, server code, or test fixtures.
for(const name of ['index.html','styles.css','script.js','assets','moments_web'])await cp(path.join(root,name),path.join(dist,name),{recursive:true});
console.log('Built portfolio + Your Moments. Private server data is excluded. Netlify Functions deploy separately.');
