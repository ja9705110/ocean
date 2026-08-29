-- C28：重畫之後大螢幕自己換掉那張圖
--
-- 現在重畫完，大螢幕要整頁重新整理才看得到新的。追下去是兩層都擋住：
--
--   1. 觸發器寫的是 `update of is_visible`。重畫改的是 image_path，
--      is_visible 一個字都沒動——所以觸發器根本不會被叫到，
--      廣播從來沒有發出去過。
--
--   2. 就算發出去了，函式裡第一件事是
--          if old.is_visible = new.is_visible then return new; end if;
--      也會直接略過。那個判斷原本的用意是「只關心顯示／隱藏」，
--      在只有隱藏功能的時候是對的，有了重畫就不對了。
--
-- （前端還有第三層：reconcile 對已經在畫面上的 id 會略過，
--   所以連三十秒一次的保險對帳也補不上。那一層在 WorldRenderer 修。）
--
-- 改法：觸發器改成也監看 image_path 與 signature_path，
-- 函式多一條分支——still visible 但圖換了，就發 participant:updated。
--
-- 為什麼是新的事件名而不是重用 participant:joined：
-- 收到 joined 的人會播進場動畫並且新增一隻角色，
-- 而這裡要做的是「同一隻角色換一張圖」。兩件事分開，
-- 前端才能各自決定要怎麼演。
--
-- 此檔可重複執行。

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
      'signature_path', new.signature_path,
      'joined_at', new.joined_at
    );
    v_topic := 'event:' || new.event_id;

  elsif tg_op = 'UPDATE' then
    if old.is_visible <> new.is_visible then
      if new.is_visible then
        -- 主持人取消隱藏：以完整資料重新進場
        v_event := 'participant:joined';
        v_payload := jsonb_build_object(
          'id', new.id,
          'display_name', new.display_name,
          'character_name', new.character_name,
          'image_path', new.image_path,
          'signature_path', new.signature_path,
          'joined_at', new.joined_at
        );
      else
        -- 主持人隱藏：大螢幕即時移除（規格第 16 節第 4 點）
        v_event := 'participant:removed';
        v_payload := jsonb_build_object('id', new.id);
      end if;

    elsif new.is_visible
      and (old.image_path is distinct from new.image_path
        or old.signature_path is distinct from new.signature_path)
    then
      -- 重畫：同一個人、同一隻角色，換一張圖（C28）
      v_event := 'participant:updated';
      v_payload := jsonb_build_object(
        'id', new.id,
        'display_name', new.display_name,
        'character_name', new.character_name,
        'image_path', new.image_path,
        'signature_path', new.signature_path,
        'joined_at', new.joined_at
      );

    else
      -- 其他欄位的變動（改名字、補執業單位）大螢幕上看不出來，不必打擾它
      return new;
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

-- 監看的欄位要跟著加，否則改了 image_path 這支函式根本不會被呼叫
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
