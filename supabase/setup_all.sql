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
drop function if exists public.list_team_players(uuid);

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


-- ############################################################
-- 來源：20260728180000_q0_quiz
-- ############################################################

-- Q0：海洋問答（Kahoot 形式）
--
-- 主持人出題，大螢幕顯示題目與四個選項，玩家在手機上按對應的海洋生物。
-- 可以個人計分，也可以按桌加總成分組競賽。
--
-- 三個不可退讓的設計：
--
-- 1. 正確答案在公布之前絕對不能送到手機。任何人打開開發者工具就看得到
--    網路回應，因此 quiz_questions 對匿名端完全關閉，一切走 RPC，
--    而給手機的 RPC 在公布前不回傳 correct_index。
--
-- 2. 作答時間由伺服器計算，手機不送時間戳。讓前端報時間等於把計分權
--    交給玩家——改一下系統時間就永遠滿分。
--
-- 3. 作答視窗以題目的 started_at 推算，與 phase 無關。主持人晚一點按
--    「公布答案」不該讓遲到的作答變成有效，phase 只管畫面顯示。
--
-- 此檔可重複執行。
--
-- 所有 returns table 的函式一律先 drop 再建：Postgres 不允許用
-- create or replace 改變回傳型別，只要後面的 migration 加了一個欄位，
-- 這一份第二次執行就會整個中斷。

-- ============================================================
-- 題目
-- ============================================================

create table if not exists public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.game_sessions(id) on delete cascade,
  ordinal        int  not null,                 -- 出題順序（position 是 Postgres 保留字，不能當欄位名用在 order by）
  prompt         text not null,
  options        text[] not null,               -- 固定四個，對應四種海洋生物
  correct_index  int  not null,                 -- 0~3
  prep_seconds   int  not null default 5,       -- 開始作答前的準備時間
  answer_seconds int  not null default 20,
  points         int  not null default 1000,    -- 秒答的滿分
  created_at     timestamptz not null default now(),

  unique (session_id, ordinal),
  constraint quiz_questions_options_count
    check (array_length(options, 1) = 4),
  constraint quiz_questions_correct_range
    check (correct_index between 0 and 3),
  constraint quiz_questions_prompt_length
    check (char_length(btrim(prompt)) between 1 and 300),
  constraint quiz_questions_prep_range
    check (prep_seconds between 0 and 60),
  constraint quiz_questions_answer_range
    check (answer_seconds between 5 and 180),
  constraint quiz_questions_points_range
    check (points between 100 and 10000)
);

create index if not exists quiz_questions_session_idx
  on public.quiz_questions (session_id, ordinal);

-- ============================================================
-- 作答
-- ============================================================

create table if not exists public.quiz_answers (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  player_id   uuid not null references public.game_players(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  choice_index int not null,
  elapsed_ms  int  not null,                    -- 從開放作答到按下去的毫秒
  is_correct  boolean not null,
  points      int  not null default 0,
  answered_at timestamptz not null default now(),

  -- 一題只能答一次，按下去就不能改
  unique (question_id, player_id),
  constraint quiz_answers_choice_range check (choice_index between 0 and 3)
);

create index if not exists quiz_answers_question_idx
  on public.quiz_answers (question_id);
create index if not exists quiz_answers_session_player_idx
  on public.quiz_answers (session_id, player_id);

-- ============================================================
-- 場次上的問答進度
-- ============================================================

alter table public.game_sessions
  add column if not exists current_question_id uuid
    references public.quiz_questions(id) on delete set null;

alter table public.game_sessions
  add column if not exists phase text not null default 'idle';

do $$
begin
  alter table public.game_sessions
    add constraint game_sessions_phase_valid
    check (phase in ('idle', 'prep', 'answer', 'reveal', 'scoreboard'));
exception when duplicate_object then null;
end $$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.quiz_questions enable row level security;
alter table public.quiz_answers   enable row level security;

drop policy if exists quiz_questions_host_all on public.quiz_questions;
drop policy if exists quiz_answers_host_read  on public.quiz_answers;

-- 題目只有主持人能碰。匿名端連 select 都不給——
-- 開放讀取就等於把正確答案公開，遊戲直接失去意義。
create policy quiz_questions_host_all on public.quiz_questions
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 作答紀錄同理：能讀就能反推別人選什麼
create policy quiz_answers_host_read on public.quiz_answers
  for select to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- ============================================================
-- 出題（主持人）
-- ============================================================

drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.quiz_questions;
  v_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_question_id is not null then
    update public.quiz_questions
       set prompt         = btrim(p_prompt),
           options        = p_options,
           correct_index  = p_correct_index,
           prep_seconds   = p_prep_seconds,
           answer_seconds = p_answer_seconds,
           points         = p_points
     where id = p_question_id and session_id = p_session_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'QUESTION_NOT_FOUND';
    end if;
    return v_row;
  end if;

  select coalesce(max(q.ordinal), 0) + 1 into v_ordinal
    from public.quiz_questions q where q.session_id = p_session_id;

  insert into public.quiz_questions
    (session_id, ordinal, prompt, options, correct_index,
     prep_seconds, answer_seconds, points)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) to authenticated;

-- 刪題之後把順序補回連續，否則之後新增的題目會插在奇怪的位置
create or replace function public.delete_quiz_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
begin
  select q.session_id into v_session_id
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.quiz_questions where id = p_question_id;

  with renumbered as (
    select id, row_number() over (order by ordinal) as rn
      from public.quiz_questions where session_id = v_session_id
  )
  update public.quiz_questions q
     set ordinal = r.rn
    from renumbered r
   where q.id = r.id and q.ordinal is distinct from r.rn;
end;
$$;

revoke execute on function public.delete_quiz_question(uuid) from public;
grant execute on function public.delete_quiz_question(uuid) to authenticated;

-- 上下移動一題
create or replace function public.move_quiz_question(
  p_question_id uuid,
  p_direction   int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_ordinal int;
  v_other_id uuid;
  v_other_ordinal int;
begin
  select q.session_id, q.ordinal into v_session_id, v_ordinal
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_direction < 0 then
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal < v_ordinal
     order by ordinal desc limit 1;
  else
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal > v_ordinal
     order by ordinal asc limit 1;
  end if;

  if v_other_id is null then
    return;  -- 已經在頭或尾，不是錯誤
  end if;

  -- 唯一索引擋著不能直接對調，先借一個不會撞到的暫時值
  update public.quiz_questions set ordinal = -1 where id = p_question_id;
  update public.quiz_questions set ordinal = v_ordinal where id = v_other_id;
  update public.quiz_questions set ordinal = v_other_ordinal where id = p_question_id;
end;
$$;

revoke execute on function public.move_quiz_question(uuid, int) from public;
grant execute on function public.move_quiz_question(uuid, int) to authenticated;

-- 主持人的題目清單（含正確答案）
drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.points,
    (select count(*) from public.quiz_answers a where a.question_id = q.id)
  from public.quiz_questions q
  where q.session_id = p_session_id
    and exists (
      select 1 from public.game_sessions s
        join public.events e on e.id = s.event_id
       where s.id = p_session_id and e.host_id = auth.uid())
  order by q.ordinal;
$$;

revoke execute on function public.list_quiz_questions(uuid) from public;
grant execute on function public.list_quiz_questions(uuid) to authenticated;

-- ============================================================
-- 出題進行（主持人）
-- ============================================================

-- 開始某一題。started_at 是這一題的時間原點：
-- 準備時間結束才開放作答，全部由 started_at 推算，
-- 因此一次寫入就涵蓋「準備」與「作答」兩個階段。
drop function if exists public.start_quiz_question(uuid, uuid);

create or replace function public.start_quiz_question(
  p_session_id  uuid,
  p_question_id uuid
)
returns table (started_at_ms bigint, server_ms bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_started timestamptz;
begin
  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if not exists (
    select 1 from public.quiz_questions q
     where q.id = p_question_id and q.session_id = p_session_id
  ) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  v_started := clock_timestamp();

  update public.game_sessions
     set current_question_id = p_question_id,
         phase = 'prep',
         started_at = v_started,
         status = 'playing'
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object(
      'session_id', p_session_id,
      'question_id', p_question_id,
      'started_at_ms', (extract(epoch from v_started) * 1000)::bigint
    ),
    'quiz:question', 'game:' || p_session_id, false);

  return query select
    (extract(epoch from v_started) * 1000)::bigint,
    (extract(epoch from clock_timestamp()) * 1000)::bigint;
end;
$$;

revoke execute on function public.start_quiz_question(uuid, uuid) from public;
grant execute on function public.start_quiz_question(uuid, uuid) to authenticated;

-- 切換顯示階段：公布答案、看排行榜、回到待機
create or replace function public.set_quiz_phase(
  p_session_id uuid,
  p_phase      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phase not in ('idle', 'prep', 'answer', 'reveal', 'scoreboard') then
    raise exception 'INVALID_PHASE';
  end if;

  update public.game_sessions s
     set phase = p_phase
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid());

  if not found then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', p_phase),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.set_quiz_phase(uuid, text) from public;
grant execute on function public.set_quiz_phase(uuid, text) to authenticated;

-- ============================================================
-- 作答（匿名）
-- ============================================================

-- 作答時間一律由伺服器算。前端只送「選了哪一個」，
-- 送出時間戳等於把計分權交給玩家。
drop function if exists public.submit_quiz_answer(uuid, text, int);

create or replace function public.submit_quiz_answer(
  p_question_id  uuid,
  p_device_token text,
  p_choice_index int
)
returns table (accepted boolean, elapsed_ms int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
  v_player public.game_players;
  v_open_at timestamptz;
  v_elapsed int;
  v_limit int;
  v_correct boolean;
  v_points int;
begin
  if p_choice_index is null or p_choice_index < 0 or p_choice_index > 3 then
    raise exception 'INVALID_CHOICE';
  end if;

  select * into v_q from public.quiz_questions q where q.id = p_question_id;
  if v_q.id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_q.session_id;

  -- 只有「正在進行的那一題」能作答，不能挑舊題目補答
  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  -- 給一點寬限，網路延遲不該讓壓線的作答被丟掉
  if v_elapsed > v_limit + 1500 then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  -- 答對的得分隨時間遞減：秒答滿分，壓線答對拿一半。
  -- 全有全無會讓慢答的人乾脆亂猜，遞減才會逼人快一點又不敢亂按。
  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  -- 按下去就不能改。on conflict do nothing 讓重送不會報錯，
  -- 現場網路不穩時手機重試很常見。
  insert into public.quiz_answers
    (session_id, question_id, player_id, team_id, choice_index,
     elapsed_ms, is_correct, points)
  values
    (v_session.id, p_question_id, v_player.id, v_player.team_id, p_choice_index,
     v_elapsed, v_correct, v_points)
  on conflict (question_id, player_id) do nothing;

  return query select true, v_elapsed;
end;
$$;

revoke execute on function public.submit_quiz_answer(uuid, text, int) from public;
grant execute on function public.submit_quiz_answer(uuid, text, int) to anon, authenticated;

-- ============================================================
-- 手機端狀態
-- ============================================================

-- 給手機的狀態。
--
-- 題目與選項文字手機上也要有：現場一定會有長輩、坐後排、
-- 或視力不好的人，只靠大螢幕等於把他們排除在遊戲外。
-- 選項文字本來就會出現在大螢幕上，送到手機不洩漏任何東西——
-- 真正不能提早送的只有 correct_index。
drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.phase,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then q.correct_index else null end,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then a.points else null end,
    (select coalesce(sum(t.points), 0)::int
       from public.quiz_answers t
      where t.session_id = s.id and t.player_id = gp.id)
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕狀態
-- ============================================================

-- 大螢幕要題目與選項文字，還要作答進度。
-- 正確答案同樣只在公布之後才回傳——大螢幕是匿名身分，
-- 提早送出去等於任何人都能先看到。
drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.phase,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    -- 題目在準備階段就要出現在大螢幕，那正是給大家讀題的時間
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when s.phase in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when s.phase in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 排行榜
-- ============================================================

drop function if exists public.quiz_individual_leaderboard(uuid, int);

create or replace function public.quiz_individual_leaderboard(
  p_session_id uuid,
  p_limit int default 10
)
returns table (
  player_id uuid,
  display_name text,
  team_name text,
  team_color text,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    gp.id, gp.display_name, t.name, t.color,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.game_players gp
  join public.teams t on t.id = gp.team_id
  left join public.quiz_answers a on a.player_id = gp.id
  where gp.session_id = p_session_id
  group by gp.id, gp.display_name, t.name, t.color
  order by 5 desc, 6 desc, gp.display_name
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

revoke execute on function public.quiz_individual_leaderboard(uuid, int) from public;
grant execute on function public.quiz_individual_leaderboard(uuid, int) to anon, authenticated;

drop function if exists public.quiz_team_leaderboard(uuid);

create or replace function public.quiz_team_leaderboard(p_session_id uuid)
returns table (
  team_id uuid,
  table_no int,
  name text,
  color text,
  creature_key text,
  player_count int,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.teams t
  left join public.quiz_answers a on a.team_id = t.id
  where t.session_id = p_session_id
  group by t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count
  order by 7 desc, 8 desc, t.table_no;
$$;

revoke execute on function public.quiz_team_leaderboard(uuid) from public;
grant execute on function public.quiz_team_leaderboard(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260728200000_q1_quiz_images
-- ############################################################

-- Q1：題目可以配圖
--
-- 圖片放在既有的 assets 儲存桶（M8 建立，公開讀取、只有主持人能寫）。
-- 資料庫只存公開網址，不存圖片本身——與角色圖同一個原則。
--
-- 回傳欄位變了的函式一律先 drop 再建：
-- Postgres 不允許用 create or replace 改變回傳型別。
--
-- 此檔可重複執行。

alter table public.quiz_questions
  add column if not exists image_url text;

-- ============================================================
-- 出題
-- ============================================================

-- 舊簽章少一個參數，留著會變成多載，PostgREST 會不知道要呼叫哪一個
drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000,
  p_image_url      text default null
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.quiz_questions;
  v_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_question_id is not null then
    update public.quiz_questions
       set prompt         = btrim(p_prompt),
           options        = p_options,
           correct_index  = p_correct_index,
           prep_seconds   = p_prep_seconds,
           answer_seconds = p_answer_seconds,
           points         = p_points,
           image_url      = nullif(btrim(coalesce(p_image_url, '')), '')
     where id = p_question_id and session_id = p_session_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'QUESTION_NOT_FOUND';
    end if;
    return v_row;
  end if;

  select coalesce(max(q.ordinal), 0) + 1 into v_ordinal
    from public.quiz_questions q where q.session_id = p_session_id;

  insert into public.quiz_questions
    (session_id, ordinal, prompt, options, correct_index,
     prep_seconds, answer_seconds, points, image_url)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points,
     nullif(btrim(coalesce(p_image_url, '')), ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) to authenticated;

-- ============================================================
-- 查詢：補上 image_url
-- ============================================================

drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  image_url text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.image_url, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.points,
    (select count(*) from public.quiz_answers a where a.question_id = q.id)
  from public.quiz_questions q
  where q.session_id = p_session_id
    and exists (
      select 1 from public.game_sessions s
        join public.events e on e.id = s.event_id
       where s.id = p_session_id and e.host_id = auth.uid())
  order by q.ordinal;
$$;

revoke execute on function public.list_quiz_questions(uuid) from public;
grant execute on function public.list_quiz_questions(uuid) to authenticated;

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.phase,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.image_url end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then q.correct_index else null end,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then a.points else null end,
    (select coalesce(sum(t.points), 0)::int
       from public.quiz_answers t
      where t.session_id = s.id and t.player_id = gp.id)
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    s.phase,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.image_url end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when s.phase in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when s.phase in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260728220000_q2_auto_phase
-- ############################################################

-- Q2：階段自動推進
--
-- 原本主持人要按三次：開始 → 公布答案 → 看排行榜。
-- 現場主持人一手拿麥克風、一手拿手機、面對兩百個人，
-- 記得按第二第三下這件事本身就是設計缺陷。
--
-- 改成：主持人只按「下一題」，之後全部由時間推進：
--   讀題倒數 → 作答 → 自動公布正確答案 → 自動顯示各組分數
--
-- 關鍵設計：階段不再是資料庫裡的一個狀態，而是從 started_at「算」出來的。
-- 這樣手機、大螢幕、主持人後台三邊永遠一致，中間也不需要任何人
-- 在正確的時間點寫入資料庫——那個寫入一旦漏掉（分頁被切到背景、
-- 網路斷一下），全場就卡在作答畫面出不來。
--
-- 儲存的 phase 只剩一個用途：主持人強制回到待機畫面。
--
-- 此檔可重複執行。

-- 公布正確答案要停留多久才跳到分數
alter table public.quiz_questions
  add column if not exists reveal_seconds int not null default 6;

do $$
begin
  alter table public.quiz_questions
    add constraint quiz_questions_reveal_range
    check (reveal_seconds between 2 and 60);
exception when duplicate_object then null;
end $$;

-- ============================================================
-- 由時間推算階段
-- ============================================================

-- 作答截止之後的寬限期。
--
-- 存在的理由：有人在最後一刻按下去，但封包晚了兩百毫秒才到伺服器，
-- 那一下不該被丟掉。
--
-- 但寬限期一定要落在「公布答案」之前——否則大螢幕已經把正解打出來，
-- 卻還收得到作答，那就不是寬容而是漏洞。所以判定與畫面共用這一個值。
create or replace function public.quiz_answer_grace_ms()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 1500 $$;

revoke execute on function public.quiz_answer_grace_ms() from public;
grant execute on function public.quiz_answer_grace_ms() to anon, authenticated;

create or replace function public.quiz_phase_at(
  p_stored     text,
  p_elapsed_ms bigint,
  p_prep       int,
  p_answer     int,
  p_reveal     int
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- 主持人按了「回到待機」，或根本還沒出過題
    when p_stored = 'idle' or p_elapsed_ms is null then 'idle'
    when p_elapsed_ms < p_prep * 1000 then 'prep'
    -- 寬限期內畫面仍停在作答，正解要等它過去才准出現
    when p_elapsed_ms < (p_prep + p_answer) * 1000 + public.quiz_answer_grace_ms()
      then 'answer'
    when p_elapsed_ms
       < (p_prep + p_answer + p_reveal) * 1000 + public.quiz_answer_grace_ms()
      then 'reveal'
    else 'scoreboard'
  end;
$$;

revoke execute on function public.quiz_phase_at(text, bigint, int, int, int) from public;
grant execute on function public.quiz_phase_at(text, bigint, int, int, int) to anon, authenticated;

-- ============================================================
-- 作答檢查改用共用的寬限期
-- ============================================================

drop function if exists public.submit_quiz_answer(uuid, text, int);

create or replace function public.submit_quiz_answer(
  p_question_id  uuid,
  p_device_token text,
  p_choice_index int
)
returns table (accepted boolean, elapsed_ms int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
  v_player public.game_players;
  v_open_at timestamptz;
  v_elapsed int;
  v_limit int;
  v_correct boolean;
  v_points int;
begin
  if p_choice_index is null or p_choice_index < 0 or p_choice_index > 3 then
    raise exception 'INVALID_CHOICE';
  end if;

  select * into v_q from public.quiz_questions q where q.id = p_question_id;
  if v_q.id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_q.session_id;

  -- 只有「正在進行的那一題」能作答，不能挑舊題目補答
  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  -- 主持人按了回到待機就不再收
  if v_session.phase = 'idle' then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  -- 與 quiz_phase_at 共用同一個寬限期，畫面與判定才不會各說各話：
  -- 大螢幕跳出正解的那一刻，就是這裡開始拒收的那一刻
  if v_elapsed > v_limit + public.quiz_answer_grace_ms() then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  -- 答對的得分隨時間遞減：秒答滿分，壓線答對拿一半
  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  insert into public.quiz_answers
    (session_id, question_id, player_id, team_id, choice_index,
     elapsed_ms, is_correct, points)
  values
    (v_session.id, p_question_id, v_player.id, v_player.team_id, p_choice_index,
     v_elapsed, v_correct, v_points)
  on conflict (question_id, player_id) do nothing;

  return query select true, v_elapsed;
end;
$$;

revoke execute on function public.submit_quiz_answer(uuid, text, int) from public;
grant execute on function public.submit_quiz_answer(uuid, text, int) to anon, authenticated;

-- ============================================================
-- 提前結束作答
-- ============================================================

-- 主持人想早點收的時候用。作法是把 started_at 往前挪，
-- 讓「已經過了作答時間」這件事對所有人同時成立——
-- 包含 submit_quiz_answer 的時間檢查，所以早收之後就再也送不進來。
-- 若改成寫一個 phase 旗標，作答檢查與畫面顯示會用兩套規則，
-- 那正是「畫面說結束了但還收得到答案」的來源。
create or replace function public.end_answer_early(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
begin
  select * into v_session from public.game_sessions s
   where s.id = p_session_id
     and exists (select 1 from public.events e
                  where e.id = s.event_id and e.host_id = auth.uid());

  if v_session.id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  select * into v_q from public.quiz_questions q
   where q.id = v_session.current_question_id;

  if v_q.id is null or v_session.started_at is null then
    return;
  end if;

  update public.game_sessions
     set started_at = clock_timestamp()
                    - make_interval(secs => v_q.prep_seconds + v_q.answer_seconds)
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', 'reveal'),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.end_answer_early(uuid) from public;
grant execute on function public.end_answer_early(uuid) to authenticated;

-- ============================================================
-- 出題：補上 reveal_seconds
-- ============================================================

drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000,
  p_image_url      text default null,
  p_reveal_seconds int default 6
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.quiz_questions;
  v_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_question_id is not null then
    update public.quiz_questions
       set prompt         = btrim(p_prompt),
           options        = p_options,
           correct_index  = p_correct_index,
           prep_seconds   = p_prep_seconds,
           answer_seconds = p_answer_seconds,
           reveal_seconds = p_reveal_seconds,
           points         = p_points,
           image_url      = nullif(btrim(coalesce(p_image_url, '')), '')
     where id = p_question_id and session_id = p_session_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'QUESTION_NOT_FOUND';
    end if;
    return v_row;
  end if;

  select coalesce(max(q.ordinal), 0) + 1 into v_ordinal
    from public.quiz_questions q where q.session_id = p_session_id;

  insert into public.quiz_questions
    (session_id, ordinal, prompt, options, correct_index,
     prep_seconds, answer_seconds, reveal_seconds, points, image_url)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_reveal_seconds, p_points,
     nullif(btrim(coalesce(p_image_url, '')), ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text, int) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text, int) to authenticated;

drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  image_url text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  reveal_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.image_url, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.reveal_seconds, q.points,
    (select count(*) from public.quiz_answers a where a.question_id = q.id)
  from public.quiz_questions q
  where q.session_id = p_session_id
    and exists (
      select 1 from public.game_sessions s
        join public.events e on e.id = s.event_id
       where s.id = p_session_id and e.host_id = auth.uid())
  order by q.ordinal;
$$;

revoke execute on function public.list_quiz_questions(uuid) from public;
grant execute on function public.list_quiz_questions(uuid) to authenticated;

-- ============================================================
-- 手機端狀態：階段由時間算
-- ============================================================

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when p.effective in ('reveal', 'scoreboard')
         then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard')
         then a.points else null end,
    (select coalesce(sum(t.points), 0)::int
       from public.quiz_answers t
      where t.session_id = s.id and t.player_id = gp.id)
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕狀態：階段由時間算
-- ============================================================

drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when p.effective in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when p.effective in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 開始一題時把強制待機解除
-- ============================================================

drop function if exists public.start_quiz_question(uuid, uuid);

create or replace function public.start_quiz_question(
  p_session_id  uuid,
  p_question_id uuid
)
returns table (started_at_ms bigint, server_ms bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_started timestamptz;
begin
  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if not exists (
    select 1 from public.quiz_questions q
     where q.id = p_question_id and q.session_id = p_session_id
  ) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  v_started := clock_timestamp();

  -- phase 寫成 'auto' 代表「照時間走」，只有 'idle' 會強制回待機
  update public.game_sessions
     set current_question_id = p_question_id,
         phase = 'auto',
         started_at = v_started,
         status = 'playing'
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object(
      'session_id', p_session_id,
      'question_id', p_question_id,
      'started_at_ms', (extract(epoch from v_started) * 1000)::bigint
    ),
    'quiz:question', 'game:' || p_session_id, false);

  return query select
    (extract(epoch from v_started) * 1000)::bigint,
    (extract(epoch from clock_timestamp()) * 1000)::bigint;
end;
$$;

revoke execute on function public.start_quiz_question(uuid, uuid) from public;
grant execute on function public.start_quiz_question(uuid, uuid) to authenticated;

-- 'auto' 是新的合法值，舊的檢查約束會擋下來
alter table public.game_sessions drop constraint if exists game_sessions_phase_valid;
alter table public.game_sessions
  add constraint game_sessions_phase_valid
  check (phase in ('idle', 'auto', 'prep', 'answer', 'reveal', 'scoreboard'));


-- ############################################################
-- 來源：20260729090000_q3_captain_mode
-- ############################################################

-- Q3：隊長代表賽
--
-- 第三種計分方式：每桌推派一位隊長，只有隊長的手機能按，
-- 隊長的分數就是全桌的分數。
--
-- 三種模式的差別只在「誰能按」與「分數怎麼加總」，題目、計時、
-- 公布流程完全共用：
--   individual 每個人自己按，看個人排行
--   team       每個人自己按，同桌加總
--   captain    只有隊長能按，隊長的分數就是該桌的分數
--
-- 隊長採先搶先贏：現場沒有人有空等主持人一桌一桌指定，
-- 而「誰先按誰就是」本身就是很自然的推派方式。主持人仍然可以改。
--
-- 此檔可重複執行。

alter table public.game_players
  add column if not exists is_captain boolean not null default false;

-- 一桌只能有一位隊長。用部分唯一索引而不是檢查約束：
-- 這是跨列的限制，只有索引擋得住兩支手機同時搶的競態。
create unique index if not exists game_players_one_captain_per_team
  on public.game_players (team_id)
  where is_captain;

-- ============================================================
-- 搶隊長（匿名）
-- ============================================================

-- 回傳這一桌目前的隊長是誰。搶輸了不算錯誤——
-- 現場兩個人同時按是常態，跳錯誤訊息只會讓人以為壞掉。
create or replace function public.claim_captain(
  p_session_id   uuid,
  p_device_token text
)
returns table (captain_player_id uuid, captain_name text, i_am_captain boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_existing public.game_players;
begin
  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;

  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select * into v_existing from public.game_players gp
   where gp.team_id = v_player.team_id and gp.is_captain;

  if v_existing.id is null then
    begin
      update public.game_players set is_captain = true where id = v_player.id;
      v_existing := v_player;
    exception when unique_violation then
      -- 同一瞬間有人搶贏了，重讀一次即可
      select * into v_existing from public.game_players gp
       where gp.team_id = v_player.team_id and gp.is_captain;
    end;
  end if;

  return query select
    v_existing.id,
    v_existing.display_name,
    v_existing.id = v_player.id;
end;
$$;

revoke execute on function public.claim_captain(uuid, text) from public;
grant execute on function public.claim_captain(uuid, text) to anon, authenticated;

-- 主持人改派隊長。現場常見的狀況是隊長手機沒電或臨時離席。
create or replace function public.set_team_captain(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
begin
  select gp.team_id into v_team_id
    from public.game_players gp
    join public.game_sessions s on s.id = gp.session_id
    join public.events e on e.id = s.event_id
   where gp.id = p_player_id and e.host_id = auth.uid();

  if v_team_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 先卸任再上任，否則會撞到「一桌一位」的唯一索引
  update public.game_players set is_captain = false
   where team_id = v_team_id and is_captain;
  update public.game_players set is_captain = true where id = p_player_id;
end;
$$;

revoke execute on function public.set_team_captain(uuid) from public;
grant execute on function public.set_team_captain(uuid) to authenticated;

-- ============================================================
-- 換桌時卸任
-- ============================================================

-- 隊長換到別桌時要先卸任，否則新桌若已有隊長會撞到唯一索引，
-- 整個 join_game 會失敗——現場表現為「掃了碼卻進不去」。
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
  v_keep_captain boolean;
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
    -- 先算好再寫。不能在 set 裡直接寫 team_id：這支函式的回傳欄位
    -- 也叫 team_id，PL/pgSQL 分不出你指的是欄位還是回傳變數，
    -- 會直接報 ambiguous 而讓整個入座失敗——現場表現為「掃了碼卻進不去」。
    v_keep_captain := v_player.team_id = v_team.id and v_player.is_captain;

    update public.game_players
       set team_id = v_team.id,
           display_name = btrim(p_display_name),
           participant_id = coalesce(v_participant_id, participant_id),
           is_captain = v_keep_captain
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
-- 隊員清單補上隊長標記
-- ============================================================

drop function if exists public.list_team_players(uuid);

create or replace function public.list_team_players(p_team_id uuid)
returns table (
  id uuid,
  display_name text,
  participant_id uuid,
  is_captain boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gp.id, gp.display_name, gp.participant_id, gp.is_captain
    from public.game_players gp
   where gp.team_id = p_team_id
   order by gp.is_captain desc, gp.joined_at;
$$;

revoke execute on function public.list_team_players(uuid) from public;
grant execute on function public.list_team_players(uuid) to anon, authenticated;

-- ============================================================
-- 作答資格
-- ============================================================

drop function if exists public.submit_quiz_answer(uuid, text, int);

create or replace function public.submit_quiz_answer(
  p_question_id  uuid,
  p_device_token text,
  p_choice_index int
)
returns table (accepted boolean, elapsed_ms int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
  v_player public.game_players;
  v_open_at timestamptz;
  v_elapsed int;
  v_limit int;
  v_correct boolean;
  v_points int;
begin
  if p_choice_index is null or p_choice_index < 0 or p_choice_index > 3 then
    raise exception 'INVALID_CHOICE';
  end if;

  select * into v_q from public.quiz_questions q where q.id = p_question_id;
  if v_q.id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_q.session_id;

  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  if v_session.phase = 'idle' then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  -- 隊長代表賽：資格檢查一定要在伺服器端。前端把按鈕藏起來只是介面，
  -- 任何人都能直接呼叫這支函式。
  if coalesce(v_session.config->>'mode', 'team') = 'captain'
     and not v_player.is_captain then
    raise exception 'NOT_CAPTAIN';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  if v_elapsed > v_limit + public.quiz_answer_grace_ms() then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  insert into public.quiz_answers
    (session_id, question_id, player_id, team_id, choice_index,
     elapsed_ms, is_correct, points)
  values
    (v_session.id, p_question_id, v_player.id, v_player.team_id, p_choice_index,
     v_elapsed, v_correct, v_points)
  on conflict (question_id, player_id) do nothing;

  return query select true, v_elapsed;
end;
$$;

revoke execute on function public.submit_quiz_answer(uuid, text, int) from public;
grant execute on function public.submit_quiz_answer(uuid, text, int) to anon, authenticated;

-- ============================================================
-- 手機端狀態：補上模式與隊長資訊
-- ============================================================

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  mode           text,
  i_am_captain   boolean,
  captain_name   text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    coalesce(s.config->>'mode', 'team'),
    coalesce(gp.is_captain, false),
    (select c.display_name from public.game_players c
      where c.team_id = gp.team_id and c.is_captain limit 1),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when p.effective in ('reveal', 'scoreboard')
         then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard')
         then a.points else null end,
    -- 隊長代表賽時，手機上顯示的是全桌的分數，因為那才是「我們的」成績
    case when coalesce(s.config->>'mode', 'team') = 'captain'
         then (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t where t.team_id = gp.team_id)
         else (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t
                where t.session_id = s.id and t.player_id = gp.id)
    end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕：作答進度要按模式計算分母
-- ============================================================

drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    s.name,
    m.mode,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    -- 分母是「有資格作答的人數」：隊長代表賽時是有隊長的桌數，
    -- 否則是入座人數。用錯分母會讓大螢幕永遠顯示不到滿
    case when m.mode = 'captain'
         then (select count(*)::int from public.game_players gp
                where gp.session_id = s.id and gp.is_captain)
         else (select count(*)::int from public.game_players gp
                where gp.session_id = s.id)
    end,
    case when p.effective in ('reveal', 'scoreboard') then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  cross join lateral (select coalesce(s.config->>'mode', 'team') as mode) m
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260729180000_c0_checkin
-- ############################################################

-- C0：電子簽到
--
-- 報到台的流程：掃 QR Code → 確認自己的資料 → 簽名 → 簽名流進大螢幕的河道。
--
-- 設計決策：
--
-- 1. 簽名不另開一套資料表。一個簽名就是一張透明背景的圖，
--    跟手繪角色走同一條路：Storage 存圖、participants 存路徑、
--    大螢幕用同一個 WorldRenderer 顯示。多開一張表只會讓抽獎、
--    人數統計、Realtime 廣播全部都要寫第二遍。
--
-- 2. 「確認資料」需要一份名冊，但名冊是選配的。
--    有匯入名冊時，打姓名可以帶出服務單位與桌次讓本人確認；
--    沒有名冊時，本人自己填，流程完全一樣。
--    現場報到不能因為名冊沒匯入就卡住。
--
-- 3. event_roster 對 anon 完全關閉 select。
--    那是一份完整的與會者名單，開放查詢等同把整份名冊送出去。
--    手機端查名字一律走 lookup_roster()，而且只接受「完整姓名相符」，
--    不能用一個字去撈出所有姓王的人。
--
-- 4. 兩支新函式都回傳 jsonb 而不是 returns table。
--    returns table 的回傳欄位一旦要調整，create or replace 會直接報
--    「cannot change return type of existing function」，必須先 drop；
--    而且 OUT 欄位名稱會和同名的資料表欄位在 PL/pgSQL 裡打架
--    （join_game 的 team_id 就是這樣壞掉的）。jsonb 兩個問題都沒有。

-- ============================================================
-- 欄位
-- ============================================================

-- 報到模式：畫角色（原本的玩法）或電子簽名
alter table public.events
  add column if not exists join_mode text not null default 'draw';

alter table public.events
  drop constraint if exists events_join_mode_valid;

alter table public.events
  add constraint events_join_mode_valid check (join_mode in ('draw', 'signature'));

-- 簽到時確認的資料。兩個都可以是 null：沒有名冊、本人也不想填時照樣簽得了名
alter table public.participants
  add column if not exists organization text;

alter table public.participants
  add column if not exists seat_no text;

alter table public.participants
  drop constraint if exists participants_organization_length;

alter table public.participants
  add constraint participants_organization_length
  check (organization is null or char_length(organization) between 1 and 60);

alter table public.participants
  drop constraint if exists participants_seat_no_length;

alter table public.participants
  add constraint participants_seat_no_length
  check (seat_no is null or char_length(seat_no) between 1 and 20);

-- ============================================================
-- 名冊
-- ============================================================

create table if not exists public.event_roster (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events(id) on delete cascade,
  display_name   text not null,
  organization   text,                              -- 服務單位
  title          text,                              -- 職稱
  seat_no        text,                              -- 桌次
  note           text,
  -- 簽到之後回填，主持人才看得出誰還沒到
  participant_id uuid references public.participants(id) on delete set null,
  checked_in_at  timestamptz,
  created_at     timestamptz not null default now(),

  constraint event_roster_name_length check (char_length(display_name) between 1 and 30),
  constraint event_roster_organization_length check (organization is null or char_length(organization) between 1 and 60),
  constraint event_roster_title_length check (title is null or char_length(title) between 1 and 40),
  constraint event_roster_seat_no_length check (seat_no is null or char_length(seat_no) between 1 and 20)
);

-- 查名字要快：報到台是尖峰，兩百人在十分鐘內全部湧進來
create index if not exists event_roster_event_name_idx
  on public.event_roster (event_id, display_name);

-- ============================================================
-- RLS
-- ============================================================

alter table public.event_roster enable row level security;

-- 名冊是主持人自己的資料，四種操作都給，前端直接用資料表操作即可，
-- 不必為了匯入名冊再多一支函式（多一支函式就多一次結構快取的風險）
drop policy if exists event_roster_host_select on public.event_roster;
create policy event_roster_host_select on public.event_roster
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

drop policy if exists event_roster_host_insert on public.event_roster;
create policy event_roster_host_insert on public.event_roster
  for insert to authenticated
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

drop policy if exists event_roster_host_update on public.event_roster;
create policy event_roster_host_update on public.event_roster
  for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

drop policy if exists event_roster_host_delete on public.event_roster;
create policy event_roster_host_delete on public.event_roster
  for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

-- ============================================================
-- 查名冊（手機端）
-- ============================================================

-- 姓名正規化：去掉所有空白再轉小寫。
-- 「王 小明」與「王小明」是同一個人，名冊怎麼打的不該讓本人報到失敗。
create or replace function public.normalize_person_name(p_name text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(coalesce(p_name, ''), '\s', '', 'g'))
$$;

/**
 * 以完整姓名查名冊。
 *
 * 刻意只做「完整相符」而不是模糊比對：event_roster 對 anon 是關閉的，
 * 這支函式是唯一的出口，允許前綴查詢等於開放整份名單被一個字一個字撈走。
 * 同名同姓時會回傳多筆，讓本人自己認服務單位。
 */
create or replace function public.lookup_roster(
  p_event_id uuid,
  p_name text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_result jsonb;
begin
  v_key := public.normalize_person_name(p_name);

  -- 一個字查不出東西：太短的字串會撈出過多同名，也是列舉的入口
  if char_length(v_key) < 2 then
    return '[]'::jsonb;
  end if;

  -- 只有開放報名中的簽到場次可查
  if not exists (
    select 1 from public.events e
     where e.id = p_event_id
       and e.status = 'open'
       and e.join_mode = 'signature'
  ) then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
    into v_result
    from (
      select r.id,
             r.display_name,
             r.organization,
             r.title,
             r.seat_no,
             (r.checked_in_at is not null) as checked_in
        from public.event_roster r
       where r.event_id = p_event_id
         and public.normalize_person_name(r.display_name) = v_key
       order by r.organization nulls last, r.created_at
       limit 8
    ) t;

  return v_result;
end;
$$;

-- ============================================================
-- 簽到（手機端）
-- ============================================================

/**
 * 完成簽到：登記一位參與者，並把名冊上對應的那一列標記為已報到。
 *
 * 為什麼要用函式而不是照原本的 RLS insert：
 * 名冊回填與參與者寫入必須是同一筆交易，否則會出現
 * 「人已經簽到了但名冊顯示未到」，報到台就得靠人工核對。
 *
 * 冪等：同一台裝置重送（送出後斷線、按了兩下）只會有一位參與者。
 * 圖先上 Storage、資料列後寫入，跟手繪角色同一個順序，
 * 大螢幕不會收到沒有圖的角色。
 */
create or replace function public.check_in_signature(
  p_event_id uuid,
  p_participant_id uuid,
  p_display_name text,
  p_organization text,
  p_seat_no text,
  p_image_path text,
  p_device_token text,
  p_roster_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
  v_existing public.participants%rowtype;
  v_name text;
  v_org text;
  v_seat text;
begin
  select * into v_event from public.events e where e.id = p_event_id;

  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if v_event.status <> 'open' then
    raise exception 'EVENT_NOT_OPEN';
  end if;

  -- 圖片必須落在這場活動的資料夾底下，跟 RLS insert 政策同一條規則
  if p_image_path is null or p_image_path not like (p_event_id::text || '/%') then
    raise exception 'BAD_IMAGE_PATH';
  end if;

  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'BAD_NAME';
  end if;

  v_org := nullif(btrim(coalesce(p_organization, '')), '');
  v_seat := nullif(btrim(coalesce(p_seat_no, '')), '');

  -- 這台裝置簽過了就直接回傳原本那一筆，不再新增
  select * into v_existing
    from public.participants p
   where p.event_id = p_event_id
     and p.device_token = p_device_token;

  if found then
    return jsonb_build_object(
      'participant_id', v_existing.id,
      'image_path', v_existing.image_path,
      'already_joined', true
    );
  end if;

  begin
    insert into public.participants (
      id, event_id, display_name, character_name,
      image_path, device_token, organization, seat_no
    )
    values (
      coalesce(p_participant_id, gen_random_uuid()), p_event_id, v_name, null,
      p_image_path, p_device_token, v_org, v_seat
    )
    returning * into v_existing;
  exception
    when unique_violation then
      -- 兩次送出擠在一起：後到的那一次改讀先寫進去的那一列
      select * into v_existing
        from public.participants p
       where p.event_id = p_event_id
         and p.device_token = p_device_token;

      if not found then
        raise;
      end if;

      return jsonb_build_object(
        'participant_id', v_existing.id,
        'image_path', v_existing.image_path,
        'already_joined', true
      );
  end;

  -- 回填名冊。已經被別人認領的那一列不動：
  -- 現場多半是同名同姓認錯列，擋下報到比記錯一列嚴重得多
  if p_roster_id is not null then
    update public.event_roster r
       set participant_id = v_existing.id,
           checked_in_at = now()
     where r.id = p_roster_id
       and r.event_id = p_event_id
       and r.participant_id is null;
  end if;

  return jsonb_build_object(
    'participant_id', v_existing.id,
    'image_path', v_existing.image_path,
    'already_joined', false
  );
end;
$$;

-- ============================================================
-- 權限
-- ============================================================

grant execute on function public.normalize_person_name(text) to anon, authenticated;
grant execute on function public.lookup_roster(uuid, text) to anon, authenticated;
grant execute on function public.check_in_signature(uuid, uuid, text, text, text, text, text, uuid) to anon, authenticated;

grant select, insert, update, delete on public.event_roster to authenticated;


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
         ('game_sessions'), ('teams'), ('game_players'), ('team_results'),
         ('event_roster')
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
    ('server_now'), ('start_round'), ('end_round'), ('get_play_state'),
    -- 問答
    ('upsert_quiz_question'), ('delete_quiz_question'), ('move_quiz_question'),
    ('list_quiz_questions'), ('start_quiz_question'), ('set_quiz_phase'),
    ('submit_quiz_answer'), ('get_quiz_play_state'), ('get_quiz_stage_state'),
    ('quiz_individual_leaderboard'), ('quiz_team_leaderboard'),
    ('claim_captain'), ('set_team_captain'),
    -- 簽到
    ('normalize_person_name'), ('lookup_roster'), ('check_in_signature')
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
  values ('teams', 'creature_key'), ('game_sessions', 'started_at'),
         ('game_sessions', 'current_question_id'), ('game_sessions', 'phase'),
         ('events', 'join_mode'), ('participants', 'organization'),
         ('participants', 'seat_no')
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
