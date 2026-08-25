-- C14：糖霜餅乾馬賽克
--
-- 活動中有一段是大家用糖霜彩繪餅乾。彩繪完拍照上傳，照片變成河道裡的
-- 一格，密鋪在整條河上跟著水流走——每個人的餅乾就是河的一段。
--
-- 為什麼不是「拼成流嚮25 幾個字」：算過了。中文字的筆畫細，
-- 兩百到三百五十張照片，每一筆畫分不到一格（0.72～0.95 格），
-- 筆畫會斷成一顆一顆，遠看讀不出是字；要拼到好讀需要兩千四百張。
-- 而且把字放大沒有用——格子是「用 N 張鋪滿著墨面積」算的，
-- 字變大格子跟著變大，比例完全不變。
-- 河道那條粗 S 只要一百七十五張就好讀，而且本來就是主視覺。
--
-- 幾個決定：
--
-- 1. 一台裝置一張。重拍是換掉自己那一張，不是多一張。
--    現場一定會有人拍壞想重來，而每個人佔一格才公平。
--
-- 2. 主持人可以隱藏個別照片。兩百多張裡面總會有一兩張拍到桌面、
--    拍到人臉、或是根本不是餅乾。不能刪只能藏——刪了那個人會問
--    「我的呢」，藏起來至少查得到。
--
-- 3. 上傳的視窗跟著活動狀態走（open）。跟簽到同一套規則，
--    不另外做一個開關讓主持人多記一件事。
--
-- 此檔可重複執行。

-- ============================================================
-- 餅乾照片
-- ============================================================

create table if not exists public.cookies (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete cascade,
  device_token text not null,
  -- 上傳者的名字。沒有強制填——現場排隊拍照時，多一個欄位就是多一道卡關。
  display_name text,
  image_path   text not null,
  is_visible   boolean not null default true,
  created_at   timestamptz not null default now(),

  -- 一台裝置一張。重拍是 update 這一列。
  unique (event_id, device_token),
  constraint cookies_name_length
    check (display_name is null or char_length(btrim(display_name)) between 1 and 30)
);

create index if not exists cookies_event_idx
  on public.cookies (event_id, created_at);

alter table public.cookies enable row level security;

-- 大螢幕要讀得到（匿名），所以開放讀取可見的那些。
-- 這裡沒有隱私問題：照片本來就是要投在牆上給全場看的。
drop policy if exists cookies_public_read on public.cookies;
create policy cookies_public_read on public.cookies
  for select to anon, authenticated
  using (is_visible);

-- 寫入一律走函式：要檢查活動狀態、要處理重拍、要擋掉別人的 device_token
drop policy if exists cookies_no_direct_write on public.cookies;

-- 主持人看得到全部（含被藏起來的）
drop policy if exists cookies_host_read on public.cookies;
create policy cookies_host_read on public.cookies
  for select to authenticated
  using (exists (
    select 1 from public.events e
     where e.id = cookies.event_id and e.host_id = auth.uid()));

drop policy if exists cookies_host_update on public.cookies;
create policy cookies_host_update on public.cookies
  for update to authenticated
  using (exists (
    select 1 from public.events e
     where e.id = cookies.event_id and e.host_id = auth.uid()));

-- ============================================================
-- 儲存空間
-- ============================================================

-- 照片比手繪的角色大得多，但前端會先裁切並壓到 600KB 以內。
-- 上限給 1.5MB 是餘裕：編碼器的輸出大小會浮動，而現場排隊時
-- 不該卡在「上傳失敗」。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cookies', 'cookies', true, 1572864,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = true;

-- anon 只能傳到「開放中活動」的資料夾底下，不能覆蓋也不能刪
drop policy if exists cookies_anon_upload on storage.objects;
create policy cookies_anon_upload on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'cookies'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] in (
      select e.id::text from public.events e where e.status = 'open')
  );

-- ============================================================
-- 上傳／重拍（匿名）
-- ============================================================

drop function if exists public.submit_cookie(uuid, text, text, text);

create or replace function public.submit_cookie(
  p_event_id     uuid,
  p_device_token text,
  p_image_path   text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
  v_id    uuid;
  v_replaced boolean := false;
begin
  select * into v_event from public.events e where e.id = p_event_id;
  if v_event.id is null then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'open' then
    raise exception 'EVENT_CLOSED';
  end if;

  if coalesce(btrim(p_image_path), '') = '' then
    raise exception 'IMAGE_REQUIRED';
  end if;

  -- 路徑必須落在這場活動的資料夾底下。少了這一條，
  -- 有人就能把自己的紀錄指到別場活動的圖片。
  if p_image_path not like p_event_id::text || '/%' then
    raise exception 'BAD_IMAGE_PATH';
  end if;

  select id into v_id from public.cookies c
   where c.event_id = p_event_id and c.device_token = p_device_token;

  if v_id is null then
    insert into public.cookies (event_id, device_token, image_path, display_name)
    values (p_event_id, p_device_token, p_image_path,
            nullif(btrim(coalesce(p_display_name, '')), ''))
    returning id into v_id;
  else
    -- 重拍：換掉自己那一張，順便解除主持人先前的隱藏
    -- （重拍通常就是為了修正被藏起來的原因）
    update public.cookies
       set image_path = p_image_path,
           display_name = coalesce(
             nullif(btrim(coalesce(p_display_name, '')), ''), display_name),
           is_visible = true,
           created_at = now()
     where id = v_id;
    v_replaced := true;
  end if;

  perform realtime.send(
    jsonb_build_object('event_id', p_event_id, 'cookie_id', v_id),
    'cookie:changed', 'event:' || p_event_id, false);

  return jsonb_build_object('id', v_id, 'replaced', v_replaced);
end;
$$;

revoke execute on function public.submit_cookie(uuid, text, text, text) from public;
grant execute on function public.submit_cookie(uuid, text, text, text)
  to anon, authenticated;

-- ============================================================
-- 我自己那一張（匿名）
-- ============================================================

drop function if exists public.get_my_cookie(uuid, text);

create or replace function public.get_my_cookie(
  p_event_id     uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.cookies;
begin
  select * into v_row from public.cookies c
   where c.event_id = p_event_id and c.device_token = p_device_token;

  if v_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'image_path', v_row.image_path,
    'display_name', v_row.display_name,
    'is_visible', v_row.is_visible
  );
end;
$$;

revoke execute on function public.get_my_cookie(uuid, text) from public;
grant execute on function public.get_my_cookie(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕要的清單（匿名）
-- ============================================================

drop function if exists public.list_cookies(uuid);

create or replace function public.list_cookies(p_event_id uuid)
returns table (
  id           uuid,
  image_path   text,
  display_name text,
  created_at   timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  -- 依上傳時間排序：大螢幕靠這個順序把新的那一張排在固定的位置，
  -- 不會因為有人重拍就整片重排（重排的話大家都會找不到自己的）
  select c.id, c.image_path, c.display_name, c.created_at
    from public.cookies c
   where c.event_id = p_event_id and c.is_visible
   order by c.created_at, c.id
$$;

revoke execute on function public.list_cookies(uuid) from public;
grant execute on function public.list_cookies(uuid) to anon, authenticated;

-- ============================================================
-- 主持人：隱藏／恢復
-- ============================================================

create or replace function public.set_cookie_visible(
  p_cookie_id uuid,
  p_visible   boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
begin
  select c.event_id into v_event_id from public.cookies c where c.id = p_cookie_id;
  if v_event_id is null then
    raise exception 'COOKIE_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.events e
     where e.id = v_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  update public.cookies set is_visible = p_visible where id = p_cookie_id;

  perform realtime.send(
    jsonb_build_object('event_id', v_event_id, 'cookie_id', p_cookie_id),
    'cookie:changed', 'event:' || v_event_id, false);
end;
$$;

revoke execute on function public.set_cookie_visible(uuid, boolean) from public;
grant execute on function public.set_cookie_visible(uuid, boolean) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
