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


-- ############################################################
-- 來源：20260730090000_c1_artwork_and_sheet
-- ############################################################

-- C1：彩繪與簽名並存、大螢幕顯示方式、簽到表匯出
--
-- 三件事：
--
-- 1. 一個人可以同時有「簽名」與「彩繪」兩張圖。
--    participants.image_path 維持原本的語意（彩繪／手繪角色），
--    簽名另外存在 signature_path。兩欄都可以是 null，但至少要有一張，
--    否則大螢幕上會出現一個看不見的人。
--
-- 2. 大螢幕顯示哪一張由主持人決定，存在 events.stage_display：
--    signature（只顯示簽名）、artwork（只顯示彩繪）、both（彩繪配簽名）。
--    這是活動當下會想切換的設定——彩繪還沒畫完之前先放簽名，
--    畫完了再切成兩張一起——所以不能在報到當下就把結果燒死。
--    合成在大螢幕端做，切換設定就會立刻反映在既有的每一個人身上。
--
-- 3. 簽到表匯出。活動成果需要一份「誰來了、簽名長什麼樣」的紀錄，
--    這是主持人專用的查詢，回傳含 Storage 路徑的完整名單。

-- ============================================================
-- 欄位
-- ============================================================

alter table public.participants
  add column if not exists signature_path text;

alter table public.events
  add column if not exists stage_display text not null default 'signature';

alter table public.events
  drop constraint if exists events_stage_display_valid;

alter table public.events
  add constraint events_stage_display_valid
  check (stage_display in ('signature', 'artwork', 'both'));

-- ============================================================
-- 大螢幕：多回傳一個簽名路徑
-- ============================================================

-- returns table 的回傳欄位變了就不能只用 create or replace，
-- 會直接報 cannot change return type of existing function
drop function if exists public.get_stage_participants(uuid);

create or replace function public.get_stage_participants(p_event_id uuid)
returns table (
  id uuid,
  display_name text,
  character_name text,
  image_path text,
  signature_path text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name, p.character_name,
         p.image_path, p.signature_path, p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     and p.is_visible
   order by p.joined_at;
$$;

revoke execute on function public.get_stage_participants(uuid) from public;
grant execute on function public.get_stage_participants(uuid) to anon, authenticated;

-- ============================================================
-- 簽到：可以同時帶簽名與彩繪
-- ============================================================

-- 參數變多了。加上預設值會變成多載而不是取代，PostgREST 遇到兩個
-- 同名函式會不知道該呼叫哪一支，所以先把舊的那一支拿掉。
drop function if exists public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid
);

/**
 * 完成簽到，或補上圖片。
 *
 * p_image_path 是彩繪、p_signature_path 是簽名，兩個都可以是 null，
 * 但不能都是 null——沒有任何一張圖的人在大螢幕上是看不見的。
 *
 * 同一台裝置重來時不是拒絕，而是把有帶的那一張補上去。
 * 現場的流程是「先簽名入座，中場再去畫彩繪」，第二次進來時
 * 只會帶彩繪，這時要接在原本那一位身上，而不是變成第二個人。
 */
create or replace function public.check_in_signature(
  p_event_id uuid,
  p_participant_id uuid,
  p_display_name text,
  p_organization text,
  p_seat_no text,
  p_image_path text,
  p_device_token text,
  p_roster_id uuid default null,
  p_signature_path text default null
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
  v_prefix text;
begin
  select * into v_event from public.events e where e.id = p_event_id;

  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if v_event.status <> 'open' then
    raise exception 'EVENT_NOT_OPEN';
  end if;

  if p_image_path is null and p_signature_path is null then
    raise exception 'NO_IMAGE';
  end if;

  -- 圖片必須落在這場活動的資料夾底下，跟 RLS insert 政策同一條規則
  v_prefix := p_event_id::text || '/%';
  if p_image_path is not null and p_image_path not like v_prefix then
    raise exception 'BAD_IMAGE_PATH';
  end if;
  if p_signature_path is not null and p_signature_path not like v_prefix then
    raise exception 'BAD_IMAGE_PATH';
  end if;

  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'BAD_NAME';
  end if;

  v_org := nullif(btrim(coalesce(p_organization, '')), '');
  v_seat := nullif(btrim(coalesce(p_seat_no, '')), '');

  -- 這台裝置簽過了：把這次帶來的圖補上去，不新增第二位
  select * into v_existing
    from public.participants p
   where p.event_id = p_event_id
     and p.device_token = p_device_token;

  if found then
    update public.participants p
       set image_path = coalesce(p_image_path, p.image_path),
           signature_path = coalesce(p_signature_path, p.signature_path),
           display_name = v_name,
           organization = coalesce(v_org, p.organization),
           seat_no = coalesce(v_seat, p.seat_no)
     where p.id = v_existing.id
    returning * into v_existing;

    return jsonb_build_object(
      'participant_id', v_existing.id,
      'image_path', v_existing.image_path,
      'signature_path', v_existing.signature_path,
      'already_joined', true
    );
  end if;

  begin
    insert into public.participants (
      id, event_id, display_name, character_name,
      image_path, signature_path, device_token, organization, seat_no
    )
    values (
      coalesce(p_participant_id, gen_random_uuid()), p_event_id, v_name, null,
      -- image_path 是 not null，只簽名沒彩繪時就讓兩欄都指向簽名，
      -- 大螢幕與抽獎那一套完全不必知道簽到模式的存在
      coalesce(p_image_path, p_signature_path), p_signature_path,
      p_device_token, v_org, v_seat
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
        'signature_path', v_existing.signature_path,
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
    'signature_path', v_existing.signature_path,
    'already_joined', false
  );
end;
$$;

-- ============================================================
-- 簽到表（主持人）
-- ============================================================

/**
 * 活動成果用的簽到表資料。
 *
 * 回傳 jsonb 而不是 returns table：這份清單的欄位以後一定還會加
 * （職稱、報到時間格式、備註），每加一次就得 drop 一次函式，
 * 而每一次改動函式簽章都要主持人再跑一次安裝腳本。
 *
 * 排序以桌次為主、姓名為輔，跟紙本簽到簿一樣是按桌排的；
 * 桌次沒填的排在最後。
 */
create or replace function public.list_event_signatures(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not exists (
    select 1 from public.events e
     where e.id = p_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_HOST';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
    into v_result
    from (
      select p.id,
             p.display_name,
             p.organization,
             p.seat_no,
             p.image_path,
             p.signature_path,
             p.is_visible,
             p.joined_at,
             r.title as roster_title
        from public.participants p
        left join public.event_roster r on r.participant_id = p.id
       where p.event_id = p_event_id
       -- 桌次是文字（可能是「A」「貴賓」），能轉成數字的照數字排，
       -- 不然「10」會排在「2」前面
       order by (p.seat_no is null),
                nullif(regexp_replace(coalesce(p.seat_no, ''), '\D', '', 'g'), '')::int
                  nulls last,
                p.seat_no,
                p.joined_at
    ) t;

  return v_result;
end;
$$;

grant execute on function public.list_event_signatures(uuid) to authenticated;

grant execute on function public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text
) to anon, authenticated;

-- ============================================================
-- 即時廣播：帶上簽名路徑，換圖時也要通知大螢幕
-- ============================================================

/**
 * 相對 M4 的兩個變更：
 *
 * 1. payload 多帶 signature_path。
 * 2. 圖片換了也要廣播。現場的流程是「先簽名入座、中場再去畫彩繪」，
 *    第二次是 update 而不是 insert。M4 的觸發器只認 is_visible 的變動，
 *    彩繪畫完了大螢幕不會知道。
 *
 * 換圖時先送 removed 再送 joined：大螢幕的 spawn 對同一個 id 會直接略過
 * （避免重連對帳時長出兩隻），所以只送 joined 是沒有作用的。
 * 先撤下再進場，看起來就是「畫完了，重新流進河裡」。
 */
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
  v_full    jsonb;
begin
  if tg_op = 'DELETE' then
    perform realtime.send(
      jsonb_build_object('id', old.id),
      'participant:removed',
      'event:' || old.event_id,
      false
    );
    return old;
  end if;

  v_topic := 'event:' || new.event_id;
  v_full := jsonb_build_object(
    'id', new.id,
    'display_name', new.display_name,
    'character_name', new.character_name,
    'image_path', new.image_path,
    'signature_path', new.signature_path,
    'joined_at', new.joined_at
  );

  if tg_op = 'INSERT' then
    -- 理論上不會有 insert 即隱藏的情況，防禦性略過
    if not new.is_visible then
      return new;
    end if;
    v_event := 'participant:joined';
    v_payload := v_full;

  else -- UPDATE
    if old.is_visible <> new.is_visible then
      if new.is_visible then
        -- 主持人取消隱藏：以完整資料重新進場
        v_event := 'participant:joined';
        v_payload := v_full;
      else
        -- 主持人隱藏：大螢幕即時移除（規格第 16 節第 4 點）
        v_event := 'participant:removed';
        v_payload := jsonb_build_object('id', new.id);
      end if;
    elsif new.is_visible and (
      old.image_path is distinct from new.image_path
      or old.signature_path is distinct from new.signature_path
    ) then
      perform realtime.send(
        jsonb_build_object('id', new.id),
        'participant:removed',
        v_topic,
        false
      );
      v_event := 'participant:joined';
      v_payload := v_full;
    else
      return new;
    end if;
  end if;

  perform realtime.send(v_payload, v_event, v_topic, false);
  return new;

exception when others then
  -- 廣播失敗絕不能擋下報名寫入；大螢幕的定期對帳會補上遺漏
  return coalesce(new, old);
end;
$$;

drop trigger if exists participants_broadcast_change on public.participants;
create trigger participants_broadcast_change
  after insert
     or update of is_visible, image_path, signature_path
     or delete
  on public.participants
  for each row execute function public.broadcast_participant_change();


-- ############################################################
-- 來源：20260730150000_c2_stage_config
-- ############################################################

-- C2：大螢幕的可調設定
--
-- 兩件事都收在同一個 jsonb 欄位裡：
--
-- 1. 河道的流速。原本寫死在模板裡，但「多快才好看」是現場才知道的事：
--    投影機的大小、坐得多遠、當下的節奏，都會改變答案。
--    主持人要能在活動進行中拉一下就改掉，不能改程式碼重新部署。
--
-- 2. 大螢幕上那一塊固定不動的主視覺文字。
--    河道在流、簽名在流，但標題、日期、場地應該像海報一樣定在那裡。
--
-- 為什麼是一個 jsonb 而不是十幾個欄位：這些設定還會再長
-- （字級、位置、要不要顯示某一行），每加一個都動一次 schema、
-- 每動一次就要主持人再跑一次安裝腳本。jsonb 加欄位不必動資料庫。
--
-- 為什麼不做成獨立的資料表：一場活動只有一份設定，
-- 多一張表只是多一次 join 與多一組 RLS 政策要維護。

alter table public.events
  add column if not exists stage_config jsonb not null default '{}'::jsonb;

-- 讀取由既有的 events 政策涵蓋（anon 可讀公開活動、主持人可讀自己的），
-- 寫入由 events_host_update 涵蓋。這裡不需要任何新的政策或函式。


-- ############################################################
-- 來源：20260731090000_c6_assets_limit
-- ############################################################

-- C6：把 assets bucket 的單檔上限提高到 4MB
--
-- 原本是 1MB，那個數字是當初只放 logo 時訂的。現在同一個 bucket 還要放
-- 大螢幕的背景圖——活動主視覺這種圖動輒好幾 MB，主持人上傳時會撞到
-- 「The object exceeded the maximum allowed size」，而那句英文
-- 看不出是什麼意思，也看不出該怎麼辦。
--
-- 前端已經會在上傳前把圖縮到 2560 寬並壓到 900KB 以內，所以正常情況
-- 根本碰不到這個上限。這裡調高只是餘裕：編碼器的輸出大小會浮動，
-- 而活動當天不該卡在這種地方。
--
-- 為什麼不調更高：這個 bucket 是公開讀取的，每次大螢幕開場都會把
-- 背景圖整張抓下來。會場的 Wi-Fi 通常沒有那麼寬裕，留一個上限
-- 可以擋掉「不小心上傳一張 20MB 的原始輸出」這種事。

update storage.buckets
   set file_size_limit = 4194304
 where id = 'assets';

-- 順便確認 WebP 在允許的格式裡：前端壓縮之後輸出的就是 WebP
update storage.buckets
   set allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
 where id = 'assets';


-- ############################################################
-- 來源：20260801090000_c11_delete_event
-- ############################################################

-- C11：刪除活動
--
-- 主持人測試時會建好幾個活動，活動清單很快就變成一堆「測試1」「測試2」。
-- 沒有刪除鍵的話那些永遠留著，正式那一場混在裡面很容易點錯——
-- 活動當天點錯活動是很難救的。
--
-- 幾個刻意的決定：
--
-- 1. 只有活動的主人刪得掉。RLS policy 已經是這樣，但刪除是不可逆的，
--    所以這裡再用 security definer 的函式檢查一次 host_id，
--    不依賴呼叫端有沒有帶對條件。
--
-- 2. 必須輸入活動代碼才刪得掉。函式要求呼叫端把代碼一起送上來，
--    對不上就拒絕。前端也會要求打字確認，但那只是介面；
--    真正擋住「手滑點到」的是這一層。
--
-- 3. 已經結束的活動也能刪。有人會想留紀錄，但那是主持人自己的判斷，
--    不是系統該替他決定的事——真的需要紀錄的是簽到表，那份可以先匯出。
--
-- 4. 關聯資料靠外鍵的 on delete cascade 帶走。M1 起所有子表都是
--    references public.events(id) on delete cascade，所以參與者、獎項、
--    抽獎結果、遊戲房間、題目、作答會一起消失。
--    Storage 裡的圖檔不會自動刪——那是另一個系統，而且刪錯了救不回來。
--
-- 此檔可重複執行。

-- 回傳型別可能改變，先丟掉再建（create or replace 不能改回傳型別）
drop function if exists public.delete_event(uuid, text);

create or replace function public.delete_event(
  p_event_id uuid,
  p_code     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events e where e.id = p_event_id;

  if v_event.id is null then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  -- 不是自己的活動：一律當成找不到，不透露這個 id 存不存在
  if v_event.host_id is null or v_event.host_id <> auth.uid() then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  -- 代碼對不上就是打錯了，不刪
  if upper(btrim(coalesce(p_code, ''))) <> upper(v_event.code) then
    raise exception 'CODE_MISMATCH';
  end if;

  delete from public.events where id = p_event_id;
end;
$$;

revoke all on function public.delete_event(uuid, text) from public;
grant execute on function public.delete_event(uuid, text) to authenticated;


-- ############################################################
-- 來源：20260801120000_c12_captain_vote
-- ############################################################

-- C12：桌長投票
--
-- 原本的桌長是「先搶先贏」——誰先按誰就是。那在趕時間的時候很有效，
-- 但它不是推派，是手速比賽：坐在最後面剛拿出手機的人永遠沒機會，
-- 而那個人可能才是這一桌想推的。
--
-- 這一版改成投票，並且把節奏交給主持人：
--
--   主持人確認大家都入座了 → 按「開始選桌長」並設定秒數
--   → 每個人在自己手機上選一位同桌的人（可以改，也可以投自己）
--   → 倒數結束，主持人按定案，票最多的那位成為桌長
--
-- 三個刻意的設計：
--
-- 1. 「現在是不是投票時間」是算出來的，不是存的狀態。
--    跟 Q2 的答題階段同一套：從 captain_vote_started_at 加上秒數推算。
--    手機、大螢幕、後台三邊各自算，永遠一致，中間不需要任何人
--    在正確的時間點寫入資料庫——那個寫入一旦漏掉（分頁被切到背景、
--    網路斷一下），全場就卡在投票畫面出不來。
--
-- 2. 定案是一次寫入，由主持人觸發，而且可以重複執行。
--    三百多支手機在倒數結束的同一秒各自去寫「誰是桌長」是災難；
--    只有一個寫入者就沒有競態。
--
-- 3. 平票取「最早投出那一票的人」。用時間決勝而不是隨機：
--    現場要能解釋為什麼是他，而「他先被投」講得通。
--
-- 此檔可重複執行。

-- ============================================================
-- 投票視窗
-- ============================================================

alter table public.game_sessions
  add column if not exists captain_vote_started_at timestamptz;

alter table public.game_sessions
  add column if not exists captain_vote_seconds int not null default 30;

do $$
begin
  alter table public.game_sessions
    add constraint game_sessions_captain_vote_range
    check (captain_vote_seconds between 10 and 300);
exception when duplicate_object then null;
end $$;

-- ============================================================
-- 票
-- ============================================================

create table if not exists public.captain_votes (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.game_sessions(id) on delete cascade,
  team_id             uuid not null references public.teams(id) on delete cascade,
  voter_player_id     uuid not null references public.game_players(id) on delete cascade,
  candidate_player_id uuid not null references public.game_players(id) on delete cascade,
  created_at          timestamptz not null default now(),

  -- 一人一票。改投是 update 這一列，不是插新的一列——
  -- 保留「第一次投票的時間」才有辦法用時間決平票。
  unique (session_id, voter_player_id)
);

create index if not exists captain_votes_team_idx
  on public.captain_votes (team_id);

alter table public.captain_votes enable row level security;

-- 票不開放給 anon 直接讀寫：能讀就能知道誰投給誰，
-- 而那在現場是會吵架的。所有存取一律走下面的函式。
drop policy if exists captain_votes_no_anon on public.captain_votes;

-- ============================================================
-- 開始投票（主持人）
-- ============================================================

create or replace function public.start_captain_vote(
  p_session_id uuid,
  p_seconds    int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seconds int := greatest(10, least(300, coalesce(p_seconds, 30)));
begin
  update public.game_sessions s
     set captain_vote_started_at = now(),
         captain_vote_seconds = v_seconds
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid());

  if not found then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 重開一輪投票要把上一輪的票清掉，否則舊票會混進新的計算
  delete from public.captain_votes where session_id = p_session_id;
  update public.game_players set is_captain = false
   where session_id = p_session_id and is_captain;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'seconds', v_seconds),
    'captain:vote-start', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.start_captain_vote(uuid, int) from public;
grant execute on function public.start_captain_vote(uuid, int) to authenticated;

-- ============================================================
-- 投票（玩家，匿名）
-- ============================================================

create or replace function public.cast_captain_vote(
  p_session_id   uuid,
  p_device_token text,
  p_candidate_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_voter     public.game_players;
  v_candidate public.game_players;
  v_session   public.game_sessions;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  -- 投票視窗是算出來的。過了就不收——主持人晚一點按定案，
  -- 不該讓遲到的票變成有效。
  if v_session.captain_vote_started_at is null
     or now() > v_session.captain_vote_started_at
                + make_interval(secs => v_session.captain_vote_seconds) then
    raise exception 'VOTE_CLOSED';
  end if;

  select * into v_voter from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_voter.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select * into v_candidate from public.game_players gp
   where gp.id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'CANDIDATE_NOT_FOUND';
  end if;

  -- 只能投同一桌的人。跨桌投票在現場只會製造混亂。
  if v_candidate.team_id <> v_voter.team_id then
    raise exception 'DIFFERENT_TEAM';
  end if;

  insert into public.captain_votes
    (session_id, team_id, voter_player_id, candidate_player_id)
  values
    (p_session_id, v_voter.team_id, v_voter.id, v_candidate.id)
  on conflict (session_id, voter_player_id) do update
    set candidate_player_id = excluded.candidate_player_id;

  -- 廣播給同一桌就好，不是整場。一桌三十幾個人，
  -- 整場三百多人——差別是十倍的扇出。
  perform realtime.send(
    jsonb_build_object('team_id', v_voter.team_id),
    'captain:vote', 'table:' || v_voter.team_id, false);
end;
$$;

revoke execute on function public.cast_captain_vote(uuid, text, uuid) from public;
grant execute on function public.cast_captain_vote(uuid, text, uuid) to anon, authenticated;

-- ============================================================
-- 定案（主持人）
-- ============================================================

-- 回傳型別可能改變，先丟掉再建
drop function if exists public.finalize_captain_votes(uuid);

create or replace function public.finalize_captain_votes(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_decided int := 0;
  v_pending int := 0;
  v_team    record;
  v_winner  uuid;
begin
  if not exists (
    select 1 from public.game_sessions s
     join public.events e on e.id = s.event_id
    where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  for v_team in
    select t.id from public.teams t where t.session_id = p_session_id
  loop
    -- 票最多的人。平票取「最早被投到那一票」的人：
    -- 現場要能解釋為什麼是他，而「他先被投」講得通。
    select cv.candidate_player_id into v_winner
      from public.captain_votes cv
     where cv.team_id = v_team.id
     group by cv.candidate_player_id
     order by count(*) desc, min(cv.created_at) asc
     limit 1;

    if v_winner is null then
      -- 這一桌沒有人投票。不自動指定：沒有人想當的桌，
      -- 主持人走過去問一句比系統亂點一個人有用。
      v_pending := v_pending + 1;
      continue;
    end if;

    update public.game_players set is_captain = false
     where team_id = v_team.id and is_captain and id <> v_winner;
    update public.game_players set is_captain = true
     where id = v_winner and not is_captain;

    v_decided := v_decided + 1;
  end loop;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'decided', v_decided),
    'captain:decided', 'game:' || p_session_id, false);

  return jsonb_build_object('decided', v_decided, 'pending', v_pending);
end;
$$;

revoke execute on function public.finalize_captain_votes(uuid) from public;
grant execute on function public.finalize_captain_votes(uuid) to authenticated;

-- ============================================================
-- 我這一桌的投票畫面（玩家，匿名）
-- ============================================================

drop function if exists public.get_captain_vote_state(uuid, text);

create or replace function public.get_captain_vote_state(
  p_session_id   uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player  public.game_players;
  v_session public.game_sessions;
  v_members jsonb;
  v_my_vote uuid;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select cv.candidate_player_id into v_my_vote
    from public.captain_votes cv
   where cv.session_id = p_session_id and cv.voter_player_id = v_player.id;

  -- 只回傳票數，不回傳「誰投給誰」。知道誰投給誰在現場只會吵架。
  select coalesce(jsonb_agg(m order by m.display_name), '[]'::jsonb)
    into v_members
    from (
      select gp.id,
             gp.display_name,
             gp.is_captain,
             (select count(*) from public.captain_votes cv
               where cv.candidate_player_id = gp.id) as votes
        from public.game_players gp
       where gp.team_id = v_player.team_id
    ) m;

  return jsonb_build_object(
    'team_id', v_player.team_id,
    'team_name', (select t.name from public.teams t where t.id = v_player.team_id),
    'my_player_id', v_player.id,
    'my_vote', v_my_vote,
    'members', v_members,
    'started_at_ms',
      case when v_session.captain_vote_started_at is null then null
           else extract(epoch from v_session.captain_vote_started_at) * 1000 end,
    'vote_seconds', v_session.captain_vote_seconds,
    'server_ms', extract(epoch from now()) * 1000
  );
end;
$$;

revoke execute on function public.get_captain_vote_state(uuid, text) from public;
grant execute on function public.get_captain_vote_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕：每一桌選好了沒
-- ============================================================

drop function if exists public.get_captain_stage_state(uuid);

create or replace function public.get_captain_stage_state(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_tables  jsonb;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(x order by x.table_no), '[]'::jsonb)
    into v_tables
    from (
      select t.id,
             t.table_no,
             t.name,
             t.color,
             t.player_count,
             (select gp.display_name from public.game_players gp
               where gp.team_id = t.id and gp.is_captain limit 1) as captain_name,
             (select count(*) from public.captain_votes cv
               where cv.team_id = t.id) as vote_count,
             coalesce((
               select jsonb_agg(gp.display_name order by gp.joined_at)
                 from public.game_players gp
                where gp.team_id = t.id and not gp.is_captain
             ), '[]'::jsonb) as members
        from public.teams t
       where t.session_id = p_session_id
    ) x;

  return jsonb_build_object(
    'tables', v_tables,
    'started_at_ms',
      case when v_session.captain_vote_started_at is null then null
           else extract(epoch from v_session.captain_vote_started_at) * 1000 end,
    'vote_seconds', v_session.captain_vote_seconds,
    'server_ms', extract(epoch from now()) * 1000
  );
end;
$$;

revoke execute on function public.get_captain_stage_state(uuid) from public;
grant execute on function public.get_captain_stage_state(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260801150000_c13_table_chat
-- ############################################################

-- C13：同桌聊天室
--
-- 每一桌一個聊天室，只有同桌的人看得到。桌長要做決定之前，
-- 組員在自己手機上把想法丟出來——包含直接按「我覺得 B」這種快捷鍵，
-- 那比打字快得多，而現場只有二十秒。
--
-- 三百五十個人同時打字是這個系統最容易垮的地方，所以扇出的設計
-- 是這一份最重要的部分：
--
-- 1. 廣播的頻道是「桌」不是「場」。
--    一則訊息推給同桌的三十幾個人，不是推給全場三百五十個人。
--    十桌的話，同樣的流量差十倍；而現場真正會同時講話的
--    也就是那幾桌。
--
-- 2. 廣播只送「有新訊息」這件事，不送訊息內容。
--    內容由收到通知的那一桌自己去拉。這樣訊息本體只走一次查詢，
--    而且遲到的人拉一次就有完整的上下文，不必補播歷史。
--    （送內容的話還要處理順序、重送、離線補齊，那是另一個工程。）
--
-- 3. 送出的速率在資料庫這一層擋。
--    前端的節流可以被繞過，而一個人瘋狂按貼圖就能把同桌洗版。
--    每個人每則之間至少 1.2 秒——快到不會妨礙討論，
--    但擋得住連按。
--
-- 此檔可重複執行。

create table if not exists public.table_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  player_id  uuid not null references public.game_players(id) on delete cascade,
  -- text 是打出來的字，sticker 是快捷鍵（答題選項 A/B/C/D 或簡單的反應）
  kind       text not null default 'text',
  body       text not null,
  created_at timestamptz not null default now(),

  constraint table_messages_kind_valid check (kind in ('text', 'sticker')),
  constraint table_messages_body_length
    check (char_length(btrim(body)) between 1 and 200)
);

create index if not exists table_messages_team_idx
  on public.table_messages (team_id, created_at desc);

alter table public.table_messages enable row level security;

-- 不開放 anon 直接讀寫：能直接讀就能讀到別桌的討論，
-- 而別桌的討論在答題遊戲裡就是答案。一律走函式。
drop policy if exists table_messages_no_anon on public.table_messages;

-- ============================================================
-- 送出訊息（玩家，匿名）
-- ============================================================

create or replace function public.send_table_message(
  p_session_id   uuid,
  p_device_token text,
  p_kind         text,
  p_body         text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_last   timestamptz;
  v_kind   text := case when p_kind = 'sticker' then 'sticker' else 'text' end;
  v_body   text := btrim(coalesce(p_body, ''));
begin
  if char_length(v_body) = 0 then
    raise exception 'EMPTY_MESSAGE';
  end if;
  -- 超過的直接截斷而不是報錯：現場沒有人想看到「訊息太長」，
  -- 而超長的訊息在手機上本來就讀不完
  v_body := left(v_body, 200);

  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  -- 速率限制。擋的是連按貼圖把同桌洗版，不是正常的討論。
  select max(tm.created_at) into v_last
    from public.table_messages tm
   where tm.player_id = v_player.id;

  if v_last is not null and now() - v_last < interval '1.2 seconds' then
    raise exception 'TOO_FAST';
  end if;

  insert into public.table_messages (session_id, team_id, player_id, kind, body)
  values (p_session_id, v_player.team_id, v_player.id, v_kind, v_body);

  -- 只通知「有新訊息」，內容讓那一桌自己去拉。
  -- 頻道是桌不是場：扇出從三百五十變成三十幾。
  perform realtime.send(
    jsonb_build_object('team_id', v_player.team_id),
    'table:message', 'table:' || v_player.team_id, false);
end;
$$;

revoke execute on function public.send_table_message(uuid, text, text, text) from public;
grant execute on function public.send_table_message(uuid, text, text, text)
  to anon, authenticated;

-- ============================================================
-- 讀同桌的訊息（玩家，匿名）
-- ============================================================

drop function if exists public.list_table_messages(uuid, text, int);

create or replace function public.list_table_messages(
  p_session_id   uuid,
  p_device_token text,
  p_limit        int default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_rows   jsonb;
  v_limit  int := greatest(1, least(100, coalesce(p_limit, 50)));
begin
  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  -- 只給最近的幾十則。現場的討論是即時的，往上滑三百則沒有意義，
  -- 而每一則都要過網路。
  select coalesce(jsonb_agg(x order by x.created_at), '[]'::jsonb)
    into v_rows
    from (
      select tm.id,
             tm.kind,
             tm.body,
             tm.created_at,
             tm.player_id,
             gp.display_name,
             gp.is_captain
        from public.table_messages tm
        join public.game_players gp on gp.id = tm.player_id
       where tm.team_id = v_player.team_id
       order by tm.created_at desc
       limit v_limit
    ) x;

  return jsonb_build_object(
    'team_id', v_player.team_id,
    'my_player_id', v_player.id,
    'i_am_captain', v_player.is_captain,
    'messages', v_rows
  );
end;
$$;

revoke execute on function public.list_table_messages(uuid, text, int) from public;
grant execute on function public.list_table_messages(uuid, text, int)
  to anon, authenticated;

-- ============================================================
-- 清空一桌的訊息（主持人）
-- ============================================================

create or replace function public.clear_table_messages(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.game_sessions s
     join public.events e on e.id = s.event_id
    where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.table_messages where session_id = p_session_id;
end;
$$;

revoke execute on function public.clear_table_messages(uuid) from public;
grant execute on function public.clear_table_messages(uuid) to authenticated;


-- ############################################################
-- 來源：20260802090000_c14_cookies
-- ############################################################

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


-- ############################################################
-- 來源：20260802150000_c15_delete_game_session
-- ############################################################

-- C15：刪除遊戲房間
--
-- 測試的時候會建好幾個房間，場次選單很快就變成一排「測試」「測試2」
-- 「這次才是真的」。活動當天在那個選單裡點錯場次，等於整場遊戲的
-- 隊伍與分數都不對——而且要在幾百人面前發現。
--
-- 跟刪除活動同一套規則：
--
-- 1. 只有活動的主人刪得掉，而且在函式裡再檢查一次，不依賴呼叫端。
-- 2. 要把場次名稱一起送上來，對不上就拒絕。前端也會要求打字確認，
--    但真正擋住手滑的是這一層。
-- 3. 關聯資料靠外鍵的 on delete cascade 帶走：隊伍、玩家、回合結果、
--    題目、作答、桌長票、同桌訊息。
--
-- 進行中的場次不擋。主持人要刪一定有他的理由（例如剛才建錯了、
-- 現在要重來），系統跳出來說「不行，這場正在進行」只會讓人卡住。
--
-- 此檔可重複執行。

drop function if exists public.delete_game_session(uuid, text);

create or replace function public.delete_game_session(
  p_session_id uuid,
  p_name       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;

  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  -- 不是自己活動底下的場次：一律當成找不到，不透露它存不存在
  if not exists (
    select 1 from public.events e
     where e.id = v_session.event_id and e.host_id = auth.uid()
  ) then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  -- 名稱對不上就是打錯了，不刪
  if btrim(coalesce(p_name, '')) <> btrim(v_session.name) then
    raise exception 'NAME_MISMATCH';
  end if;

  delete from public.game_sessions where id = p_session_id;
end;
$$;

revoke all on function public.delete_game_session(uuid, text) from public;
grant execute on function public.delete_game_session(uuid, text) to authenticated;


-- ############################################################
-- 來源：20260803090000_c16_lobby_board
-- ############################################################

-- C16：大螢幕的入座看板
--
-- 主持人在台上要做的判斷只有一個：現在可以開始了嗎？
-- 這個判斷需要的資訊是「哪幾桌還沒進來」，不是「總共幾個人」。
-- 一個總數在三十桌的場子裡完全沒有用——少了十個人，你不知道是
-- 某一桌整桌沒掃，還是十桌各少一個。
--
-- 所以這個函式一次把每一桌的狀態都給出來：桌號、隊名、顏色、
-- 幾個人、桌長是誰。大螢幕自己去分「已加入」與「還沒加入」，
-- 主持人抬頭一看就知道要喊第幾桌。
--
-- 跟 list_session_teams 的差別：
--
--   不回傳 join_code。大螢幕不需要，而那是投影在兩三百人面前的畫面，
--   加入碼出現在上面等於任何人都能坐進任何一桌。
--
--   多回傳桌長。桌長選舉（C12）的畫面還沒做，但資料層已經在了，
--   等那邊接上來這裡就會自己亮起來，不必再改一次。
--
-- 開放給 anon：大螢幕不登入。回傳的都是本來就要投影出去的東西
-- （桌號、隊名、人數、桌長的顯示名稱），沒有 device_token，
-- 也沒有完整的參與者名單。
--
-- 此檔可重複執行。

drop function if exists public.get_lobby_board(uuid);

create or replace function public.get_lobby_board(p_session_id uuid)
returns table (
  id           uuid,
  table_no     int,
  name         text,
  color        text,
  creature_key text,
  player_count int,
  captain_name text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id,
         t.table_no,
         t.name,
         t.color,
         t.creature_key,
         t.player_count,
         (select gp.display_name
            from public.game_players gp
           where gp.team_id = t.id and gp.is_captain
           limit 1) as captain_name
    from public.teams t
   where t.session_id = p_session_id
   order by t.table_no;
$$;

revoke execute on function public.get_lobby_board(uuid) from public;
grant execute on function public.get_lobby_board(uuid) to anon, authenticated;


-- ############################################################
-- 來源：20260804090000_c18_checkin_lookup
-- ############################################################

-- C18：以姓名查自己是不是已經報到過
--
-- 同一支手機重掃 QR 會直接跳到完成頁，那是靠瀏覽器裡存的紀錄。
-- 但現場真正會發生的是這些：手機換了、用無痕開、清了瀏覽資料、
-- 或是報到台幫忙用平板代簽過一次，本人自己再掃一次。
-- 這些情況下瀏覽器裡什麼都沒有，於是同一個人會被簽進去第二次——
-- 大螢幕上出現兩個一樣的名字，抽獎名單裡也多一份。
--
-- 這支函式讓報到頁在送出之前先問一次：這個名字報到過了嗎？
-- 報到過就直接把他帶到完成頁，看到的是他原本那一筆。
--
-- 為什麼只接受完整姓名相符：
--
--   participants 對匿名端是完全關閉的，就是為了不讓任何人把
--   與會者名單整份撈走。這支函式維持同樣的限制——要先知道
--   完整姓名才問得出東西，跟 lookup_roster 同一套規則。
--   前綴、模糊、列舉一律不支援。
--
-- 回傳裡沒有 device_token。那是別人手機的身分，一旦外流就能冒用。
--
-- 此檔可重複執行。

drop function if exists public.find_checkin_by_name(uuid, text);

create or replace function public.find_checkin_by_name(
  p_event_id uuid,
  p_name     text
)
returns table (
  id             uuid,
  display_name   text,
  organization   text,
  seat_no        text,
  image_path     text,
  signature_path text,
  joined_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         p.display_name,
         p.organization,
         p.seat_no,
         p.image_path,
         p.signature_path,
         p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     -- btrim + lower：現場最常見的是多打一個空白或大小寫不同，
     -- 那不該被當成另一個人
     and lower(btrim(p.display_name)) = lower(btrim(coalesce(p_name, '')))
     and btrim(coalesce(p_name, '')) <> ''
   order by p.joined_at
   limit 5;
$$;

revoke execute on function public.find_checkin_by_name(uuid, text) from public;
grant execute on function public.find_checkin_by_name(uuid, text) to anon, authenticated;


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
    ('check_in_signature',    'anon'),
    ('get_stage_participants','anon'),
    ('list_event_signatures', 'authenticated')
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
         ('events', 'stage_display'),
         ('events', 'stage_config'),
         ('participants', 'organization'),
         ('participants', 'seat_no'),
         ('participants', 'signature_path'),
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
