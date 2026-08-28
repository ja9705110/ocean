-- C21：一支手機只能重畫一次彩繪
--
-- 彩繪可以晚一點再畫——報到台前面排著隊，沒有人有時間當場塗鴉，
-- 所以簽完名先放行，入座之後再回來畫。這條路一直是開著的，
-- 也就表示同一支手機可以一直重送新的彩繪。
--
-- 現場會變成這樣：有人畫完覺得不滿意，再畫一次、再一次、再一次。
-- 每一次都是兩張新圖上傳到儲存空間，而大螢幕上那條河會一直在換。
-- 給一次重來的機會就夠了：第一次是「先交出來」，第二次是「認真畫」。
--
-- 為什麼要記在資料庫而不是瀏覽器裡：瀏覽器裡的紀錄清掉就沒了，
-- 而清瀏覽資料是現場最容易做到的事。這一欄跟著人走，不跟著手機走。
--
-- 只算彩繪。簽名補送、回頭改名字、補填執業單位都不佔次數——
-- 那些不是「重畫」。
--
-- 此檔可重複執行。

alter table public.participants
  add column if not exists artwork_count int not null default 0;

comment on column public.participants.artwork_count is
  '送出過幾次彩繪。第一次是 1，重畫一次變成 2，上限就是 2。';

-- ============================================================
-- 重寫 check_in_signature：多一道彩繪次數的檢查
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
  v_is_artwork boolean;
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
           artwork_count = p.artwork_count + case when v_is_artwork then 1 else 0 end
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
      artwork_count
    )
    values (
      coalesce(p_participant_id, gen_random_uuid()), p_event_id, v_name, null,
      -- image_path 是 not null，只簽名沒彩繪時就讓兩欄都指向簽名，
      -- 大螢幕與抽獎那一套完全不必知道簽到模式的存在
      coalesce(p_image_path, p_signature_path), p_signature_path,
      p_device_token, v_org, v_seat,
      case when v_is_artwork then 1 else 0 end
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

revoke all on function public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text
) from public;
grant execute on function public.check_in_signature(
  uuid, uuid, text, text, text, text, text, uuid, text
) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
