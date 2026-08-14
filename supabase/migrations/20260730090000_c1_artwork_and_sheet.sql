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

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
