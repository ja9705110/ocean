-- G0：遊戲房間與隊伍
--
-- Party Game 模式的資料基礎。與抽獎共用同一個 events：
-- 一場活動可以先玩遊戲、再抽獎，用同一份參與者名單。
--
-- 設計要點：
-- 1. 遊戲進行中的即時狀態「不寫資料庫」。每秒 250 筆寫入會打爆連線池，
--    也沒有必要——即時狀態靠 Realtime 廣播，資料庫只在回合結束時
--    記錄結果。
-- 2. 隊伍有自己的加入碼，每桌一張 QR Code，玩家掃了就直接進該隊，
--    現場不必選、不會選錯。
-- 3. game_players 與 participants 是可選的關聯：玩家可以先玩遊戲、
--    還沒畫角色；畫過角色的人則會在船上看到自己的角色。
--
-- 此檔可重複執行。

-- ============================================================
-- 遊戲場次
-- ============================================================

create table if not exists public.game_sessions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  game_key    text not null,                    -- 對應程式碼中的遊戲模組
  name        text not null,
  config      jsonb not null default '{}'::jsonb,  -- 該遊戲的設定（時間、回合、BPM…）
  status      text not null default 'setup',    -- setup | lobby | countdown | playing | finished
  round_no    int  not null default 0,
  started_at  timestamptz,                      -- 本回合的開始時間，節拍由此推算
  created_at  timestamptz not null default now(),

  constraint game_sessions_status_valid
    check (status in ('setup', 'lobby', 'countdown', 'playing', 'finished')),
  constraint game_sessions_name_length
    check (char_length(btrim(name)) between 1 and 60)
);

create index if not exists game_sessions_event_idx
  on public.game_sessions (event_id, created_at desc);

-- ============================================================
-- 隊伍
-- ============================================================

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.game_sessions(id) on delete cascade,
  table_no    int  not null,                    -- 桌號，現場對照用
  name        text not null,
  join_code   text not null,                    -- 每桌一組，用於 QR Code
  color       text not null default '#4fc3d9',  -- 大螢幕上的隊伍識別色
  player_count int not null default 0,          -- 由觸發器維護
  created_at  timestamptz not null default now(),

  unique (session_id, table_no),
  unique (join_code),
  constraint teams_table_no_positive check (table_no between 1 and 200),
  constraint teams_name_length check (char_length(btrim(name)) between 1 and 40)
);

create index if not exists teams_session_idx
  on public.teams (session_id, table_no);

-- ============================================================
-- 玩家
-- ============================================================

create table if not exists public.game_players (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.game_sessions(id) on delete cascade,
  team_id        uuid not null references public.teams(id) on delete cascade,
  device_token   text not null,                 -- 與抽獎端共用同一組
  display_name   text not null,
  participant_id uuid references public.participants(id) on delete set null,
  joined_at      timestamptz not null default now(),

  unique (session_id, device_token),            -- 一台裝置一場遊戲只能一個位置
  constraint game_players_name_length
    check (char_length(btrim(display_name)) between 1 and 30)
);

create index if not exists game_players_team_idx
  on public.game_players (team_id);

-- ============================================================
-- 回合結果
-- ============================================================

create table if not exists public.team_results (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.game_sessions(id) on delete cascade,
  team_id       uuid not null references public.teams(id) on delete cascade,
  round_no      int  not null,
  rank          int,
  finish_ms     int,                            -- 完成時間，未完賽為 null
  sync_rate     numeric(5, 4),                  -- 平均同步率 0~1
  miss_count    int  not null default 0,
  metrics       jsonb not null default '{}'::jsonb,  -- 各遊戲自訂的額外數據
  recorded_at   timestamptz not null default now(),

  unique (session_id, team_id, round_no)
);

create index if not exists team_results_session_idx
  on public.team_results (session_id, round_no, rank);

-- ============================================================
-- 觸發器：維護隊伍人數
-- ============================================================

create or replace function public.sync_team_player_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.teams set player_count = player_count + 1 where id = new.team_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.teams set player_count = greatest(0, player_count - 1) where id = old.team_id;
    return old;
  elsif tg_op = 'UPDATE' and old.team_id is distinct from new.team_id then
    update public.teams set player_count = greatest(0, player_count - 1) where id = old.team_id;
    update public.teams set player_count = player_count + 1 where id = new.team_id;
    return new;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists game_players_sync_count on public.game_players;
create trigger game_players_sync_count
  after insert or update of team_id or delete on public.game_players
  for each row execute function public.sync_team_player_count();

-- ============================================================
-- RLS
-- ============================================================

alter table public.game_sessions enable row level security;
alter table public.teams         enable row level security;
alter table public.game_players  enable row level security;
alter table public.team_results  enable row level security;

drop policy if exists game_sessions_public_read on public.game_sessions;
drop policy if exists game_sessions_host_all    on public.game_sessions;
drop policy if exists teams_public_read         on public.teams;
drop policy if exists teams_host_all            on public.teams;
drop policy if exists game_players_host_all     on public.game_players;
drop policy if exists team_results_public_read  on public.team_results;

-- 場次與隊伍：匿名唯讀（大螢幕與手機都要顯示隊伍資訊）
create policy game_sessions_public_read on public.game_sessions
  for select to anon, authenticated using (true);

create policy game_sessions_host_all on public.game_sessions
  for all to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()))
  with check (exists (select 1 from public.events e where e.id = event_id and e.host_id = auth.uid()));

create policy teams_public_read on public.teams
  for select to anon, authenticated using (true);

create policy teams_host_all on public.teams
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 玩家名單：匿名端完全不能直接讀寫。
-- 加入走 join_game() RPC（需要驗證加入碼），查詢走 list_team_players()。
-- 直接開放 select 會讓任何人拉走全場的 device_token 與姓名。
create policy game_players_host_all on public.game_players
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 成績：全端唯讀，手機也要看得到排行榜
create policy team_results_public_read on public.team_results
  for select to anon, authenticated using (true);

-- ============================================================
-- 建立遊戲場次（含隊伍）
-- ============================================================

create or replace function public.generate_team_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from public.teams t where t.join_code = v_code);

    v_attempt := v_attempt + 1;
    if v_attempt > 80 then
      raise exception 'CODE_GENERATION_FAILED';
    end if;
  end loop;

  return v_code;
end;
$$;

-- 一次建立場次與所有隊伍。分開建立會讓「建到一半失敗」留下半套資料，
-- 現場沒有時間排查這種狀態。
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
    insert into public.teams (session_id, table_no, name, join_code, color)
    values (
      v_session.id,
      i,
      '第 ' || i || ' 桌',
      public.generate_team_code(),
      v_colors[1 + ((i - 1) % array_length(v_colors, 1))]
    );
  end loop;

  return v_session;
end;
$$;

revoke execute on function public.create_game_session(uuid, text, text, int, jsonb) from public;
grant execute on function public.create_game_session(uuid, text, text, int, jsonb) to authenticated;

-- ============================================================
-- 玩家加入（匿名）
-- ============================================================

-- 以加入碼換取隊伍席位。碼即權限——掃到哪張 QR 就進哪一隊。
-- 同一台裝置重複加入會回傳既有席位而不是報錯：現場重整頁面很常見。
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
           v_team.id, v_team.name, v_team.color, v_team.table_no, v_player.id;
end;
$$;

revoke execute on function public.join_game(text, text, text) from public;
grant execute on function public.join_game(text, text, text) to anon, authenticated;

-- ============================================================
-- 查詢
-- ============================================================

-- 隊伍清單與人數，供大螢幕與主持人使用。不含 device_token。
create or replace function public.list_session_teams(p_session_id uuid)
returns table (
  id uuid,
  table_no int,
  name text,
  join_code text,
  color text,
  player_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.table_no, t.name, t.join_code, t.color, t.player_count
    from public.teams t
   where t.session_id = p_session_id
   order by t.table_no;
$$;

revoke execute on function public.list_session_teams(uuid) from public;
grant execute on function public.list_session_teams(uuid) to anon, authenticated;

-- 某一隊的成員，讓玩家在手機上看到隊友已就位
create or replace function public.list_team_players(p_team_id uuid)
returns table (id uuid, display_name text, participant_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gp.id, gp.display_name, gp.participant_id
    from public.game_players gp
   where gp.team_id = p_team_id
   order by gp.joined_at;
$$;

revoke execute on function public.list_team_players(uuid) from public;
grant execute on function public.list_team_players(uuid) to anon, authenticated;

-- 主持人的場次清單
create or replace function public.list_event_game_sessions(p_event_id uuid)
returns table (
  id uuid,
  game_key text,
  name text,
  status text,
  round_no int,
  config jsonb,
  team_count bigint,
  player_count bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id, s.game_key, s.name, s.status, s.round_no, s.config,
    (select count(*) from public.teams t where t.session_id = s.id),
    (select count(*) from public.game_players gp where gp.session_id = s.id),
    s.created_at
  from public.game_sessions s
  where s.event_id = p_event_id
    and exists (select 1 from public.events e where e.id = p_event_id and e.host_id = auth.uid())
  order by s.created_at desc;
$$;

revoke execute on function public.list_event_game_sessions(uuid) from public;
grant execute on function public.list_event_game_sessions(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
with expected(fn) as (
  values ('create_game_session'), ('join_game'), ('list_session_teams'),
         ('list_team_players'), ('list_event_game_sessions'), ('generate_team_code')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by e.fn;
