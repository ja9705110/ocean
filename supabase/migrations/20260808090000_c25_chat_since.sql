-- C25：聊天室的保險輪詢只拿新的
--
-- 量出來的數字：一次 list_table_messages 帶回 50 則訊息是 9.3 KB。
-- 保險輪詢是六秒一次，280 支手機就是
--
--     280 ÷ 6 × 9.3 KB ≈ 436 KB／秒
--
-- 而且絕大多數時候那 50 則一個字都沒變——同一份東西一直重送。
--
-- 這在兩個地方會痛：
--
--   免費版的流量額度。一場四十分鐘的問答光聊天室就吃掉大約 1 GB。
--   場館的 Wi-Fi。280 支手機共用一條線，這是實實在在的頻寬。
--
-- 而且會落到保險輪詢的，正好是連線數超過上限、接不到即時推播的那幾十支
-- 手機——最需要省的那幾支，反而是最花的。
--
-- 加一個 p_since：只要「這個時間之後的」。沒有新訊息就回一個空陣列，
-- 大約 100 位元組。第一次載入不帶 since，照樣拿完整的歷史。
--
-- 此檔可重複執行。

drop function if exists public.list_table_messages(uuid, text, int);
drop function if exists public.list_table_messages(uuid, text, int, timestamptz);

create or replace function public.list_table_messages(
  p_session_id   uuid,
  p_device_token text,
  p_limit        int default 50,
  p_since        timestamptz default null
)
returns jsonb
language plpgsql
stable
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
         -- 帶了 since 就只要新的。這是保險輪詢的常態，
         -- 而且常態的答案是「沒有新的」——回一個空陣列就好。
         and (p_since is null or tm.created_at > p_since)
       order by tm.created_at desc
       limit v_limit
    ) x;

  return jsonb_build_object(
    'team_id', v_player.team_id,
    'my_player_id', v_player.id,
    'i_am_captain', v_player.is_captain,
    -- 呼叫端要知道這是增量還是全量，才知道該接上去還是整個換掉
    'incremental', p_since is not null,
    'messages', v_rows
  );
end;
$$;

revoke execute on function public.list_table_messages(uuid, text, int, timestamptz)
  from public;
grant execute on function public.list_table_messages(uuid, text, int, timestamptz)
  to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
