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

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
