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

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
