-- M1 重建腳本（開發期便利工具）
--
-- 用途：把 M1 建立的所有物件先清除再從頭重建，並塞入種子活動。
-- 可重複執行，不會出現「已存在」錯誤。
--
-- 警告：這會刪除 events / participants / draws 三張表的所有資料。
-- 只能在開發階段使用；活動正式開始後絕對不要執行。
--
-- 內容與 migrations/20260725190000_m1_init.sql + 20260725190001_m1_seed.sql 等價，
-- 兩邊若有修改必須同步。

-- ============================================================
-- 清除舊物件（不存在也不會報錯）
-- ============================================================

drop table if exists public.draws cascade;
drop table if exists public.participants cascade;
drop table if exists public.events cascade;
drop function if exists public.sync_participant_count() cascade;
drop function if exists public.get_my_participant(uuid, text);
drop function if exists public.get_stage_participants(uuid);
drop function if exists public.broadcast_participant_change() cascade;
drop policy if exists characters_anon_upload on storage.objects;

-- ============================================================
-- 資料表
-- ============================================================

create table public.events (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique not null,              -- 短碼，用於 QR Code 網址
  name               text not null,
  subtitle           text,
  world_template     text not null default 'ocean',     -- 對應程式碼中的模板 key
  draw_count         int  not null default 1,           -- 預計抽出人數
  allow_repeat       boolean not null default false,    -- 是否可重複中獎
  logo_url           text,
  bgm_url            text,
  status             text not null default 'draft',     -- draft | open | locked | drawing | finished
  participant_count  int  not null default 0,           -- 可見參與者人數快取，由觸發器維護
  host_id            uuid references auth.users(id),
  created_at         timestamptz not null default now(),

  constraint events_code_format check (code ~ '^[A-Z0-9]{4,12}$'),
  constraint events_name_length check (char_length(name) between 1 and 60),
  constraint events_status_valid check (status in ('draft', 'open', 'locked', 'drawing', 'finished')),
  constraint events_draw_count_positive check (draw_count between 1 and 100)
);

create table public.participants (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  display_name   text not null,                    -- 姓名
  character_name text,                             -- 角色名稱（可選）
  image_path     text not null,                    -- Storage 內的路徑（{event_id}/{participant_id}.webp）
  device_token   text not null,                    -- 前端產生的 uuid，存 localStorage，用於防重複
  is_visible     boolean not null default true,    -- 主持人可隱藏不當內容
  is_eligible    boolean not null default true,    -- 是否納入抽獎
  joined_at      timestamptz not null default now(),

  unique (event_id, device_token),
  constraint participants_display_name_length check (char_length(display_name) between 1 and 30),
  constraint participants_character_name_length check (character_name is null or char_length(character_name) between 1 and 30),
  constraint participants_device_token_length check (char_length(device_token) between 8 and 64)
);

create index participants_event_joined_idx on public.participants (event_id, joined_at);

create table public.draws (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  round_no       int  not null,
  participant_id uuid not null references public.participants(id),
  drawn_at       timestamptz not null default now(),
  voided_at      timestamptz                       -- 非 null 表示本輪已作廢（重抽）
);

create unique index draws_event_round_active_idx
  on public.draws (event_id, round_no)
  where voided_at is null;

create index draws_event_round_idx on public.draws (event_id, round_no);

-- ============================================================
-- 觸發器：維護 events.participant_count
-- ============================================================

create or replace function public.sync_participant_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_visible then
      update public.events set participant_count = participant_count + 1 where id = new.event_id;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.is_visible and not new.is_visible then
      update public.events set participant_count = participant_count - 1 where id = new.event_id;
    elsif not old.is_visible and new.is_visible then
      update public.events set participant_count = participant_count + 1 where id = new.event_id;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.is_visible then
      update public.events set participant_count = participant_count - 1 where id = old.event_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

create trigger participants_sync_count
  after insert or update of is_visible or delete on public.participants
  for each row execute function public.sync_participant_count();

-- ============================================================
-- RLS
-- ============================================================

alter table public.events enable row level security;
alter table public.participants enable row level security;
alter table public.draws enable row level security;

create policy events_public_read on public.events
  for select to anon, authenticated
  using (status in ('open', 'locked', 'drawing', 'finished'));

create policy events_host_read on public.events
  for select to authenticated
  using (host_id = auth.uid());

create policy events_host_insert on public.events
  for insert to authenticated
  with check (host_id = auth.uid());

create policy events_host_update on public.events
  for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy participants_anon_insert on public.participants
  for insert to anon, authenticated
  with check (
    exists (select 1 from public.events e where e.id = event_id and e.status = 'open')
    and is_visible
    and is_eligible
    and image_path like (event_id::text || '/%')
  );

create policy participants_host_select on public.participants
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

create policy participants_host_update on public.participants
  for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

create policy participants_host_delete on public.participants
  for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

create policy draws_public_read on public.draws
  for select to anon, authenticated
  using (true);

-- ============================================================
-- RPC：手機端取回自己的角色
-- ============================================================

create or replace function public.get_my_participant(p_event_id uuid, p_device_token text)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  is_visible boolean,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name, p.image_path, p.is_visible, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and p.device_token = p_device_token;
$$;

revoke execute on function public.get_my_participant(uuid, text) from public;
grant execute on function public.get_my_participant(uuid, text) to anon, authenticated;

-- 大螢幕的全量角色查詢（M3）：只回傳會投影在螢幕上的欄位與可見角色
create or replace function public.get_stage_participants(p_event_id uuid)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name, p.image_path, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and p.is_visible
   order by p.joined_at;
$$;

revoke execute on function public.get_stage_participants(uuid) from public;
grant execute on function public.get_stage_participants(uuid) to anon, authenticated;

-- 即時廣播（M4）：報名／隱藏／刪除時由資料庫廣播輕量訊息給大螢幕
create or replace function public.broadcast_participant_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event   text;
  v_payload jsonb;
  v_topic   text;
begin
  if tg_op = 'INSERT' then
    if not new.is_visible then
      return new;
    end if;
    v_event := 'participant:joined';
    v_payload := jsonb_build_object(
      'id', new.id,
      'display_name', new.display_name,
      'character_name', new.character_name,
      'image_path', new.image_path,
      'joined_at', new.joined_at
    );
    v_topic := 'event:' || new.event_id;
  elsif tg_op = 'UPDATE' then
    if old.is_visible = new.is_visible then
      return new;
    end if;
    if new.is_visible then
      v_event := 'participant:joined';
      v_payload := jsonb_build_object(
        'id', new.id,
        'display_name', new.display_name,
        'character_name', new.character_name,
        'image_path', new.image_path,
        'joined_at', new.joined_at
      );
    else
      v_event := 'participant:removed';
      v_payload := jsonb_build_object('id', new.id);
    end if;
    v_topic := 'event:' || new.event_id;
  else
    v_event := 'participant:removed';
    v_payload := jsonb_build_object('id', old.id);
    v_topic := 'event:' || old.event_id;
  end if;

  perform realtime.send(v_payload, v_event, v_topic, false);
  return coalesce(new, old);
exception when others then
  return coalesce(new, old);
end;
$$;

drop trigger if exists participants_broadcast_change on public.participants;
create trigger participants_broadcast_change
  after insert or update of is_visible or delete on public.participants
  for each row execute function public.broadcast_participant_change();

-- ============================================================
-- Storage：角色圖片 bucket
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('characters', 'characters', true, 204800, array['image/webp', 'image/png'])
on conflict (id) do nothing;

create policy characters_anon_upload on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'characters'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] in (select e.id::text from public.events e where e.status = 'open')
  );

-- ============================================================
-- Realtime
-- ============================================================

do $$
begin
  alter publication supabase_realtime add table public.participants;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.draws;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- 種子活動
-- ============================================================

insert into public.events (code, name, subtitle, world_template, draw_count, status)
values ('DEMO01', '示範活動', '海洋世界測試場', 'ocean', 3, 'open')
on conflict (code) do nothing;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
-- 少了這一行，新建立的函式要等快取自然過期才會生效，
-- 前端會收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';

-- 完成後回傳示範活動，讓執行者在結果面板直接看到驗收資訊
select code, name, status, participant_count from public.events where code = 'DEMO01';
