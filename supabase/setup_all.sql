-- ============================================================
-- Interactive Event Platform：一次安裝全部資料庫結構
-- ============================================================
--
-- 這一份包含了目前為止所有的資料表、函式、權限政策與儲存設定。
-- 可以重複執行，不會刪除任何既有資料，也不會因為「已存在」而中斷。
--
-- 使用方式：
--   1. Supabase → SQL Editor → 開新查詢
--   2. 整份貼上，按 Ctrl/Cmd + A 全選
--   3. 按 Run
--   4. 看最下方的驗證結果，全部都要是「已建立」
--
-- 為什麼要全選：SQL Editor 在腳本很長時，若只把游標放在某一段，
-- 按 Run 可能只執行游標所在的那一段，造成「跑了卻沒生效」。
--
-- ============================================================



-- ############################################################
-- 來源：20260725190000_m1_init
-- ############################################################

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
create table if not exists public.events (
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
create table if not exists public.participants (
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

create index if not exists participants_event_joined_idx on public.participants (event_id, joined_at);

-- 抽獎結果
create table if not exists public.draws (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  round_no       int  not null,
  participant_id uuid not null references public.participants(id),
  drawn_at       timestamptz not null default now(),
  voided_at      timestamptz                       -- 非 null 表示本輪已作廢（重抽）
);

-- 同一活動的同一輪次只能有一筆「有效」結果；作廢的輪次可重抽
create unique index if not exists draws_event_round_active_idx
  on public.draws (event_id, round_no)
  where voided_at is null;

create index if not exists draws_event_round_idx on public.draws (event_id, round_no);

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

drop trigger if exists participants_sync_count on public.participants;
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
drop policy if exists events_public_read on public.events;
create policy events_public_read on public.events
  for select to anon, authenticated
  using (status in ('open', 'locked', 'drawing', 'finished'));

drop policy if exists events_host_read on public.events;
create policy events_host_read on public.events
  for select to authenticated
  using (host_id = auth.uid());

drop policy if exists events_host_insert on public.events;
create policy events_host_insert on public.events
  for insert to authenticated
  with check (host_id = auth.uid());

drop policy if exists events_host_update on public.events;
create policy events_host_update on public.events
  for update to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

-- participants：
-- anon 可 insert，條件是活動開放中、欄位符合格式、圖片路徑落在該活動的資料夾底下。
-- anon 沒有任何 select 政策（完全關閉）；手機端取回自己的角色走 get_my_participant() RPC。
drop policy if exists participants_anon_insert on public.participants;
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
drop policy if exists participants_host_select on public.participants;
create policy participants_host_select on public.participants
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- 主持人可隱藏不當內容、調整抽獎資格
drop policy if exists participants_host_update on public.participants;
create policy participants_host_update on public.participants
  for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- 主持人可刪除（現場備援：清除重複或測試資料）
drop policy if exists participants_host_delete on public.participants;
create policy participants_host_delete on public.participants
  for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- draws：全端唯讀（手機也能看到中獎公布）。
-- 刻意不建立任何 insert/update 政策：寫入只能透過 M7 的 draw_winner() RPC
--（security definer），直接 insert 會被 RLS 擋下。
drop policy if exists draws_public_read on public.draws;
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
drop policy if exists characters_anon_upload on storage.objects;
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


-- ############################################################
-- 來源：20260725190001_m1_seed
-- ############################################################

-- M1：種子活動
-- 建立一場開放中的示範活動，供 M2（手機端）與 M3（大螢幕）開發測試使用。
-- host_id 先留空，M6 建立主持人登入後再指派。

insert into public.events (code, name, subtitle, world_template, draw_count, status)
values ('DEMO01', '示範活動', '海洋世界測試場', 'ocean', 3, 'open')
on conflict (code) do nothing;


-- ############################################################
-- 來源：20260726090000_m3_stage_rpc
-- ############################################################

-- M3：大螢幕的全量角色查詢
--
-- participants 對 anon 完全關閉 select（M1 決策），大螢幕在 M6 導入
-- 主持人登入之前，先以此 RPC 取得初始渲染所需的全量資料。
-- 只回傳「本來就會投影在大螢幕上」的欄位，不含 device_token，
-- 且只回傳 is_visible 的角色（主持人隱藏後大螢幕自然拿不到）。
--
-- 此檔可獨立重複執行（create or replace），不影響既有資料。

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


-- ############################################################
-- 來源：20260726120000_m4_realtime_broadcast
-- ############################################################

-- M4：即時同步——資料庫端廣播
--
-- 作法：participants 的 INSERT / is_visible 變更 / DELETE 觸發時，
-- 由資料庫直接 realtime.send() 廣播到 topic「event:{event_id}」。
--
-- 為什麼不用 Postgres Changes：Realtime 的 Postgres Changes 會對每個
-- 訂閱者套用 RLS，而 participants 對 anon 完全關閉 select（M1 決策），
-- 大螢幕（M6 前是 anon 身分）會靜默收不到任何事件。改用資料庫廣播，
-- payload 由我們自行組裝：只含要投影的欄位，不含 device_token，
-- 更不含圖片位元（規格第 7 節：圖大螢幕自己去 Storage 抓）。
--
-- 此檔可獨立重複執行，不影響既有資料。

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
    -- 理論上不會有 insert 即隱藏的情況，防禦性略過
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
      -- 主持人取消隱藏：以完整資料重新進場
      v_event := 'participant:joined';
      v_payload := jsonb_build_object(
        'id', new.id,
        'display_name', new.display_name,
        'character_name', new.character_name,
        'image_path', new.image_path,
        'joined_at', new.joined_at
      );
    else
      -- 主持人隱藏：大螢幕即時移除（規格第 16 節第 4 點）
      v_event := 'participant:removed';
      v_payload := jsonb_build_object('id', new.id);
    end if;
    v_topic := 'event:' || new.event_id;

  else -- DELETE
    v_event := 'participant:removed';
    v_payload := jsonb_build_object('id', old.id);
    v_topic := 'event:' || old.event_id;
  end if;

  perform realtime.send(v_payload, v_event, v_topic, false);
  return coalesce(new, old);

exception when others then
  -- 廣播失敗絕不能擋下報名寫入；大螢幕的定期對帳會補上遺漏
  return coalesce(new, old);
end;
$$;

drop trigger if exists participants_broadcast_change on public.participants;
create trigger participants_broadcast_change
  after insert or update of is_visible or delete on public.participants
  for each row execute function public.broadcast_participant_change();


-- ############################################################
-- 來源：20260726150000_m6_host
-- ############################################################

-- M6：主持人端
--
-- 內容：活動建立 RPC（產生不重複短碼）、既有活動的 host 認領、
-- 大螢幕的活動存取政策調整。
--
-- 此檔可重複執行。

-- ============================================================
-- 短碼產生
-- ============================================================

-- 排除易混淆字元（0/O、1/I）的字母數字集合，現場口述與手動輸入才不會出錯
create or replace function public.generate_event_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from public.events e where e.code = v_code);

    v_attempt := v_attempt + 1;
    if v_attempt > 50 then
      raise exception 'CODE_GENERATION_FAILED';
    end if;
  end loop;

  return v_code;
end;
$$;

-- ============================================================
-- 建立活動
-- ============================================================

-- 以 RPC 而非直接 insert：短碼必須由伺服器產生並保證唯一，
-- 不能讓前端自行決定。回傳完整活動列供主持人端直接使用。
create or replace function public.create_event(
  p_name           text,
  p_subtitle       text default null,
  p_world_template text default 'ocean',
  p_draw_count     int  default 1,
  p_allow_repeat   boolean default false
)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  insert into public.events (code, name, subtitle, world_template, draw_count, allow_repeat, status, host_id)
  values (
    public.generate_event_code(),
    btrim(p_name),
    nullif(btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_world_template, 'ocean'),
    greatest(1, least(coalesce(p_draw_count, 1), 100)),
    coalesce(p_allow_repeat, false),
    'draft',
    auth.uid()
  )
  returning * into v_event;

  return v_event;
end;
$$;

revoke execute on function public.create_event(text, text, text, int, boolean) from public;
grant execute on function public.create_event(text, text, text, int, boolean) to authenticated;

-- ============================================================
-- 認領無主活動
-- ============================================================

-- M1 的種子活動 DEMO01 沒有 host_id，任何登入的主持人都無法管理它。
-- 這支讓第一位登入者認領無主活動，避免測試資料變成孤兒。
-- 已有 host 的活動不受影響。
create or replace function public.claim_event(p_code text)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.events
     set host_id = auth.uid()
   where code = upper(btrim(p_code))
     and host_id is null
  returning * into v_event;

  if v_event.id is null then
    raise exception 'EVENT_NOT_CLAIMABLE';
  end if;

  return v_event;
end;
$$;

revoke execute on function public.claim_event(text) from public;
grant execute on function public.claim_event(text) to authenticated;

-- ============================================================
-- 主持人的活動清單
-- ============================================================

-- events 的 RLS 已允許主持人讀取自己的活動，這支只是加上排序與
-- 待抽人數等衍生欄位，讓清單頁一次查完
create or replace function public.list_my_events()
returns table (
  id uuid,
  code text,
  name text,
  subtitle text,
  world_template text,
  draw_count int,
  allow_repeat boolean,
  status text,
  participant_count int,
  drawn_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id, e.code, e.name, e.subtitle, e.world_template,
    e.draw_count, e.allow_repeat, e.status, e.participant_count,
    (select count(*) from public.draws d where d.event_id = e.id and d.voided_at is null),
    e.created_at
  from public.events e
  where e.host_id = auth.uid()
  order by e.created_at desc;
$$;

revoke execute on function public.list_my_events() from public;
grant execute on function public.list_my_events() to authenticated;

-- ============================================================
-- 主持人的參與者清單
-- ============================================================

-- 與大螢幕的 get_stage_participants 不同：主持人需要看到已隱藏的角色
-- 才能取消隱藏，也需要 is_eligible 來排除特定人。
-- 仍不回傳 device_token。
create or replace function public.list_event_participants(p_event_id uuid)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  is_visible boolean,
  is_eligible boolean,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name, p.image_path,
         p.is_visible, p.is_eligible, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and exists (
       select 1 from public.events e
        where e.id = p_event_id and e.host_id = auth.uid()
     )
   order by p.joined_at desc;
$$;

revoke execute on function public.list_event_participants(uuid) from public;
grant execute on function public.list_event_participants(uuid) to authenticated;


-- ############################################################
-- 來源：20260726180000_m7_prizes_and_draw
-- ############################################################

-- M7：獎項與抽獎
--
-- 把單一的 events.draw_count 擴充為獎項清單：每個獎項有名稱與名額，
-- 抽獎依序逐一獎項進行。draws 記錄該筆中獎屬於哪個獎項。
--
-- 核心原則（規格第 11 節）：中獎者一律由資料庫決定，
-- 前端只負責播動畫。draws 表是唯一真實來源，重整不會改變結果。
--
-- 此檔可重複執行。

-- ============================================================
-- 獎項
-- ============================================================

create table if not exists public.prizes (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  name       text not null,                 -- 獎項名稱，例如「頭獎 掃地機器人」
  quantity   int  not null default 1,       -- 這個獎項要抽幾位
  sort_order int  not null default 0,       -- 抽獎順序，小的先抽
  created_at timestamptz not null default now(),

  constraint prizes_name_length check (char_length(btrim(name)) between 1 and 40),
  constraint prizes_quantity_range check (quantity between 1 and 500)
);

create index if not exists prizes_event_order_idx
  on public.prizes (event_id, sort_order, created_at);

-- draws 增加獎項關聯。nullable：M7 之前的既有資料沒有獎項。
alter table public.draws
  add column if not exists prize_id uuid references public.prizes(id) on delete set null;

create index if not exists draws_prize_idx on public.draws (prize_id);

-- ============================================================
-- 獎項的 RLS
-- ============================================================

alter table public.prizes enable row level security;

drop policy if exists prizes_public_read on public.prizes;
drop policy if exists prizes_host_all on public.prizes;

-- 匿名端唯讀：大螢幕與手機需要顯示「目前抽的是什麼獎」
create policy prizes_public_read on public.prizes
  for select to anon, authenticated
  using (true);

create policy prizes_host_all on public.prizes
  for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- ============================================================
-- 建立活動時自動帶一個預設獎項
-- ============================================================

-- 讓「建立活動後就能直接抽獎」成立，主持人再視需要改名稱、加獎項。
-- 名額沿用表單上填的預計抽出人數。
create or replace function public.create_event(
  p_name           text,
  p_subtitle       text default null,
  p_world_template text default 'ocean',
  p_draw_count     int  default 1,
  p_allow_repeat   boolean default false
)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  v_count := greatest(1, least(coalesce(p_draw_count, 1), 100));

  insert into public.events (code, name, subtitle, world_template, draw_count, allow_repeat, status, host_id)
  values (
    public.generate_event_code(),
    btrim(p_name),
    nullif(btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_world_template, 'ocean'),
    v_count,
    coalesce(p_allow_repeat, false),
    'draft',
    auth.uid()
  )
  returning * into v_event;

  insert into public.prizes (event_id, name, quantity, sort_order)
  values (v_event.id, '中獎', v_count, 0);

  return v_event;
end;
$$;

revoke execute on function public.create_event(text, text, text, int, boolean) from public;
grant execute on function public.create_event(text, text, text, int, boolean) to authenticated;

-- ============================================================
-- 獎項清單（含抽獎進度）
-- ============================================================

create or replace function public.list_event_prizes(p_event_id uuid)
returns table (
  id uuid,
  name text,
  quantity int,
  sort_order int,
  drawn_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.name, p.quantity, p.sort_order,
    (select count(*) from public.draws d
      where d.prize_id = p.id and d.voided_at is null)
  from public.prizes p
  where p.event_id = p_event_id
  order by p.sort_order, p.created_at;
$$;

revoke execute on function public.list_event_prizes(uuid) from public;
grant execute on function public.list_event_prizes(uuid) to anon, authenticated;

-- ============================================================
-- 抽獎結果清單
-- ============================================================

create or replace function public.list_event_draws(p_event_id uuid)
returns table (
  id uuid,
  round_no int,
  prize_id uuid,
  prize_name text,
  participant_id uuid,
  display_name text,
  character_name text,
  image_path text,
  drawn_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id, d.round_no, d.prize_id,
    coalesce(pz.name, '中獎'),
    d.participant_id, pa.display_name, pa.character_name, pa.image_path,
    d.drawn_at
  from public.draws d
  join public.participants pa on pa.id = d.participant_id
  left join public.prizes pz on pz.id = d.prize_id
  where d.event_id = p_event_id
    and d.voided_at is null
  order by d.round_no;
$$;

revoke execute on function public.list_event_draws(uuid) from public;
grant execute on function public.list_event_draws(uuid) to anon, authenticated;

-- ============================================================
-- 抽獎（伺服器端決定）
-- ============================================================

-- 規格第 11 節：前端絕對不能自己 random。
--
-- 併發保護用 advisory lock 而非 for update：真正要序列化的是
-- 「算出下一個 round_no → 插入」這整段，鎖住某一列參與者並不能防止
-- 兩位主持人同時按下抽獎而產生重複輪次。
create or replace function public.draw_winner(p_event_id uuid, p_prize_id uuid)
returns table (
  draw_id uuid,
  round_no int,
  prize_id uuid,
  prize_name text,
  participant_id uuid,
  display_name text,
  character_name text,
  image_path text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_host boolean;
  v_allow_repeat boolean;
  v_prize public.prizes;
  v_drawn int;
  v_round int;
  v_winner public.participants;
  v_draw_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select (e.host_id = auth.uid()), e.allow_repeat
    into v_is_host, v_allow_repeat
    from public.events e
   where e.id = p_event_id;

  if v_is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 序列化同一活動的抽獎，交易結束自動釋放
  perform pg_advisory_xact_lock(hashtext(p_event_id::text));

  select * into v_prize
    from public.prizes pz
   where pz.id = p_prize_id and pz.event_id = p_event_id;

  if v_prize.id is null then
    raise exception 'PRIZE_NOT_FOUND';
  end if;

  select count(*) into v_drawn
    from public.draws d
   where d.prize_id = v_prize.id and d.voided_at is null;

  if v_drawn >= v_prize.quantity then
    raise exception 'PRIZE_QUOTA_REACHED';
  end if;

  select p.* into v_winner
    from public.participants p
   where p.event_id = p_event_id
     and p.is_eligible
     and p.is_visible
     and (
       v_allow_repeat
       or not exists (
         select 1 from public.draws d
          where d.participant_id = p.id and d.voided_at is null
       )
     )
   order by random()
   limit 1;

  if v_winner.id is null then
    raise exception 'NO_ELIGIBLE_PARTICIPANT';
  end if;

  select coalesce(max(d.round_no), 0) + 1 into v_round
    from public.draws d
   where d.event_id = p_event_id;

  insert into public.draws (event_id, round_no, participant_id, prize_id)
  values (p_event_id, v_round, v_winner.id, v_prize.id)
  returning id into v_draw_id;

  -- 直接由資料庫廣播給大螢幕：不依賴主持人裝置的連線狀態，
  -- 主持人端當掉或重整都不影響大螢幕收到結果
  perform realtime.send(
    jsonb_build_object(
      'draw_id', v_draw_id,
      'round_no', v_round,
      'prize_id', v_prize.id,
      'prize_name', v_prize.name,
      'participant_id', v_winner.id,
      'display_name', v_winner.display_name,
      'character_name', v_winner.character_name,
      'image_path', v_winner.image_path
    ),
    'draw:reveal',
    'event:' || p_event_id,
    false
  );

  return query
    select v_draw_id, v_round, v_prize.id, v_prize.name,
           v_winner.id, v_winner.display_name, v_winner.character_name,
           v_winner.image_path;
end;
$$;

revoke execute on function public.draw_winner(uuid, uuid) from public;
grant execute on function public.draw_winner(uuid, uuid) to authenticated;

-- ============================================================
-- 作廢一輪（現場按錯、或中獎者已離場）
-- ============================================================

create or replace function public.void_draw(p_draw_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_is_host boolean;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select d.event_id into v_event_id from public.draws d where d.id = p_draw_id;
  if v_event_id is null then
    raise exception 'DRAW_NOT_FOUND';
  end if;

  select (e.host_id = auth.uid()) into v_is_host
    from public.events e where e.id = v_event_id;

  if v_is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  update public.draws set voided_at = now()
   where id = p_draw_id and voided_at is null;

  perform realtime.send(
    jsonb_build_object('draw_id', p_draw_id),
    'draw:voided',
    'event:' || v_event_id,
    false
  );
end;
$$;

revoke execute on function public.void_draw(uuid) from public;
grant execute on function public.void_draw(uuid) to authenticated;

-- ============================================================
-- 重播中獎動畫（投影當機後補救）
-- ============================================================

create or replace function public.replay_draw(p_draw_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select d.id as draw_id, d.round_no, d.event_id,
         pz.id as prize_id, coalesce(pz.name, '中獎') as prize_name,
         pa.id as participant_id, pa.display_name, pa.character_name, pa.image_path,
         (e.host_id = auth.uid()) as is_host
    into v_row
    from public.draws d
    join public.participants pa on pa.id = d.participant_id
    join public.events e on e.id = d.event_id
    left join public.prizes pz on pz.id = d.prize_id
   where d.id = p_draw_id and d.voided_at is null;

  if v_row.draw_id is null then
    raise exception 'DRAW_NOT_FOUND';
  end if;
  if v_row.is_host is not true then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object(
      'draw_id', v_row.draw_id,
      'round_no', v_row.round_no,
      'prize_id', v_row.prize_id,
      'prize_name', v_row.prize_name,
      'participant_id', v_row.participant_id,
      'display_name', v_row.display_name,
      'character_name', v_row.character_name,
      'image_path', v_row.image_path
    ),
    'draw:reveal',
    'event:' || v_row.event_id,
    false
  );
end;
$$;

revoke execute on function public.replay_draw(uuid) from public;
grant execute on function public.replay_draw(uuid) to authenticated;

-- ============================================================
-- 為既有活動補上預設獎項
-- ============================================================

-- M7 之前建立的活動沒有任何獎項，補一個以維持可抽獎狀態
insert into public.prizes (event_id, name, quantity, sort_order)
select e.id, '中獎', greatest(e.draw_count, 1), 0
  from public.events e
 where not exists (select 1 from public.prizes p where p.event_id = e.id);


-- ############################################################
-- 來源：20260726210000_m7b_storage_limit
-- ############################################################

-- 放寬角色圖片的單檔大小上限
--
-- 原本 200KB 是以純線條畫估算的。含個人照片的角色即使壓過仍可能接近
-- 上限，只要超過就整個送不出去（現場會看到「object exceeded the
-- maximum allowed size」）。前端已改為逐步降品質，這裡再留一層餘裕。

update storage.buckets
   set file_size_limit = 512000
 where id = 'characters';


-- ############################################################
-- 來源：20260727090000_m8_assets
-- ############################################################

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


-- ############################################################
-- 來源：20260727120000_g0_game_rooms
-- ############################################################

-- G0：遊戲房間與隊伍
--
-- Party Game 模式的資料基礎。與抽獎共用同一個 events：
-- 一場活動可以先玩遊戲、再抽獎，用同一份參與者名單。
--
-- 設計要點：
-- 1. 遊戲進行中的即時狀態「不寫資料庫」。每秒 250 筆寫入會打爆連線池，
--    也沒有必要——即時狀態靠 Realtime 廣播，資料庫只在回合結束時
--    記錄結果。
-- 2. 隊伍有自己的加入碼，每桌一張 QR Code，玩家掃了就直接進該隊，
--    現場不必選、不會選錯。
-- 3. game_players 與 participants 是可選的關聯：玩家可以先玩遊戲、
--    還沒畫角色；畫過角色的人則會在船上看到自己的角色。
--
-- 此檔可重複執行。

-- ============================================================
-- 遊戲場次
-- ============================================================

create table if not exists public.game_sessions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  game_key    text not null,                    -- 對應程式碼中的遊戲模組
  name        text not null,
  config      jsonb not null default '{}'::jsonb,  -- 該遊戲的設定（時間、回合、BPM…）
  status      text not null default 'setup',    -- setup | lobby | countdown | playing | finished
  round_no    int  not null default 0,
  started_at  timestamptz,                      -- 本回合的開始時間，節拍由此推算
  created_at  timestamptz not null default now(),

  constraint game_sessions_status_valid
    check (status in ('setup', 'lobby', 'countdown', 'playing', 'finished')),
  constraint game_sessions_name_length
    check (char_length(btrim(name)) between 1 and 60)
);

create index if not exists game_sessions_event_idx
  on public.game_sessions (event_id, created_at desc);

-- ============================================================
-- 隊伍
-- ============================================================

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.game_sessions(id) on delete cascade,
  table_no    int  not null,                    -- 桌號，現場對照用
  name        text not null,
  join_code   text not null,                    -- 每桌一組，用於 QR Code
  color       text not null default '#4fc3d9',  -- 大螢幕上的隊伍識別色
  player_count int not null default 0,          -- 由觸發器維護
  created_at  timestamptz not null default now(),

  unique (session_id, table_no),
  unique (join_code),
  constraint teams_table_no_positive check (table_no between 1 and 200),
  constraint teams_name_length check (char_length(btrim(name)) between 1 and 40)
);

create index if not exists teams_session_idx
  on public.teams (session_id, table_no);

-- ============================================================
-- 玩家
-- ============================================================

create table if not exists public.game_players (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.game_sessions(id) on delete cascade,
  team_id        uuid not null references public.teams(id) on delete cascade,
  device_token   text not null,                 -- 與抽獎端共用同一組
  display_name   text not null,
  participant_id uuid references public.participants(id) on delete set null,
  joined_at      timestamptz not null default now(),

  unique (session_id, device_token),            -- 一台裝置一場遊戲只能一個位置
  constraint game_players_name_length
    check (char_length(btrim(display_name)) between 1 and 30)
);

create index if not exists game_players_team_idx
  on public.game_players (team_id);

-- ============================================================
-- 回合結果
-- ============================================================

create table if not exists public.team_results (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.game_sessions(id) on delete cascade,
  team_id       uuid not null references public.teams(id) on delete cascade,
  round_no      int  not null,
  rank          int,
  finish_ms     int,                            -- 完成時間，未完賽為 null
  sync_rate     numeric(5, 4),                  -- 平均同步率 0~1
  miss_count    int  not null default 0,
  metrics       jsonb not null default '{}'::jsonb,  -- 各遊戲自訂的額外數據
  recorded_at   timestamptz not null default now(),

  unique (session_id, team_id, round_no)
);

create index if not exists team_results_session_idx
  on public.team_results (session_id, round_no, rank);

-- ============================================================
-- 觸發器：維護隊伍人數
-- ============================================================

create or replace function public.sync_team_player_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.teams set player_count = player_count + 1 where id = new.team_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.teams set player_count = greatest(0, player_count - 1) where id = old.team_id;
    return old;
  elsif tg_op = 'UPDATE' and old.team_id is distinct from new.team_id then
    update public.teams set player_count = greatest(0, player_count - 1) where id = old.team_id;
    update public.teams set player_count = player_count + 1 where id = new.team_id;
    return new;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists game_players_sync_count on public.game_players;
create trigger game_players_sync_count
  after insert or update of team_id or delete on public.game_players
  for each row execute function public.sync_team_player_count();

-- ============================================================
-- RLS
-- ============================================================

alter table public.game_sessions enable row level security;
alter table public.teams         enable row level security;
alter table public.game_players  enable row level security;
alter table public.team_results  enable row level security;

drop policy if exists game_sessions_public_read on public.game_sessions;
drop policy if exists game_sessions_host_all    on public.game_sessions;
drop policy if exists teams_public_read         on public.teams;
drop policy if exists teams_host_all            on public.teams;
drop policy if exists game_players_host_all     on public.game_players;
drop policy if exists team_results_public_read  on public.team_results;

-- 場次與隊伍：匿名唯讀（大螢幕與手機都要顯示隊伍資訊）
create policy game_sessions_public_read on public.game_sessions
  for select to anon, authenticated using (true);

create policy game_sessions_host_all on public.game_sessions
  for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

create policy teams_public_read on public.teams
  for select to anon, authenticated using (true);

create policy teams_host_all on public.teams
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 玩家名單：匿名端完全不能直接讀寫。
-- 加入走 join_game() RPC（需要驗證加入碼），查詢走 list_team_players()。
-- 直接開放 select 會讓任何人拉走全場的 device_token 與姓名。
create policy game_players_host_all on public.game_players
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 成績：全端唯讀，手機也要看得到排行榜
create policy team_results_public_read on public.team_results
  for select to anon, authenticated using (true);

-- ============================================================
-- 建立遊戲場次（含隊伍）
-- ============================================================

create or replace function public.generate_team_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from public.teams t where t.join_code = v_code);

    v_attempt := v_attempt + 1;
    if v_attempt > 80 then
      raise exception 'CODE_GENERATION_FAILED';
    end if;
  end loop;

  return v_code;
end;
$$;

-- 一次建立場次與所有隊伍。分開建立會讓「建到一半失敗」留下半套資料，
-- 現場沒有時間排查這種狀態。
create or replace function public.create_game_session(
  p_event_id   uuid,
  p_game_key   text,
  p_name       text,
  p_team_count int,
  p_config     jsonb default '{}'::jsonb
)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_colors constant text[] := array[
    '#4fc3d9', '#f2963a', '#4caf6d', '#e8574c', '#8e5fd0',
    '#f4d03f', '#2f5fd0', '#f083b0', '#7ce0b8', '#ffb066'
  ];
  i int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  insert into public.game_sessions (event_id, game_key, name, config, status)
  values (p_event_id, p_game_key, btrim(p_name), coalesce(p_config, '{}'::jsonb), 'setup')
  returning * into v_session;

  for i in 1..greatest(1, least(coalesce(p_team_count, 1), 100)) loop
    insert into public.teams (session_id, table_no, name, join_code, color)
    values (
      v_session.id,
      i,
      '第 ' || i || ' 桌',
      public.generate_team_code(),
      v_colors[1 + ((i - 1) % array_length(v_colors, 1))]
    );
  end loop;

  return v_session;
end;
$$;

revoke execute on function public.create_game_session(uuid, text, text, int, jsonb) from public;
grant execute on function public.create_game_session(uuid, text, text, int, jsonb) to authenticated;

-- ============================================================
-- 玩家加入（匿名）
-- ============================================================

-- 以加入碼換取隊伍席位。碼即權限——掃到哪張 QR 就進哪一隊。
-- 同一台裝置重複加入會回傳既有席位而不是報錯：現場重整頁面很常見。
-- 先 drop 再建，理由同下方的 list_event_game_sessions。
drop function if exists public.join_game(text, text, text);

create or replace function public.join_game(
  p_join_code    text,
  p_device_token text,
  p_display_name text
)
returns table (
  session_id uuid,
  session_status text,
  game_key text,
  team_id uuid,
  team_name text,
  team_color text,
  table_no int,
  player_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team public.teams;
  v_session public.game_sessions;
  v_player public.game_players;
  v_participant_id uuid;
begin
  select * into v_team from public.teams t
   where t.join_code = upper(btrim(p_join_code));

  if v_team.id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_team.session_id;

  if v_session.status = 'finished' then
    raise exception 'SESSION_FINISHED';
  end if;

  -- 若這台裝置已經在這場活動畫過角色，遊戲中就用那個角色
  select p.id into v_participant_id
    from public.participants p
   where p.event_id = v_session.event_id
     and p.device_token = p_device_token
   limit 1;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;

  if v_player.id is null then
    insert into public.game_players
      (session_id, team_id, device_token, display_name, participant_id)
    values
      (v_session.id, v_team.id, p_device_token, btrim(p_display_name), v_participant_id)
    returning * into v_player;
  else
    -- 換桌：更新隊伍與姓名，觸發器會同步兩邊人數
    update public.game_players
       set team_id = v_team.id,
           display_name = btrim(p_display_name),
           participant_id = coalesce(v_participant_id, participant_id)
     where id = v_player.id
    returning * into v_player;
  end if;

  return query
    select v_session.id, v_session.status, v_session.game_key,
           v_team.id, v_team.name, v_team.color, v_team.table_no, v_player.id;
end;
$$;

revoke execute on function public.join_game(text, text, text) from public;
grant execute on function public.join_game(text, text, text) to anon, authenticated;

-- ============================================================
-- 查詢
-- ============================================================

-- 隊伍清單與人數，供大螢幕與主持人使用。不含 device_token。
drop function if exists public.list_session_teams(uuid);

create or replace function public.list_session_teams(p_session_id uuid)
returns table (
  id uuid,
  table_no int,
  name text,
  join_code text,
  color text,
  player_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.table_no, t.name, t.join_code, t.color, t.player_count
    from public.teams t
   where t.session_id = p_session_id
   order by t.table_no;
$$;

revoke execute on function public.list_session_teams(uuid) from public;
grant execute on function public.list_session_teams(uuid) to anon, authenticated;

-- 某一隊的成員，讓玩家在手機上看到隊友已就位
create or replace function public.list_team_players(p_team_id uuid)
returns table (id uuid, display_name text, participant_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gp.id, gp.display_name, gp.participant_id
    from public.game_players gp
   where gp.team_id = p_team_id
   order by gp.joined_at;
$$;

revoke execute on function public.list_team_players(uuid) from public;
grant execute on function public.list_team_players(uuid) to anon, authenticated;

-- 主持人的場次清單。
-- 先 drop 再建：後續 migration 若調整過回傳欄位，create or replace 會直接失敗
--（Postgres 不允許改變既有函式的回傳型別），整份腳本就重跑不了。
drop function if exists public.list_event_game_sessions(uuid);

create or replace function public.list_event_game_sessions(p_event_id uuid)
returns table (
  id uuid,
  game_key text,
  name text,
  status text,
  round_no int,
  config jsonb,
  team_count bigint,
  player_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id, s.game_key, s.name, s.status, s.round_no, s.config,
    (select count(*) from public.teams t where t.session_id = s.id),
    (select count(*) from public.game_players gp where gp.session_id = s.id),
    s.created_at
  from public.game_sessions s
  where s.event_id = p_event_id
    and exists (select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid())
  order by s.created_at desc;
$$;

revoke execute on function public.list_event_game_sessions(uuid) from public;
grant execute on function public.list_event_game_sessions(uuid) to authenticated;


-- ############################################################
-- 來源：20260728090000_g1_rhythm
-- ############################################################

-- G1：對時與回合節拍
--
-- 節奏遊戲的一切都建立在「每支手機都同意現在幾點」之上。
-- 手機的系統時間可能差好幾秒（沒對時、時區設錯、使用者自己改過），
-- 直接拿 Date.now() 判定節拍會讓整桌人明明划得很準卻全是 Miss。
--
-- 作法：
-- 1. server_now() 回傳伺服器的 epoch 毫秒，手機量測往返時間後推算時差。
-- 2. 回合的起始時間由 start_round() 在伺服器端寫入，
--    絕不能讓主持人的裝置決定——主持人的時鐘一樣不可信。
-- 3. started_at 刻意設在未來（前導時間），手機拿到後自己倒數，
--    不需要第二次寫入來把狀態從「倒數」翻成「進行中」。
--
-- 此檔可重複執行。

-- ============================================================
-- 伺服器時間
-- ============================================================

-- 用 clock_timestamp() 而非 now()：now() 是交易開始時間，
-- 在連線池排隊時會偏早，那正是我們要量測的誤差來源。
create or replace function public.server_now()
returns bigint
language sql
volatile
set search_path = public, pg_temp
as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

revoke execute on function public.server_now() from public;
grant execute on function public.server_now() to anon, authenticated;

-- ============================================================
-- 回合控制
-- ============================================================

-- 開始新回合。started_at 設在 p_lead_in_ms 之後，
-- 讓所有手機有時間收到、對時、把手擺好，並在畫面上一起倒數。
create or replace function public.start_round(
  p_session_id  uuid,
  p_lead_in_ms  int default 6000
)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_lead_in int := least(greatest(coalesce(p_lead_in_ms, 6000), 0), 60000);
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.game_sessions s
     set round_no   = s.round_no + 1,
         started_at = clock_timestamp() + make_interval(secs => v_lead_in / 1000.0),
         status     = 'playing'
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid()
     )
  returning * into v_session;

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object(
      'session_id', v_session.id,
      'round_no',   v_session.round_no,
      'game_key',   v_session.game_key,
      'started_at_ms', (extract(epoch from v_session.started_at) * 1000)::bigint,
      'config',     v_session.config
    ),
    'round:started',
    'game:' || v_session.id,
    false
  );

  return v_session;
end;
$$;

revoke execute on function public.start_round(uuid, int) from public;
grant execute on function public.start_round(uuid, int) to authenticated;

-- 收回本回合，回到大廳。主持人喊卡、或是要重跑一次時用。
create or replace function public.end_round(p_session_id uuid)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  update public.game_sessions s
     set started_at = null,
         status     = 'lobby'
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid()
     )
  returning * into v_session;

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object('session_id', v_session.id, 'round_no', v_session.round_no),
    'round:ended',
    'game:' || v_session.id,
    false
  );

  return v_session;
end;
$$;

revoke execute on function public.end_round(uuid) from public;
grant execute on function public.end_round(uuid) to authenticated;

-- ============================================================
-- 手機端的回合狀態
-- ============================================================

-- 手機在大廳輪詢這一支，知道「開始了沒、第幾回合、第 0 拍是什麼時候」。
-- 時間一律以 epoch 毫秒回傳，與 server_now() 同一個單位，
-- 手機那端不必再處理時區字串。
create or replace function public.get_play_state(p_session_id uuid)
returns table (
  status        text,
  round_no      int,
  game_key      text,
  started_at_ms bigint,
  config        jsonb,
  server_ms     bigint
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.status,
    s.round_no,
    s.game_key,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    s.config,
    (extract(epoch from clock_timestamp()) * 1000)::bigint
  from public.game_sessions s
  where s.id = p_session_id;
$$;

revoke execute on function public.get_play_state(uuid) from public;
grant execute on function public.get_play_state(uuid) to anon, authenticated;

-- ============================================================
-- 主持人場次清單：補上 started_at
-- ============================================================

-- 回傳型別變了，Postgres 不允許用 create or replace 改，必須先移除。
drop function if exists public.list_event_game_sessions(uuid);

create or replace function public.list_event_game_sessions(p_event_id uuid)
returns table (
  id uuid,
  game_key text,
  name text,
  status text,
  round_no int,
  config jsonb,
  started_at_ms bigint,
  team_count bigint,
  player_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id, s.game_key, s.name, s.status, s.round_no, s.config,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (select count(*) from public.teams t where t.session_id = s.id),
    (select count(*) from public.game_players gp where gp.session_id = s.id),
    s.created_at
  from public.game_sessions s
  where s.event_id = p_event_id
    and exists (select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid())
  order by s.created_at desc;
$$;

revoke execute on function public.list_event_game_sessions(uuid) from public;
grant execute on function public.list_event_game_sessions(uuid) to authenticated;


-- ############################################################
-- 來源：20260728150000_g1b_team_creatures
-- ############################################################

-- G1b：每一隊一種海洋生物
--
-- 大螢幕上有幾組就有幾隻海洋生物，各自從起點游向終點的貓。
-- 生物種類存在隊伍上，手機與大螢幕才會畫出同一隻。
--
-- 沿用抽獎端既有的 11 種範本（src/lib/creatures/ocean.ts），
-- 不另外定義一套：同一場活動裡，參與者畫過的生物與遊戲中的生物
-- 是同一個世界的東西。
--
-- 此檔可重複執行。

alter table public.teams
  add column if not exists creature_key text not null default 'fish';

-- ============================================================
-- 建立場次時分配生物與顏色
-- ============================================================

create or replace function public.create_game_session(
  p_event_id   uuid,
  p_game_key   text,
  p_name       text,
  p_team_count int,
  p_config     jsonb default '{}'::jsonb
)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_colors constant text[] := array[
    '#4fc3d9', '#f2963a', '#4caf6d', '#e8574c', '#8e5fd0',
    '#f4d03f', '#2f5fd0', '#f083b0', '#7ce0b8', '#ffb066'
  ];
  -- 順序刻意讓相鄰的兩桌長得很不一樣，大螢幕上才分得出誰是誰
  v_creatures constant text[] := array[
    'whale', 'crab', 'seahorse', 'shark', 'jellyfish',
    'turtle', 'pufferfish', 'octopus', 'starfish', 'fish'
  ];
  i int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  insert into public.game_sessions (event_id, game_key, name, config, status)
  values (p_event_id, p_game_key, btrim(p_name), coalesce(p_config, '{}'::jsonb), 'setup')
  returning * into v_session;

  for i in 1..greatest(1, least(coalesce(p_team_count, 1), 100)) loop
    insert into public.teams (session_id, table_no, name, join_code, color, creature_key)
    values (
      v_session.id,
      i,
      '第 ' || i || ' 桌',
      public.generate_team_code(),
      v_colors[1 + ((i - 1) % array_length(v_colors, 1))],
      v_creatures[1 + ((i - 1) % array_length(v_creatures, 1))]
    );
  end loop;

  return v_session;
end;
$$;

revoke execute on function public.create_game_session(uuid, text, text, int, jsonb) from public;
grant execute on function public.create_game_session(uuid, text, text, int, jsonb) to authenticated;

-- ============================================================
-- 查詢：補上 creature_key
-- ============================================================

-- 回傳型別變了，必須先移除才能重建
drop function if exists public.list_session_teams(uuid);

create or replace function public.list_session_teams(p_session_id uuid)
returns table (
  id uuid,
  table_no int,
  name text,
  join_code text,
  color text,
  creature_key text,
  player_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.table_no, t.name, t.join_code, t.color, t.creature_key, t.player_count
    from public.teams t
   where t.session_id = p_session_id
   order by t.table_no;
$$;

revoke execute on function public.list_session_teams(uuid) from public;
grant execute on function public.list_session_teams(uuid) to anon, authenticated;

-- ============================================================
-- 入座：回傳這一隊的生物
-- ============================================================

drop function if exists public.join_game(text, text, text);

create or replace function public.join_game(
  p_join_code    text,
  p_device_token text,
  p_display_name text
)
returns table (
  session_id uuid,
  session_status text,
  game_key text,
  team_id uuid,
  team_name text,
  team_color text,
  team_creature text,
  table_no int,
  player_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team public.teams;
  v_session public.game_sessions;
  v_player public.game_players;
  v_participant_id uuid;
begin
  select * into v_team from public.teams t
   where t.join_code = upper(btrim(p_join_code));

  if v_team.id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_team.session_id;

  if v_session.status = 'finished' then
    raise exception 'SESSION_FINISHED';
  end if;

  -- 若這台裝置已經在這場活動畫過角色，遊戲中就用那個角色
  select p.id into v_participant_id
    from public.participants p
   where p.event_id = v_session.event_id
     and p.device_token = p_device_token
   limit 1;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;

  if v_player.id is null then
    insert into public.game_players
      (session_id, team_id, device_token, display_name, participant_id)
    values
      (v_session.id, v_team.id, p_device_token, btrim(p_display_name), v_participant_id)
    returning * into v_player;
  else
    -- 換桌：更新隊伍與姓名，觸發器會同步兩邊人數
    update public.game_players
       set team_id = v_team.id,
           display_name = btrim(p_display_name),
           participant_id = coalesce(v_participant_id, participant_id)
     where id = v_player.id
    returning * into v_player;
  end if;

  return query
    select v_session.id, v_session.status, v_session.game_key,
           v_team.id, v_team.name, v_team.color, v_team.creature_key,
           v_team.table_no, v_player.id;
end;
$$;

revoke execute on function public.join_game(text, text, text) from public;
grant execute on function public.join_game(text, text, text) to anon, authenticated;


-- ============================================================
-- 重載 PostgREST 結構快取
-- ============================================================
-- 沒有這一步，新函式要等快取自然過期才會生效，
-- 前端在那之前一律收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證一：資料表
-- ============================================================
with expected(obj) as (
  values ('events'), ('participants'), ('draws'), ('prizes'),
         ('game_sessions'), ('teams'), ('game_players'), ('team_results')
)
select
  e.obj as 資料表,
  case when c.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_class c
       on c.relname = e.obj
      and c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
order by 狀態, e.obj;

-- ============================================================
-- 驗證二：函式（全部都必須是「已建立」）
-- ============================================================
with expected(fn) as (
  values
    -- 參與者與世界
    ('get_my_participant'), ('get_stage_participants'),
    ('sync_participant_count'), ('broadcast_participant_change'),
    -- 活動與主持人
    ('generate_event_code'), ('create_event'), ('claim_event'),
    ('list_my_events'), ('list_event_participants'), ('get_event_snapshot'),
    -- 抽獎
    ('list_event_prizes'), ('list_event_draws'),
    ('draw_winner'), ('void_draw'), ('replay_draw'),
    -- 遊戲
    ('generate_team_code'), ('create_game_session'), ('join_game'),
    ('list_session_teams'), ('list_team_players'),
    ('list_event_game_sessions'), ('sync_team_player_count'),
    -- 節拍與對時
    ('server_now'), ('start_round'), ('end_round'), ('get_play_state')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;

-- ============================================================
-- 驗證三：儲存空間
-- ============================================================
select
  id as bucket,
  case when public then '公開' else '私有' end as 存取,
  file_size_limit as 單檔上限
from storage.buckets
where id in ('characters', 'assets')
order by id;

-- ============================================================
-- 驗證四：後續新增的欄位
-- ============================================================
with expected(tbl, col) as (
  values ('teams', 'creature_key'), ('game_sessions', 'started_at')
)
select
  e.tbl || '.' || e.col as 欄位,
  case when c.column_name is null then '缺少' else '已建立' end as 狀態
from expected e
left join information_schema.columns c
       on c.table_schema = 'public'
      and c.table_name = e.tbl
      and c.column_name = e.col
order by 狀態, 欄位;

-- ============================================================
-- 驗證五：示範活動
-- ============================================================
select code as 活動代碼, name as 名稱, status as 狀態,
       participant_count as 參與人數
  from public.events
 where code = 'DEMO01';
