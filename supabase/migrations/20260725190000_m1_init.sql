-- M1：資料庫初始化
-- 內容：資料表、索引、觸發器、RLS 政策、Storage bucket 與其政策、Realtime 發布設定
--
-- 設計決策（相對於原規格的增補）：
-- 1. events.participant_count：由觸發器維護的可見人數快取，
--    讓手機端輪詢「世界裡已有幾位」時只需讀 events 一列，不需掃 participants。
-- 2. draws.voided_at：支援「作廢本輪重抽」。唯一約束改為 partial index，
--    只對未作廢的輪次生效，現場按錯或中獎者離場時才有退路。
-- 3. participants 對 anon 完全關閉 select，手機端取回自己的角色一律走
--    get_my_participant() RPC，攻擊面最小（RLS 無法得知瀏覽器的 localStorage）。
-- 4. 大螢幕以主持人身分登入（authenticated），透過 host_id 政策讀取全量參與者。

-- ============================================================
-- 資料表
-- ============================================================

-- 活動
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

-- 參與者（= 一個角色）
create table public.participants (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  display_name   text not null,                    -- 姓名
  character_name text,                             -- 角色名稱（可選）
  image_path     text not null,                    -- Storage 內的路徑（{event_id}/{participant_id}.webp），不存 base64
  device_token   text not null,                    -- 前端產生的 uuid，存 localStorage，用於防重複
  is_visible     boolean not null default true,    -- 主持人可隱藏不當內容
  is_eligible    boolean not null default true,    -- 是否納入抽獎
  joined_at      timestamptz not null default now(),

  unique (event_id, device_token),                 -- 一台裝置一場活動只能送一次
  constraint participants_display_name_length check (char_length(display_name) between 1 and 30),
  constraint participants_character_name_length check (character_name is null or char_length(character_name) between 1 and 30),
  constraint participants_device_token_length check (char_length(device_token) between 8 and 64)
);

create index participants_event_joined_idx on public.participants (event_id, joined_at);

-- 抽獎結果
create table public.draws (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  round_no       int  not null,
  participant_id uuid not null references public.participants(id),
  drawn_at       timestamptz not null default now(),
  voided_at      timestamptz                       -- 非 null 表示本輪已作廢（重抽）
);

-- 同一活動的同一輪次只能有一筆「有效」結果；作廢的輪次可重抽
create unique index draws_event_round_active_idx
  on public.draws (event_id, round_no)
  where voided_at is null;

create index draws_event_round_idx on public.draws (event_id, round_no);

-- ============================================================
-- 觸發器：維護 events.participant_count（只計 is_visible 的參與者）
-- ============================================================

-- security definer：insert 是 anon 執行的，anon 沒有 update events 的權限，
-- 計數維護必須以函式擁有者的身分執行
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

-- events：匿名端只能看到已公開狀態的活動；主持人能看到自己的全部活動（含草稿）
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

-- participants：
-- anon 可 insert，條件是活動開放中、欄位符合格式、圖片路徑落在該活動的資料夾底下。
-- anon 沒有任何 select 政策（完全關閉）；手機端取回自己的角色走 get_my_participant() RPC。
create policy participants_anon_insert on public.participants
  for insert to anon, authenticated
  with check (
    exists (select 1 from public.events e where e.id = event_id and e.status = 'open')
    and is_visible
    and is_eligible
    and image_path like (event_id::text || '/%')
  );

-- 主持人（含以主持人身分登入的大螢幕）可讀取自己活動的全部參與者。
-- 注意：Realtime 的 Postgres Changes 會對訂閱者套用 RLS，
-- 大螢幕收得到 INSERT 事件正是依賴這條政策。
create policy participants_host_select on public.participants
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- 主持人可隱藏不當內容、調整抽獎資格
create policy participants_host_update on public.participants
  for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- 主持人可刪除（現場備援：清除重複或測試資料）
create policy participants_host_delete on public.participants
  for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- draws：全端唯讀（手機也能看到中獎公布）。
-- 刻意不建立任何 insert/update 政策：寫入只能透過 M7 的 draw_winner() RPC
--（security definer），直接 insert 會被 RLS 擋下。
create policy draws_public_read on public.draws
  for select to anon, authenticated
  using (true);

-- ============================================================
-- RPC：手機端取回自己的角色
-- ============================================================

-- RLS 無法得知瀏覽器 localStorage 裡的 device_token，
-- 因此 participants 對 anon 關閉 select，改由這支函式比對 token 後
-- 只回傳非敏感欄位（不含 device_token 本身）
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

-- ============================================================
-- Storage：角色圖片 bucket
-- ============================================================

-- 公開 bucket：路徑含兩層 UUID 不可枚舉，圖片本來就要投影在大螢幕上。
-- 大螢幕與手機透過 CDN 直接讀，省下 350 次簽名 URL 的往返。
-- 限制單檔 200KB、只收 WebP 與 PNG。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('characters', 'characters', true, 204800, array['image/webp', 'image/png'])
on conflict (id) do nothing;

-- anon 只能上傳到「開放中活動」的資料夾底下；不能覆蓋、不能刪除（無 update/delete 政策）
create policy characters_anon_upload on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'characters'
    and array_length(storage.foldername(name), 1) = 1
    and (storage.foldername(name))[1] in (select e.id::text from public.events e where e.status = 'open')
  );

-- ============================================================
-- Realtime：讓大螢幕能訂閱 participants 的變更
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
