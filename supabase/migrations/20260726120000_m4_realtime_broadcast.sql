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

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
-- 少了這一行，新建立的函式要等快取自然過期才會生效，
-- 前端會收到「找不到函式 ...（schema cache）」。
notify pgrst, 'reload schema';
