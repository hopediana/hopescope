const base=(process.env.PUBLIC_URL||process.argv[2]||'').replace(/\/$/,'');
if(!base.startsWith('https://')){console.error('Usage: npm run check:deployment -- https://YOUR-SITE.netlify.app');process.exit(1);}
let failed=false;
for(const path of ['/','/moments','/assets/cursor.js','/moments-assets/downloads.js']){
 const response=await fetch(base+path);if(!response.ok){console.error('FAIL:',path,response.status);failed=true;}else console.log('OK:',path);
}
const response=await fetch(base+'/api/session');let session;try{session=await response.json();}catch{}
if(!response.ok||!session?.configured||!session?.cloud_uploads){console.error('Your Moments is not connected. Check Functions, production environment variables, and supabase/setup.sql.');failed=true;}
else console.log('OK: Your Moments backend is connected and reports its storage allowance.');
if(failed)process.exit(1);
console.log('Basic deployment checks passed. Next test a gallery, an upload, legal-name/code login, and original/ZIP downloads in a private browser window.');
