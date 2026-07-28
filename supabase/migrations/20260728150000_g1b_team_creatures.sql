-- G1b：每一隊一種海洋生物
--
-- 大螢幕上有幾組就有幾隻海洋生物，各自從起點游向終點的貓。
-- 生物種類存在隊伍上，手機與大螢幕才會畫出同一隻。
--
-- 沿用抽獎端既有的 11 種範本（src/lib/creatures/ocean.ts），
-- 不另外定義一套：同一場活動裡，參與者畫過的生物與遊戲中的生物
-- 是同一個世界的東西。
--
-- 此檔可重複執行。

alter table public.teams
  add column if not exists creature_key text not null default 'fish';

-- ============================================================
-- 建立場次時分配生物與顏色
-- ============================================================

create or replace function public.create_game_session(
  p_event_id   uuid,
  p_game_key   text,
  p_name       text,
  p_team_count int,
  p_config     jsonb default '{}'::jsonb
)
returns public.game_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_colors constant text[] := array[
    '#4fc3d9', '#f2963a', '#4caf6d', '#e8574c', '#8e5fd0',
    '#f4d03f', '#2f5fd0', '#f083b0', '#7ce0b8', '#ffb066'
  ];
  -- 順序刻意讓相鄰的兩桌長得很不一樣，大螢幕上才分得出誰是誰
  v_creatures constant text[] := array[
    'whale', 'crab', 'seahorse', 'shark', 'jellyfish',
    'turtle', 'pufferfish', 'octopus', 'starfish', 'fish'
  ];
  i int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  insert into public.game_sessions (event_id, game_key, name, config, status)
  values (p_event_id, p_game_key, btrim(p_name), coalesce(p_config, '{}'::jsonb), 'setup')
  returning * into v_session;

  for i in 1..greatest(1, least(coalesce(p_team_count, 1), 100)) loop
    insert into public.teams (session_id, table_no, name, join_code, color, creature_key)
    values (
      v_session.id,
      i,
      '第 ' || i || ' 桌',
      public.generate_team_code(),
      v_colors[1 + ((i - 1) % array_length(v_colors, 1))],
      v_creatures[1 + ((i - 1) % array_length(v_creatures, 1))]
    );
  end loop;

  return v_session;
end;
$$;

revoke execute on function public.create_game_session(uuid, text, text, int, jsonb) from public;
grant execute on function public.create_game_session(uuid, text, text, int, jsonb) to authenticated;

-- ============================================================
-- 查詢：補上 creature_key
-- ============================================================

-- 回傳型別變了，必須先移除才能重建
drop function if exists public.list_session_teams(uuid);

create or replace function public.list_session_teams(p_session_id uuid)
returns table (
  id uuid,
  table_no int,
  name text,
  join_code text,
  color text,
  creature_key text,
  player_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.table_no, t.name, t.join_code, t.color, t.creature_key, t.player_count
    from public.teams t
   where t.session_id = p_session_id
   order by t.table_no;
$$;

revoke execute on function public.list_session_teams(uuid) from public;
grant execute on function public.list_session_teams(uuid) to anon, authenticated;

-- ============================================================
-- 入座：回傳這一隊的生物
-- ============================================================

drop function if exists public.join_game(text, text, text);

create or replace function public.join_game(
  p_join_code    text,
  p_device_token text,
  p_display_name text
)
returns table (
  session_id uuid,
  session_status text,
  game_key text,
  team_id uuid,
  team_name text,
  team_color text,
  team_creature text,
  table_no int,
  player_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team public.teams;
  v_session public.game_sessions;
  v_player public.game_players;
  v_participant_id uuid;
begin
  select * into v_team from public.teams t
   where t.join_code = upper(btrim(p_join_code));

  if v_team.id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_team.session_id;

  if v_session.status = 'finished' then
    raise exception 'SESSION_FINISHED';
  end if;

  -- 若這台裝置已經在這場活動畫過角色，遊戲中就用那個角色
  select p.id into v_participant_id
    from public.participants p
   where p.event_id = v_session.event_id
     and p.device_token = p_device_token
   limit 1;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;

  if v_player.id is null then
    insert into public.game_players
      (session_id, team_id, device_token, display_name, participant_id)
    values
      (v_session.id, v_team.id, p_device_token, btrim(p_display_name), v_participant_id)
    returning * into v_player;
  else
    -- 換桌：更新隊伍與姓名，觸發器會同步兩邊人數
    update public.game_players
       set team_id = v_team.id,
           display_name = btrim(p_display_name),
           participant_id = coalesce(v_participant_id, participant_id)
     where id = v_player.id
    returning * into v_player;
  end if;

  return query
    select v_session.id, v_session.status, v_session.game_key,
           v_team.id, v_team.name, v_team.color, v_team.creature_key,
           v_team.table_no, v_player.id;
end;
$$;

revoke execute on function public.join_game(text, text, text) from public;
grant execute on function public.join_game(text, text, text) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
select
  case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'teams'
       and column_name = 'creature_key'
  ) then '已建立' else '缺少' end as "teams.creature_key";
