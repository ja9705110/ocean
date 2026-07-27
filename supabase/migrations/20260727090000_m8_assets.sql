-- M8：活動素材（Logo）
--
-- Logo 與角色圖分開放：角色圖的政策允許匿名上傳到開放中活動的資料夾，
-- Logo 只有主持人能上傳，權限模型完全不同，混在同一個 bucket 會讓
-- 政策難以推理。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assets',
  'assets',
  true,
  1048576,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists assets_host_write on storage.objects;
drop policy if exists assets_host_update on storage.objects;
drop policy if exists assets_host_delete on storage.objects;

-- 只有活動的主持人能上傳到該活動的資料夾
create policy assets_host_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'assets'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] in (
      select e.id::text from public.events e where e.host_id = auth.uid()
    )
  );

create policy assets_host_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] in (
      select e.id::text from public.events e where e.host_id = auth.uid()
    )
  );

create policy assets_host_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'assets'
    and (storage.foldername(name))[1] in (
      select e.id::text from public.events e where e.host_id = auth.uid()
    )
  );

-- ============================================================
-- 大螢幕需要讀取活動的 Logo、BGM 與狀態
-- ============================================================

-- 既有的 fetchEventByCode 只選了部分欄位；改由這支 RPC 提供大螢幕
-- 每次輪詢所需的即時快照，一次查完狀態、人數與素材。
create or replace function public.get_event_snapshot(p_event_id uuid)
returns table (
  status text,
  participant_count int,
  logo_url text,
  bgm_url text,
  subtitle text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.status, e.participant_count, e.logo_url, e.bgm_url, e.subtitle
    from public.events e
   where e.id = p_event_id
     and e.status in ('open', 'locked', 'drawing', 'finished');
$$;

revoke execute on function public.get_event_snapshot(uuid) from public;
grant execute on function public.get_event_snapshot(uuid) to anon, authenticated;

notify pgrst, 'reload schema';

select id, public, file_size_limit from storage.buckets where id in ('assets', 'characters');
