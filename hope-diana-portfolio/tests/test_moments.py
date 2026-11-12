import io,json,sqlite3,tempfile,time,unittest,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import httpx
from PIL import Image
from server import create_app,password_hash,normalize_code

class MomentsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.data=Path(self.temp.name)
        self.password='owner-password-12345'
        (self.data/'config.json').write_text(json.dumps({'owner_password':password_hash(self.password)}))
        self.app=create_app(self.data)
        self.owner=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://site.test')
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://site.test')
        await self.owner.post('/api/login',json={'password':self.password})
        self.headers={'X-CSRF-Token':(await self.owner.get('/api/session')).json()['csrf']}
        image=Image.new('RGB',(200,300),'#992b42');out=io.BytesIO();image.save(out,'JPEG');self.jpeg=out.getvalue()

    async def asyncTearDown(self):
        await self.owner.aclose();await self.client.aclose();self.temp.cleanup()

    async def create(self,name='Client Legal Name'):
        response=await self.owner.post('/api/galleries',json={'title':'Your finished photographs','client_name':name,'client_email':'client@example.com','note':'With love, Hope','days':30},headers=self.headers)
        self.assertEqual(response.status_code,200,response.text)
        gallery=response.json();self.assertRegex(gallery['access_code'],r'^HS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$');return gallery

    async def upload(self,g):
        response=await self.owner.post('/api/galleries/'+g['id']+'/photos',files={'photo':('../../photo.jpg',self.jpeg,'image/jpeg')},headers=self.headers)
        self.assertEqual(response.status_code,200,response.text);return response.json()['photo']

    async def login(self,g,name=None,code=None):
        return await self.client.post('/api/client/login',json={'legal_name':name or g['client_name'],'code':code or g['access_code']})

    async def test_name_and_code_required_for_gallery_previews_originals_and_zip(self):
        g=await self.create();p=await self.upload(g)
        for url in ['/api/client/gallery',f'/api/client/photos/{p["id"]}/preview',f'/api/client/photos/{p["id"]}/download','/api/client/zip']:
            self.assertEqual((await self.client.get(url)).status_code,401)
        wrongname=await self.login(g,name='Someone Else');wrongcode=await self.login(g,code='HS-WRONG-CODE-HERE')
        self.assertEqual(wrongname.status_code,401);self.assertEqual(wrongname.json(),wrongcode.json())
        self.assertEqual((await self.login(g)).status_code,200)
        view=(await self.client.get('/api/client/gallery')).json();self.assertEqual(len(view['photos']),1)
        photo=view['photos'][0]
        self.assertEqual((await self.client.get(photo['download'])).content,self.jpeg)
        self.assertEqual((await self.client.get(photo['preview'])).headers['content-type'],'image/jpeg')
        zipped=await self.client.get('/api/client/zip?ids='+p['id']);self.assertEqual(zipped.status_code,200)
        import zipfile
        with zipfile.ZipFile(io.BytesIO(zipped.content)) as z:self.assertEqual(z.read(z.namelist()[0]),self.jpeg)
        self.assertEqual(list((self.data/'temporary').glob('*.zip')),[])

    async def test_name_normalization_and_code_formatting(self):
        g=await self.create('José García')
        self.assertEqual((await self.login(g,name='  JOSE\u0301   GARCI\u0301A  ',code=normalize_code(g['access_code']).lower())).status_code,200)
        with sqlite3.connect(self.data/'galleries.sqlite3') as db:
            stored=db.execute('SELECT password_hash FROM galleries WHERE id=?',(g['id'],)).fetchone()[0]
        self.assertNotIn(g['access_code'],stored)
        detail=(await self.owner.get('/api/galleries/'+g['id'])).json()
        self.assertNotIn('access_code',detail);self.assertNotIn('password_hash',detail)

    async def test_client_is_limited_to_their_gallery(self):
        first=await self.create();second=await self.create('Another Client');p=await self.upload(first)
        await self.login(second)
        self.assertEqual((await self.client.get('/api/client/photos/'+p['id']+'/download')).status_code,404)
        self.assertEqual((await self.client.get('/api/client/zip?ids='+p['id'])).status_code,404)
        self.assertEqual((await self.client.get('/api/galleries')).status_code,401)
        self.assertEqual((await self.client.get('/api/admin/photos/'+p['id']+'/preview')).status_code,401)

    async def test_pause_expiry_and_replacement_code(self):
        g=await self.create();p=await self.upload(g);await self.login(g)
        async def change(action):return await self.owner.patch('/api/galleries/'+g['id'],json={'action':action},headers=self.headers)
        await change('toggle');self.assertEqual((await self.client.get('/api/client/gallery')).status_code,401)
        self.assertEqual((await self.login(g)).status_code,401)
        await change('toggle');self.assertEqual((await self.login(g)).status_code,200)
        rotated=(await change('rotate')).json();self.assertNotEqual(g['access_code'],rotated['access_code'])
        self.assertEqual((await self.client.get('/api/client/photos/'+p['id']+'/download')).status_code,401)
        self.assertEqual((await self.login(g)).status_code,401)
        self.assertEqual((await self.login(g,code=rotated['access_code'])).status_code,200)
        with sqlite3.connect(self.data/'galleries.sqlite3') as db:db.execute('UPDATE galleries SET expires=? WHERE id=?',(time.time()-1,g['id']))
        self.assertEqual((await self.client.get('/api/client/zip')).status_code,401)
        await change('extend');self.assertEqual((await self.client.get('/api/client/gallery')).status_code,200)

    async def test_client_logout_and_csrf(self):
        g=await self.create();await self.login(g)
        self.assertEqual((await self.client.post('/api/client/logout')).status_code,403)
        csrf=(await self.client.get('/api/session')).json()['client_csrf']
        self.assertEqual((await self.client.post('/api/client/logout',headers={'X-CSRF-Token':csrf})).status_code,200)
        self.assertEqual((await self.client.get('/api/client/gallery')).status_code,401)

    async def test_admin_login_csrf_and_origin(self):
        self.assertEqual((await self.client.post('/api/login',json={'password':'wrong'})).status_code,401)
        self.assertEqual((await self.owner.post('/api/galleries',json={})).status_code,403)
        self.assertEqual((await self.owner.post('/api/galleries',json={},headers={**self.headers,'Origin':'https://other.test'})).status_code,403)
        await self.owner.post('/api/logout',headers=self.headers)
        self.assertEqual((await self.owner.get('/api/galleries')).status_code,401)

    async def test_same_site_portfolio_and_your_moments_routes(self):
        page=await self.client.get('/');self.assertIn('Your Moments',page.text)
        self.assertIn("frame-ancestors 'self'",page.headers['content-security-policy'])
        self.assertEqual(page.headers['x-frame-options'],'SAMEORIGIN')
        self.assertEqual((await self.client.get('/moments?embed=1')).status_code,200)
        self.assertEqual((await self.client.get('/moments-assets/app.js')).status_code,200)
        self.assertEqual((await self.client.get('/styles.css')).status_code,200)
        self.assertEqual((await self.client.get('/api/public/some-old-token')).status_code,404)
        self.assertEqual((await self.client.get('/g/some-old-token')).status_code,404)
        self.assertEqual((await self.client.get('/data/config.json')).status_code,404)
        self.assertEqual((await self.client.get('/admin')).headers['location'],'/#moments-admin')

    async def test_storage_default_and_actual_quota_cleanup(self):
        self.assertEqual((await self.client.get('/api/session')).json()['storage_limit'],100*1024**3)
        g=await self.create()
        with patch.dict('os.environ',{'STORAGE_LIMIT_GB':'0'}):limited=create_app(self.data)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=limited),base_url='http://site.test') as client:
            await client.post('/api/login',json={'password':self.password});csrf=(await client.get('/api/session')).json()['csrf']
            response=await client.post('/api/galleries/'+g['id']+'/photos',files={'photo':('photo.jpg',self.jpeg,'image/jpeg')},headers={'X-CSRF-Token':csrf})
            self.assertEqual(response.status_code,413)
        self.assertEqual(list((self.data/'files').iterdir()),[])
        self.assertEqual(list((self.data/'temporary').iterdir()),[])

    async def test_bad_uploads_and_deleted_gallery(self):
        g=await self.create()
        response=await self.owner.post('/api/galleries/'+g['id']+'/photos',files={'photo':('evil.jpg',b'not a photograph','image/jpeg')},headers=self.headers)
        self.assertEqual(response.status_code,400)
        await self.upload(g);await self.login(g)
        self.assertEqual((await self.owner.delete('/api/galleries/'+g['id'],headers=self.headers)).status_code,200)
        self.assertEqual((await self.client.get('/api/client/gallery')).status_code,401)
        self.assertEqual(list((self.data/'files').iterdir()),[])

    async def test_gallery_and_code_survive_server_restart(self):
        g=await self.create();await self.upload(g)
        restarted=create_app(self.data)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted),base_url='http://site.test') as client:
            response=await client.post('/api/client/login',json={'legal_name':g['client_name'],'code':g['access_code']})
            self.assertEqual(response.status_code,200)
            self.assertEqual(len((await client.get('/api/client/gallery')).json()['photos']),1)

    async def test_legacy_gallery_migration_requires_a_new_code(self):
        legacy=self.data/'legacy';legacy.mkdir()
        (legacy/'config.json').write_text(json.dumps({'owner_password':password_hash(self.password)}))
        with sqlite3.connect(legacy/'galleries.sqlite3') as db:
            db.execute('CREATE TABLE galleries(id TEXT PRIMARY KEY,title TEXT,client_name TEXT,client_email TEXT,note TEXT,token TEXT,password_hash TEXT,expires REAL,enabled INTEGER,created REAL)')
            db.execute('INSERT INTO galleries VALUES(?,?,?,?,?,?,?,?,?,?)',('legacy','Legacy photos','Legacy Client','','','old-token',password_hash('old-password'),time.time()+86400,1,time.time()))
        migrated=create_app(legacy)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=migrated),base_url='http://site.test') as client:
            response=await client.post('/api/client/login',json={'legal_name':'Legacy Client','code':'old-password'})
            self.assertEqual(response.status_code,401)
            await client.post('/api/login',json={'password':self.password})
            csrf=(await client.get('/api/session')).json()['csrf']
            detail=(await client.get('/api/galleries/legacy')).json();self.assertFalse(detail['code_issued'])
            new=(await client.patch('/api/galleries/legacy',json={'action':'rotate'},headers={'X-CSRF-Token':csrf})).json()
            self.assertEqual((await client.post('/api/client/login',json={'legal_name':'Legacy Client','code':new['access_code']})).status_code,200)

    async def test_client_login_throttling(self):
        for _ in range(10):self.assertEqual((await self.client.post('/api/client/login',json={'legal_name':'No Such Client','code':'wrong'})).status_code,401)
        self.assertEqual((await self.client.post('/api/client/login',json={'legal_name':'No Such Client','code':'wrong'})).status_code,429)

if __name__=='__main__':unittest.main()
