-- C27：把人請出去
--
-- 現在完全沒有辦法移除已經入座的人。現場一定會遇到的三件事：
--
--   掃錯桌卡。第 7 桌的人掃到第 8 桌那一張，坐進了別人的隊伍。
--             他自己重掃也沒用——join_game 認的是裝置，
--             同一支手機在同一場只會有一個座位。
--   彩排沒清。活動前試玩留下來的假玩家還坐在裡面，
--             人數與排行榜從第一題就是錯的。
--   有人走了。中途離席的人一直掛在名單上，
--             「已作答 18／25」永遠到不了滿。
--
-- 兩支函式：
--
--   remove_game_player   踢一個人。他在這場的作答、投票、訊息會跟著走
--                        （外鍵 cascade）——掃錯桌的人在錯的隊伍裡拿的分數
--                        本來就不該留著。踢完他重掃桌卡就能重新入座。
--   reset_game_players   整場清空，回到「一個人都還沒進來」。
--                        這是彩排完要做的事，破壞性很大，
--                        所以要把場次名稱一起送上來對過。
--
-- teams.player_count 由既有的 game_players_sync_count 觸發器維護，
-- 它本來就處理 DELETE，不必另外扣。
--
-- 踢掉桌長不自動遞補。誰當桌長是那一桌自己的事，系統挑一個人硬塞給他們
-- 只會讓那一桌一頭霧水；後台的桌長名單本來就能一秒改派。
--
-- 此檔可重複執行。

drop function if exists public.remove_game_player(uuid);

create or replace function public.remove_game_player(p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_was_captain boolean;
  v_name text;
begin
  select * into v_player from public.game_players gp where gp.id = p_player_id;

  if v_player.id is null then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  -- 不是自己活動底下的人：一律當成找不到，不透露他存不存在
  if not exists (
    select 1
      from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = v_player.session_id and e.host_id = auth.uid()
  ) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  v_was_captain := v_player.is_captain;
  v_name := v_player.display_name;

  delete from public.game_players where id = p_player_id;

  return jsonb_build_object(
    'display_name', v_name,
    -- 踢掉的是桌長的話要講出來，那一桌現在沒有人能按了
    'was_captain', v_was_captain
  );
end;
$$;

revoke all on function public.remove_game_player(uuid) from public;
grant execute on function public.remove_game_player(uuid) to authenticated;

-- ============================================================
-- 整場清空
-- ============================================================

drop function if exists public.reset_game_players(uuid, text);

create or replace function public.reset_game_players(
  p_session_id uuid,
  p_name       text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_removed int;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;

  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.events e
     where e.id = v_session.event_id and e.host_id = auth.uid()
  ) then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  -- 跟刪場次同一套：名稱對不上就是打錯了。這一下會把所有人與所有
  -- 分數一起清掉，不能只靠一個「你確定嗎」。
  if btrim(coalesce(p_name, '')) <> btrim(v_session.name) then
    raise exception 'NAME_MISMATCH';
  end if;

  select count(*)::int into v_removed
    from public.game_players where session_id = p_session_id;

  -- 作答、投票、訊息都掛在玩家或場次底下，外鍵會帶走。
  -- 題目不動——清的是人，不是這場的題庫。
  delete from public.game_players where session_id = p_session_id;

  return v_removed;
end;
$$;

revoke all on function public.reset_game_players(uuid, text) from public;
grant execute on function public.reset_game_players(uuid, text) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
