"""Single-owner photo delivery server. Run `python server.py setup`, then `python server.py`."""
from __future__ import annotations
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tempfile
import time
import warnings
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
MAX_FILE = 50 * 1024 * 1024
MAX_REQUEST = MAX_FILE + 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def password_hash(value: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(value.encode(), salt=salt, n=16384, r=8, p=1, maxmem=64*1024*1024)
    return salt.hex() + '$' + digest.hex()


def password_matches(value: str, stored: str) -> bool:
    try:
        salt, wanted = stored.split('$')
        actual = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, maxmem=64*1024*1024)
        return hmac.compare_digest(actual.hex(), wanted)
    except (ValueError, TypeError):
        return False


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def safe_name(value: str) -> str:
    value = re.sub(r'[^A-Za-z0-9._ -]', '_', value.replace('\\', '/').split('/')[-1])
    return value.strip(' .')[:120] or 'photograph'


def legal_name_key(value: str) -> str:
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def normalize_code(value: str) -> str:
    return ''.join(value.upper().split()).replace('-', '')


def new_client_code() -> str:
    alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    value=''.join(secrets.choice(alphabet) for _ in range(12))
    return 'HS-'+'-'.join(value[i:i+4] for i in range(0,12,4))


def create_app(data_directory: Path | None = None) -> FastAPI:
    data = Path(data_directory or os.environ.get('HOPESCOPE_DATA', ROOT / 'data')).resolve()
    data.mkdir(parents=True, exist_ok=True)
    files, temporary = data / 'files', data / 'temporary'
    files.mkdir(exist_ok=True); temporary.mkdir(exist_ok=True)
    config_path = data / 'config.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    secure_cookie = os.environ.get('COOKIE_SECURE', '0') == '1'
    public_url = os.environ.get('PUBLIC_URL', '').rstrip('/')
    portfolio_url = os.environ.get('PORTFOLIO_URL', '').strip()
    storage_limit = int(os.environ.get('STORAGE_LIMIT_GB', '100')) * 1024**3
    db_path = data / 'galleries.sqlite3'
    failures = defaultdict(list)

    def connect():
        db = sqlite3.connect(db_path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS galleries (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, client_name TEXT NOT NULL,
          client_email TEXT NOT NULL, note TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, expires REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          created REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY, gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
          filename TEXT NOT NULL, stored TEXT NOT NULL, preview TEXT NOT NULL,
          bytes INTEGER NOT NULL, mime TEXT NOT NULL, created REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, gallery_id TEXT,
          csrf TEXT NOT NULL, expires REAL NOT NULL
        );
        ''')
    # Migrate existing gallery metadata without exposing old bearer-link access.
    with connect() as db:
        columns={row['name'] for row in db.execute('PRAGMA table_info(galleries)')}
        if 'client_name_key' not in columns:
            db.execute("ALTER TABLE galleries ADD COLUMN client_name_key TEXT NOT NULL DEFAULT ''")
            # Old standalone passwords are not treated as newly issued client codes.
            db.execute("UPDATE galleries SET password_hash=''")
            db.execute("DELETE FROM sessions WHERE kind='client'")
        for row in db.execute('SELECT id,client_name FROM galleries').fetchall():
            db.execute('UPDATE galleries SET client_name_key=? WHERE id=?',(legal_name_key(row['client_name']),row['id']))
        db.execute('CREATE INDEX IF NOT EXISTS gallery_legal_name ON galleries(client_name_key)')
    dummy_code_hash=password_hash(secrets.token_urlsafe(24))
    # ZIPs are normally removed after downloads; clear leftovers from interrupted runs.
    for path in temporary.glob('*'):
        if path.is_file() and path.stat().st_mtime < time.time() - 86400:
            path.unlink(missing_ok=True)

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.data_directory = data

    @app.middleware('http')
    async def boundaries(request: Request, call_next):
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            origin = request.headers.get('origin')
            expected = public_url or str(request.base_url).rstrip('/')
            if origin and origin.rstrip('/') != expected:
                return JSONResponse({'detail': 'This request came from another website.'}, status_code=403)
        if request.method in ('POST', 'PATCH'):
            length = request.headers.get('content-length')
            if length is None:
                return JSONResponse({'detail': 'A request length is required.'}, status_code=411)
            try:
                if int(length) > MAX_REQUEST or int(length) < 0:
                    return JSONResponse({'detail': 'Upload limit: 50 MB per photo.'}, status_code=413)
            except ValueError:
                return JSONResponse({'detail': 'Invalid request length.'}, status_code=400)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'SAMEORIGIN'
        response.headers['Cache-Control'] = 'no-store'
        response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
        if secure_cookie:
            response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        return response

    def session(request, kind='owner'):
        cookie = request.cookies.get('hope_owner' if kind == 'owner' else 'hope_client', '')
        with connect() as db:
            row = db.execute('SELECT * FROM sessions WHERE token_hash=? AND kind=? AND expires>?',
                             (token_hash(cookie), kind, time.time())).fetchone()
        return row

    def owner(request, mutate=False):
        row = session(request)
        if not row:
            raise HTTPException(401, 'Please sign in to your workspace.')
        if mutate and not hmac.compare_digest(request.headers.get('x-csrf-token', ''), row['csrf']):
            raise HTTPException(403, 'Refresh the page and try again.')
        return row

    def gallery_by_id(gallery_id):
        with connect() as db:
            row = db.execute('SELECT * FROM galleries WHERE id=?', (gallery_id,)).fetchone()
        if not row: raise HTTPException(404, 'Gallery not found.')
        return row

    def client_gallery(request):
        client=session(request,'client')
        if not client: raise HTTPException(401,'Please sign in with your legal name and gallery code.')
        row=gallery_by_id(client['gallery_id'])
        if not row['enabled'] or row['expires']<=time.time():
            raise HTTPException(401,'This gallery is not available. Please contact Hope.')
        return row

    def photo_rows(gallery_id):
        with connect() as db:
            return db.execute('SELECT * FROM photos WHERE gallery_id=? ORDER BY created,id', (gallery_id,)).fetchall()

    def photo_json(row, prefix):
        return {'id': row['id'], 'filename': row['filename'], 'bytes': row['bytes'],
                'preview': f'{prefix}/{row["id"]}/preview', 'download': f'{prefix}/{row["id"]}/download'}

    def gallery_json(row, request, include_photos=False):
        base = public_url or str(request.base_url).rstrip('/')
        photos = photo_rows(row['id'])
        result = {key: row[key] for key in ['id','title','client_name','client_email','note','expires','enabled','created']}
        result.update({'share_url': base + '/#moments', 'password_protected': True, 'code_issued': bool(row['password_hash']),
                       'photo_count': len(photos), 'bytes': sum(p['bytes'] for p in photos),
                       'expired': row['expires'] <= time.time(),
                       'cover': f'/api/admin/photos/{photos[0]["id"]}/preview' if photos else None})
        if include_photos:
            result['photos'] = [photo_json(p, '/api/admin/photos') for p in photos]
        return result

    def set_session(response, kind, gallery_id=None):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        duration = 8*3600 if kind == 'owner' else 24*3600
        with connect() as db:
            db.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (token_hash(token), kind, gallery_id, csrf, time.time()+duration))
        response.set_cookie('hope_owner' if kind == 'owner' else 'hope_client', token,
                            max_age=duration, httponly=True, secure=secure_cookie, samesite='strict', path='/')
        return csrf

    def rate_limit(request, category):
        key = (request.client.host if request.client else 'unknown', category)
        failures[key] = [t for t in failures[key] if t > time.time()-900]
        if len(failures[key]) >= 10:
            raise HTTPException(429, 'Too many attempts. Please try again in 15 minutes.')
        return key

    async def body_json(request):
        try:
            body = await request.json()
            if not isinstance(body, dict): raise ValueError()
            return body
        except (ValueError, json.JSONDecodeError):
            raise HTTPException(400, 'Please send a valid JSON object.')

    def text(body, key, limit, required=False, trim=True):
        value = body.get(key, '')
        if not isinstance(value, str): raise HTTPException(400, f'Invalid {key}.')
        value = value.strip() if trim else value
        if len(value) > limit or (required and not value):
            raise HTTPException(400, f'Check the {key.replace("_", " ")} field.')
        return value

    @app.get('/api/session')
    def current_session(request: Request):
        row = session(request)
        client=session(request,'client')
        return {'owner': bool(row), 'csrf': row['csrf'] if row else None, 'client':bool(client), 'client_csrf':client['csrf'] if client else None,
                'configured': bool(config.get('owner_password')), 'portfolio_url': portfolio_url,
                'storage_limit': storage_limit}

    @app.post('/api/login')
    async def login(request: Request):
        if not config.get('owner_password'): raise HTTPException(503, 'Run python server.py setup first.')
        key = rate_limit(request, 'owner')
        body = await body_json(request)
        password = text(body, 'password', 1024, trim=False)
        if not password_matches(password, config['owner_password']):
            failures[key].append(time.time()); raise HTTPException(401, 'That password did not match.')
        failures.pop(key, None)
        response = JSONResponse({'ok': True})
        set_session(response, 'owner')
        return response

    @app.post('/api/logout')
    def logout(request: Request):
        row = owner(request, True)
        with connect() as db: db.execute('DELETE FROM sessions WHERE token_hash=?', (row['token_hash'],))
        response = JSONResponse({'ok': True}); response.delete_cookie('hope_owner', path='/')
        return response

    @app.get('/api/galleries')
    def list_galleries(request: Request):
        owner(request)
        with connect() as db: rows = db.execute('SELECT * FROM galleries ORDER BY created DESC').fetchall()
        return {'galleries': [gallery_json(row, request) for row in rows]}

    @app.post('/api/galleries')
    async def create_gallery(request: Request):
        owner(request, True); body = await body_json(request)
        title, name = text(body,'title',120,True), text(body,'client_name',100,True)
        email, note = text(body,'client_email',254), text(body,'note',2000)
        code=new_client_code()
        if email and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email): raise HTTPException(400, 'Check the email address.')
        try: days = int(body.get('days',30))
        except (TypeError, ValueError): raise HTTPException(400, 'Check the expiry days.')
        if not 1 <= days <= 365: raise HTTPException(400, 'Expiry must be 1–365 days.')
        gallery_id = secrets.token_hex(12)
        with connect() as db:
            db.execute('INSERT INTO galleries (id,title,client_name,client_email,note,token,password_hash,expires,enabled,created,client_name_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (gallery_id,title,name,email,note,secrets.token_urlsafe(32),
                        password_hash(normalize_code(code)),time.time()+days*86400,1,time.time(),legal_name_key(name)))
        result=gallery_json(gallery_by_id(gallery_id),request,True);result['access_code']=code
        return result

    @app.get('/api/galleries/{gallery_id}')
    def get_gallery(gallery_id: str, request: Request):
        owner(request); return gallery_json(gallery_by_id(gallery_id),request,True)

    @app.patch('/api/galleries/{gallery_id}')
    async def update_gallery(gallery_id: str, request: Request):
        owner(request, True); row=gallery_by_id(gallery_id); body=await body_json(request)
        action=body.get('action');code=None
        with connect() as db:
            if action=='toggle': db.execute('UPDATE galleries SET enabled=? WHERE id=?',(0 if row['enabled'] else 1,gallery_id))
            elif action=='rotate':
                code=new_client_code()
                db.execute('UPDATE galleries SET password_hash=? WHERE id=?',(password_hash(normalize_code(code)),gallery_id))
                db.execute('DELETE FROM sessions WHERE gallery_id=?',(gallery_id,))
            elif action=='extend': db.execute('UPDATE galleries SET expires=? WHERE id=?',(time.time()+30*86400,gallery_id))
            else: raise HTTPException(400,'Unknown gallery action.')
        result=gallery_json(gallery_by_id(gallery_id),request,True)
        if code: result['access_code']=code
        return result

    @app.delete('/api/galleries/{gallery_id}')
    def delete_gallery(gallery_id: str, request: Request):
        owner(request,True); gallery_by_id(gallery_id); rows=photo_rows(gallery_id)
        with connect() as db:
            db.execute('DELETE FROM sessions WHERE gallery_id=?',(gallery_id,))
            db.execute('DELETE FROM galleries WHERE id=?',(gallery_id,))
        for row in rows:
            (files/row['stored']).unlink(missing_ok=True); (files/row['preview']).unlink(missing_ok=True)
        return {'ok':True}

    def process_image(staging, preview):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(staging) as image:
                    image_format=image.format
                    if image_format not in ('JPEG','PNG','WEBP'): raise ValueError('Use JPEG, PNG, or WebP photographs.')
                    image.verify()
                with Image.open(staging) as image:
                    image=ImageOps.exif_transpose(image); image.thumbnail((1600,1600))
                    image.convert('RGB').save(preview, 'JPEG', quality=86)
            return {'JPEG':('.jpg','image/jpeg'),'PNG':('.png','image/png'),'WEBP':('.webp','image/webp')}[image_format]
        except (UnidentifiedImageError,OSError,ValueError,Image.DecompressionBombWarning,Image.DecompressionBombError):
            raise HTTPException(400,'This image could not be processed. Use a JPEG, PNG, or WebP under 40 megapixels.')

    @app.post('/api/galleries/{gallery_id}/photos')
    async def upload_photo(gallery_id: str, request: Request):
        owner(request,True); gallery_by_id(gallery_id)
        photo_id=secrets.token_hex(16); staging=temporary/(photo_id+'.upload'); preview=files/(photo_id+'.preview.jpg')
        original=None
        try:
            async with request.form(max_files=1,max_fields=0,max_part_size=MAX_FILE) as form:
                upload=form.get('photo')
                if not upload or not hasattr(upload,'read'): raise HTTPException(400,'Choose one photograph.')
                size=0
                with staging.open('wb') as target:
                    while chunk := await upload.read(1024*1024):
                        size+=len(chunk)
                        if size>MAX_FILE: raise HTTPException(413,'Upload limit: 50 MB per photo.')
                        target.write(chunk)
                extension,mime=await run_in_threadpool(process_image,staging,preview)
                filename=safe_name(Path(safe_name(upload.filename or 'photograph')).stem)+extension
            original=files/(photo_id+extension)
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                total=db.execute('SELECT COALESCE(SUM(bytes),0) FROM photos').fetchone()[0]
                if total+size>storage_limit: raise HTTPException(413,'The configured storage allowance is full.')
                staging.replace(original)
                db.execute('INSERT INTO photos VALUES(?,?,?,?,?,?,?,?)',
                           (photo_id,gallery_id,filename,original.name,preview.name,size,mime,time.time()))
            return {'photo':photo_json({'id':photo_id,'filename':filename,'bytes':size},'/api/admin/photos')}
        except Exception:
            preview.unlink(missing_ok=True)
            if original: original.unlink(missing_ok=True)
            raise
        finally: staging.unlink(missing_ok=True)

    def photo_by_id(photo_id, gallery_id=None):
        with connect() as db: row=db.execute('SELECT * FROM photos WHERE id=?',(photo_id,)).fetchone()
        if not row or (gallery_id and row['gallery_id']!=gallery_id): raise HTTPException(404,'Photo not found.')
        return row

    def photo_response(row, variant):
        if variant=='preview': return FileResponse(files/row['preview'],media_type='image/jpeg')
        if variant=='download': return FileResponse(files/row['stored'],media_type=row['mime'],filename=row['filename'])
        raise HTTPException(404,'Photo not found.')

    @app.get('/api/admin/photos/{photo_id}/{variant}')
    def owner_photo(photo_id:str,variant:str,request:Request):
        owner(request); return photo_response(photo_by_id(photo_id),variant)

    @app.delete('/api/admin/photos/{photo_id}')
    def delete_photo(photo_id:str,request:Request):
        owner(request,True); row=photo_by_id(photo_id)
        with connect() as db: db.execute('DELETE FROM photos WHERE id=?',(photo_id,))
        (files/row['stored']).unlink(missing_ok=True); (files/row['preview']).unlink(missing_ok=True)
        return {'ok':True}

    @app.post('/api/client/login')
    async def client_login(request:Request):
        key=rate_limit(request,'client');body=await body_json(request)
        name=text(body,'legal_name',100);code=normalize_code(text(body,'code',100))
        with connect() as db:
            rows=db.execute('SELECT * FROM galleries WHERE client_name_key=?',(legal_name_key(name),)).fetchall()
        found=None
        for row in rows:
            if password_matches(code,row['password_hash'] or dummy_code_hash) and row['password_hash'] and row['enabled'] and row['expires']>time.time():
                found=row;break
        if not rows: password_matches(code,dummy_code_hash)
        if not found:
            failures[key].append(time.time())
            raise HTTPException(401,'The name and code did not match an available gallery. Check both or contact Hope.')
        failures.pop(key,None);response=JSONResponse({'ok':True});set_session(response,'client',found['id'])
        return response

    @app.post('/api/client/logout')
    def client_logout(request:Request):
        row=session(request,'client')
        if not row or not hmac.compare_digest(request.headers.get('x-csrf-token',''),row['csrf']):
            raise HTTPException(403,'Refresh the page and try again.')
        with connect() as db: db.execute('DELETE FROM sessions WHERE token_hash=?',(row['token_hash'],))
        response=JSONResponse({'ok':True});response.delete_cookie('hope_client',path='/');return response

    @app.get('/api/client/gallery')
    def view_client(request:Request):
        row=client_gallery(request)
        return {'locked':False,'title':row['title'],'client_name':row['client_name'],'note':row['note'],
                'expires':row['expires'],'portfolio_url':'/#home',
                'photos':[photo_json(p,'/api/client/photos') for p in photo_rows(row['id'])]}

    @app.get('/api/client/photos/{photo_id}/{variant}')
    def client_photo(photo_id:str,variant:str,request:Request):
        row=client_gallery(request)
        return photo_response(photo_by_id(photo_id,row['id']),variant)

    @app.get('/api/client/zip')
    def download_zip(request:Request,ids:str=''):
        row=client_gallery(request); photos=photo_rows(row['id'])
        selected=set(ids.split(',')) if ids else None
        if selected:
            allowed={p['id'] for p in photos}
            if not selected.issubset(allowed): raise HTTPException(404,'A selected photograph is unavailable.')
            photos=[p for p in photos if p['id'] in selected]
        if not photos: raise HTTPException(400,'This gallery has no photographs yet.')
        fd,path=tempfile.mkstemp(suffix='.zip',dir=temporary); os.close(fd)
        try:
            with zipfile.ZipFile(path,'w',zipfile.ZIP_STORED) as archive:
                for index,photo in enumerate(photos,1):
                    archive.write(files/photo['stored'],f'{index:03}-{photo["filename"]}')
            return FileResponse(path,media_type='application/zip',filename=safe_name(row['title'])+'.zip',
                                background=BackgroundTask(Path(path).unlink,missing_ok=True))
        except Exception:
            Path(path).unlink(missing_ok=True); raise

    app.mount('/moments-assets',StaticFiles(directory=ROOT/'moments_web'),name='moments-assets')
    app.mount('/assets',StaticFiles(directory=ROOT/'assets'),name='portfolio-assets')

    @app.get('/moments')
    def moments_shell():
        return FileResponse(ROOT/'moments_web'/'index.html',media_type='text/html')

    @app.get('/admin')
    def admin_entry():
        return RedirectResponse('/#moments-admin')

    @app.get('/styles.css')
    def portfolio_css(): return FileResponse(ROOT/'styles.css',media_type='text/css')

    @app.get('/script.js')
    def portfolio_js(): return FileResponse(ROOT/'script.js',media_type='text/javascript')

    @app.get('/')
    def portfolio_shell():
        return FileResponse(ROOT/'index.html',media_type='text/html')

    return app


app = create_app()

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='setup':
        path=app.state.data_directory/'config.json'
        if path.exists() and input('Replace owner password and invalidate owner sessions? Type yes: ')!='yes': sys.exit(0)
        password=getpass.getpass('Choose an owner password (12+ characters): ')
        if not 12<=len(password)<=1024 or password!=getpass.getpass('Confirm password: '):
            sys.exit('Passwords must match and contain at least 12 characters.')
        path.write_text(json.dumps({'owner_password':password_hash(password)},indent=2)); path.chmod(0o600)
        with sqlite3.connect(app.state.data_directory/'galleries.sqlite3') as db:
            db.execute("DELETE FROM sessions WHERE kind='owner'")
        print('Owner account ready. Run: python server.py')
    else:
        import uvicorn
        uvicorn.run(app,host=os.environ.get('HOST','127.0.0.1'),port=int(os.environ.get('PORT','8000')),access_log=False)
