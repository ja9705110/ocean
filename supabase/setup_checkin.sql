-- ============================================================
-- 電子簽到：只安裝簽到需要的部分
-- ============================================================
--
-- 什麼時候用這一份：資料庫已經跑過 setup_all.sql，只是要補上簽到。
--
-- 前提：只需要 events 與 participants 兩張表，任何跑過 setup_all.sql 的
-- 資料庫都已經有了。這一份不依賴遊戲或問答的任何欄位。
--
-- 使用方式：
--   1. Supabase → SQL Editor → 開新查詢
--   2. 整份貼上，按 Ctrl/Cmd + A 全選
--   3. 按 Run
--   4. 看最下方的驗證結果，全部都要是「已建立」
--
-- 為什麼要全選：SQL Editor 只會執行選取的範圍，游標放在中間按 Run
-- 可能只跑了一段，看起來像是「跑了卻沒生效」。
--
-- ============================================================



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
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證：函式在不在，以及前端的身分有沒有權限呼叫
-- ============================================================
-- 「缺少」代表這份腳本沒跑完。
-- 「沒有權限」代表建立了但 grant 沒生效，PostgREST 一樣會說找不到。
with expected(fn, who) as (
  values
    ('normalize_person_name', 'anon'),
    ('lookup_roster',         'anon'),
    ('check_in_signature',    'anon')
)
select
  e.fn as 函式名稱,
  case
    when p.oid is null then '缺少'
    when not has_function_privilege(e.who, p.oid, 'execute') then '沒有權限'
    else '已建立'
  end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;

-- 名冊資料表與新增的欄位
with expected(tbl, col) as (
  values ('events', 'join_mode'),
         ('participants', 'organization'),
         ('participants', 'seat_no'),
         ('event_roster', 'display_name')
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
