-- Run once in the Supabase SQL editor. Tables and bucket stay private.
create table if not exists public.hs_galleries (
 id text primary key, title text not null, client_name text not null, legal_key text not null,
 client_email text not null default '', note text not null default '', code_hash text not null,
 expires double precision not null, enabled boolean not null default true, created double precision not null
);
create index if not exists hs_gallery_name on public.hs_galleries(legal_key);
create table if not exists public.hs_sessions (
 token_hash text primary key, kind text not null check(kind in ('owner','client')),
 gallery_id text references public.hs_galleries(id) on delete cascade,
 csrf text not null, expires double precision not null, credential_version text not null default ''
);
create table if not exists public.hs_photos (
 id text primary key, gallery_id text not null references public.hs_galleries(id) on delete cascade,
 filename text not null, mime text not null, bytes bigint not null check(bytes>0),
 original_key text not null unique, preview_key text not null unique,
 status text not null default 'pending' check(status in ('pending','ready')),
 pending_until double precision not null, created double precision not null
);
create table if not exists public.hs_login_limits (
 key text primary key, started double precision not null, attempts integer not null
);

alter table public.hs_galleries enable row level security;
alter table public.hs_sessions enable row level security;
alter table public.hs_photos enable row level security;
alter table public.hs_login_limits enable row level security;
revoke all on public.hs_galleries, public.hs_sessions, public.hs_photos, public.hs_login_limits from anon, authenticated;
grant all on public.hs_galleries, public.hs_sessions, public.hs_photos, public.hs_login_limits to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('hopescope-private','hopescope-private',false,52428800,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=52428800,allowed_mime_types=excluded.allowed_mime_types;
-- Do not add public read/upload policies for this bucket. Only the server signs access.

create or replace function public.hs_rate_limit(p_key text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer; now_s double precision:=extract(epoch from now());
begin
 insert into hs_login_limits(key,started,attempts) values(p_key,now_s,1)
 on conflict(key) do update set
 attempts=case when hs_login_limits.started<now_s-900 then 1 else hs_login_limits.attempts+1 end,
 started=case when hs_login_limits.started<now_s-900 then now_s else hs_login_limits.started end
 returning attempts into n;
 return n<=10;
end $$;

create or replace function public.hs_reserve_photo(p_id text,p_gallery text,p_filename text,p_mime text,p_bytes bigint,p_limit bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare total bigint; suffix text; result hs_photos; now_s double precision:=extract(epoch from now());
begin
 perform pg_advisory_xact_lock(6400360);
 if not exists(select 1 from hs_galleries where id=p_gallery) then raise exception 'GALLERY_NOT_FOUND'; end if;
 if (select count(*) from hs_photos where gallery_id=p_gallery and (status='ready' or pending_until>now_s))>=500 then raise exception 'GALLERY_FULL'; end if;
 if p_bytes<1 or p_bytes>52428800 then raise exception 'FILE_TOO_LARGE'; end if;
 if p_mime not in ('image/jpeg','image/png','image/webp') then raise exception 'FILE_TYPE'; end if;
 select coalesce(sum(bytes),0) into total from hs_photos where status='ready' or pending_until>now_s;
 if total+p_bytes>p_limit then raise exception 'STORAGE_LIMIT'; end if;
 suffix=case p_mime when 'image/jpeg' then '.jpg' when 'image/png' then '.png' else '.webp' end;
 insert into hs_photos(id,gallery_id,filename,mime,bytes,original_key,preview_key,status,pending_until,created)
 values(p_id,p_gallery,p_filename,p_mime,p_bytes,p_gallery||'/'||p_id||'/original'||suffix,
 p_gallery||'/'||p_id||'/preview.jpg','pending',now_s+7200,now_s) returning * into result;
 return to_jsonb(result);
end $$;

create or replace function public.hs_finish_photo(p_id text)
returns jsonb language plpgsql security definer set search_path=public,storage,pg_temp as $$
declare p public.hs_photos; original_meta jsonb; preview_meta jsonb;
begin
 perform pg_advisory_xact_lock(6400360);
 select * into p from public.hs_photos where id=p_id for update;
 if not found or p.status<>'pending' or p.pending_until<extract(epoch from now()) then raise exception 'UPLOAD_UNAVAILABLE'; end if;
 select metadata into original_meta from storage.objects where bucket_id='hopescope-private' and name=p.original_key;
 select metadata into preview_meta from storage.objects where bucket_id='hopescope-private' and name=p.preview_key;
 if original_meta is null or preview_meta is null then raise exception 'UPLOAD_INCOMPLETE'; end if;
 if coalesce((original_meta->>'size')::bigint,0)<>p.bytes or coalesce(original_meta->>'mimetype','')<>p.mime then raise exception 'UPLOAD_MISMATCH'; end if;
 if coalesce((preview_meta->>'size')::bigint,0)<1 or coalesce((preview_meta->>'size')::bigint,0)>2097152 or coalesce(preview_meta->>'mimetype','')<>'image/jpeg' then raise exception 'PREVIEW_INVALID'; end if;
 update public.hs_photos set status='ready' where id=p_id returning * into p;
 return to_jsonb(p);
end $$;

-- Only server-side service-role requests can call these functions.
revoke all on function public.hs_rate_limit(text) from public,anon,authenticated;
revoke all on function public.hs_reserve_photo(text,text,text,text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.hs_finish_photo(text) from public,anon,authenticated;
grant execute on function public.hs_rate_limit(text) to service_role;
grant execute on function public.hs_reserve_photo(text,text,text,text,bigint,bigint) to service_role;
grant execute on function public.hs_finish_photo(text) to service_role;
