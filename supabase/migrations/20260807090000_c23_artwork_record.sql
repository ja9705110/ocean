-- C23：把彩繪這件事記下來
--
-- 現在資料庫裡只知道「這個人的圖在哪個路徑」。活動結束之後想回答的
-- 問題卻是別的：有幾個人真的畫了？誰挑了哪一張線稿？哪幾張最受歡迎？
-- 誰用掉了重畫的機會？這些現在一個都查不到——image_path 那一欄
-- 在只簽名的人身上放的是簽名，在有畫的人身上放的是彩繪，
-- 光看它分不出這個人到底畫了沒。
--
-- 三個欄位就夠：
--
--   artwork_path     彩繪本身。跟 image_path 分開存——image_path 是
--                    「大螢幕上顯示哪一張」，那是展示用的欄位，
--                    會被後來的動作蓋掉。這一欄是紀錄，不會被蓋。
--   artwork_stencil  挑了哪一張線稿。null 表示空白畫布自己畫。
--   artwork_at       畫完送出的時間。跟報到時間分開——很多人是報到
--                    很久之後才回來補畫的，那兩個時間差本身就是資訊。
--
-- artwork_count（C21）留著算次數，這三欄是內容。
--
-- 此檔可重複執行。

alter table public.participants
  add column if not exists artwork_path text,
  add column if not exists artwork_stencil text,
  add column if not exists artwork_at timestamptz;

comment on column public.participants.artwork_path is
  '彩繪圖片的路徑。跟 image_path 分開：那一欄是大螢幕要顯示哪張，這一欄是紀錄。';
comment on column public.participants.artwork_stencil is
  '挑了哪一張線稿的 key。null 表示空白畫布自己畫。';

-- 這一欄是拿來做成果統計的，會照活動撈整份
create index if not exists participants_artwork_idx
  on public.participants (event_id, artwork_at)
  where artwork_path is not null;

-- ============================================================
-- 送出彩繪時一併記下來
-- ============================================================

create or replace function public.check_in_signature(
  p_event_id uuid,
  p_participant_id uuid,
  p_display_name text,
  p_organization text,
  p_seat_no text,
  p_image_path text,
  p_device_token text,
  p_roster_id uuid default null,
  p_signature_path text default null,
  p_stencil text default null
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
  v_is_artwork boolean;
  v_stencil text;
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
  -- 線稿的 key 是前端給的字串，只是拿來做統計，長度擋一下就好
  v_stencil := nullif(btrim(coalesce(p_stencil, '')), '');
  if v_stencil is not null and char_length(v_stencil) > 40 then
    v_stencil := left(v_stencil, 40);
  end if;

  -- 「這次帶了彩繪來」＝有 image_path，而且它跟簽名不是同一張。
  -- 只送簽名時呼叫端會讓兩欄指向同一個路徑，那不算彩繪。
  v_is_artwork :=
    p_image_path is not null
    and (p_signature_path is null or p_image_path <> p_signature_path);

  -- 這台裝置簽過了：把這次帶來的圖補上去，不新增第二位
  select * into v_existing
    from public.participants p
   where p.event_id = p_event_id
     and p.device_token = p_device_token;

  if found then
    -- 第一次畫是 1，重畫一次變成 2。要送第三次就擋下來。
    if v_is_artwork and v_existing.artwork_count >= 2 then
      raise exception 'REDRAW_USED';
    end if;

    update public.participants p
       set image_path = coalesce(p_image_path, p.image_path),
           signature_path = coalesce(p_signature_path, p.signature_path),
           display_name = v_name,
           organization = coalesce(v_org, p.organization),
           seat_no = coalesce(v_seat, p.seat_no),
           artwork_count = p.artwork_count + case when v_is_artwork then 1 else 0 end,
           artwork_path = case when v_is_artwork then p_image_path else p.artwork_path end,
           artwork_stencil = case when v_is_artwork then v_stencil else p.artwork_stencil end,
           artwork_at = case when v_is_artwork then now() else p.artwork_at end
     where p.id = v_existing.id
    returning * into v_existing;

    return jsonb_build_object(
      'participant_id', v_existing.id,
      'image_path', v_existing.image_path,
      'signature_path', v_existing.signature_path,
      'artwork_count', v_existing.artwork_count,
      'already_joined', true
    );
  end if;

  begin
    insert into public.participants (
      id, event_id, display_name, character_name,
      image_path, signature_path, device_token, organization, seat_no,
      artwork_count, artwork_path, artwork_stencil, artwork_at
    )
    values (
      coalesce(p_participant_id, gen_random_uuid()), p_event_id, v_name, null,
      -- image_path 是 not null，只簽名沒彩繪時就讓兩欄都指向簽名，
      -- 大螢幕與抽獎那一套完全不必知道簽到模式的存在
      coalesce(p_image_path, p_signature_path), p_signature_path,
      p_device_token, v_org, v_seat,
      case when v_is_artwork then 1 else 0 end,
      case when v_is_artwork then p_image_path else null end,
      case when v_is_artwork then v_stencil else null end,
      case when v_is_artwork then now() else null end
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
        'artwork_count', v_existing.artwork_count,
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
    'artwork_count', v_existing.artwork_count,
    'already_joined', false
  );
end;
$$;

-- 舊的九參數版本要移掉，否則 PostgREST 會因為兩個同名函式而無法決定
-- 該呼叫哪一個（PGRST203）
drop function if exists public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text
);

revoke all on function public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text, text
) from public;
grant execute on function public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text, text
) to anon, authenticated;

-- ============================================================
-- 彩繪成果：誰畫了、挑了哪一張、什麼時候畫的
-- ============================================================

drop function if exists public.list_event_artworks(uuid);

create or replace function public.list_event_artworks(p_event_id uuid)
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
             p.artwork_path,
             p.artwork_stencil,
             p.artwork_at,
             p.artwork_count,
             p.joined_at,
             p.is_visible
        from public.participants p
       where p.event_id = p_event_id
         and p.artwork_path is not null
       order by p.artwork_at
    ) t;

  return v_result;
end;
$$;

revoke all on function public.list_event_artworks(uuid) from public;
grant execute on function public.list_event_artworks(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
