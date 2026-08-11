-- Q3：隊長代表賽
--
-- 第三種計分方式：每桌推派一位隊長，只有隊長的手機能按，
-- 隊長的分數就是全桌的分數。
--
-- 三種模式的差別只在「誰能按」與「分數怎麼加總」，題目、計時、
-- 公布流程完全共用：
--   individual 每個人自己按，看個人排行
--   team       每個人自己按，同桌加總
--   captain    只有隊長能按，隊長的分數就是該桌的分數
--
-- 隊長採先搶先贏：現場沒有人有空等主持人一桌一桌指定，
-- 而「誰先按誰就是」本身就是很自然的推派方式。主持人仍然可以改。
--
-- 此檔可重複執行。

alter table public.game_players
  add column if not exists is_captain boolean not null default false;

-- 一桌只能有一位隊長。用部分唯一索引而不是檢查約束：
-- 這是跨列的限制，只有索引擋得住兩支手機同時搶的競態。
create unique index if not exists game_players_one_captain_per_team
  on public.game_players (team_id)
  where is_captain;

-- ============================================================
-- 搶隊長（匿名）
-- ============================================================

-- 回傳這一桌目前的隊長是誰。搶輸了不算錯誤——
-- 現場兩個人同時按是常態，跳錯誤訊息只會讓人以為壞掉。
create or replace function public.claim_captain(
  p_session_id   uuid,
  p_device_token text
)
returns table (captain_player_id uuid, captain_name text, i_am_captain boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_existing public.game_players;
begin
  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;

  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select * into v_existing from public.game_players gp
   where gp.team_id = v_player.team_id and gp.is_captain;

  if v_existing.id is null then
    begin
      update public.game_players set is_captain = true where id = v_player.id;
      v_existing := v_player;
    exception when unique_violation then
      -- 同一瞬間有人搶贏了，重讀一次即可
      select * into v_existing from public.game_players gp
       where gp.team_id = v_player.team_id and gp.is_captain;
    end;
  end if;

  return query select
    v_existing.id,
    v_existing.display_name,
    v_existing.id = v_player.id;
end;
$$;

revoke execute on function public.claim_captain(uuid, text) from public;
grant execute on function public.claim_captain(uuid, text) to anon, authenticated;

-- 主持人改派隊長。現場常見的狀況是隊長手機沒電或臨時離席。
create or replace function public.set_team_captain(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
begin
  select gp.team_id into v_team_id
    from public.game_players gp
    join public.game_sessions s on s.id = gp.session_id
    join public.events e on e.id = s.event_id
   where gp.id = p_player_id and e.host_id = auth.uid();

  if v_team_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 先卸任再上任，否則會撞到「一桌一位」的唯一索引
  update public.game_players set is_captain = false
   where team_id = v_team_id and is_captain;
  update public.game_players set is_captain = true where id = p_player_id;
end;
$$;

revoke execute on function public.set_team_captain(uuid) from public;
grant execute on function public.set_team_captain(uuid) to authenticated;

-- ============================================================
-- 換桌時卸任
-- ============================================================

-- 隊長換到別桌時要先卸任，否則新桌若已有隊長會撞到唯一索引，
-- 整個 join_game 會失敗——現場表現為「掃了碼卻進不去」。
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
  v_keep_captain boolean;
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
    -- 先算好再寫。不能在 set 裡直接寫 team_id：這支函式的回傳欄位
    -- 也叫 team_id，PL/pgSQL 分不出你指的是欄位還是回傳變數，
    -- 會直接報 ambiguous 而讓整個入座失敗——現場表現為「掃了碼卻進不去」。
    v_keep_captain := v_player.team_id = v_team.id and v_player.is_captain;

    update public.game_players
       set team_id = v_team.id,
           display_name = btrim(p_display_name),
           participant_id = coalesce(v_participant_id, participant_id),
           is_captain = v_keep_captain
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
-- 隊員清單補上隊長標記
-- ============================================================

drop function if exists public.list_team_players(uuid);

create or replace function public.list_team_players(p_team_id uuid)
returns table (
  id uuid,
  display_name text,
  participant_id uuid,
  is_captain boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select gp.id, gp.display_name, gp.participant_id, gp.is_captain
    from public.game_players gp
   where gp.team_id = p_team_id
   order by gp.is_captain desc, gp.joined_at;
$$;

revoke execute on function public.list_team_players(uuid) from public;
grant execute on function public.list_team_players(uuid) to anon, authenticated;

-- ============================================================
-- 作答資格
-- ============================================================

drop function if exists public.submit_quiz_answer(uuid, text, int);

create or replace function public.submit_quiz_answer(
  p_question_id  uuid,
  p_device_token text,
  p_choice_index int
)
returns table (accepted boolean, elapsed_ms int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q public.quiz_questions;
  v_session public.game_sessions;
  v_player public.game_players;
  v_open_at timestamptz;
  v_elapsed int;
  v_limit int;
  v_correct boolean;
  v_points int;
begin
  if p_choice_index is null or p_choice_index < 0 or p_choice_index > 3 then
    raise exception 'INVALID_CHOICE';
  end if;

  select * into v_q from public.quiz_questions q where q.id = p_question_id;
  if v_q.id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  select * into v_session from public.game_sessions s where s.id = v_q.session_id;

  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  if v_session.phase = 'idle' then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  -- 隊長代表賽：資格檢查一定要在伺服器端。前端把按鈕藏起來只是介面，
  -- 任何人都能直接呼叫這支函式。
  if coalesce(v_session.config->>'mode', 'team') = 'captain'
     and not v_player.is_captain then
    raise exception 'NOT_CAPTAIN';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  if v_elapsed > v_limit + public.quiz_answer_grace_ms() then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  insert into public.quiz_answers
    (session_id, question_id, player_id, team_id, choice_index,
     elapsed_ms, is_correct, points)
  values
    (v_session.id, p_question_id, v_player.id, v_player.team_id, p_choice_index,
     v_elapsed, v_correct, v_points)
  on conflict (question_id, player_id) do nothing;

  return query select true, v_elapsed;
end;
$$;

revoke execute on function public.submit_quiz_answer(uuid, text, int) from public;
grant execute on function public.submit_quiz_answer(uuid, text, int) to anon, authenticated;

-- ============================================================
-- 手機端狀態：補上模式與隊長資訊
-- ============================================================

drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  mode           text,
  i_am_captain   boolean,
  captain_name   text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  my_choice      int,
  correct_index  int,
  my_points      int,
  my_total       int
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    coalesce(s.config->>'mode', 'team'),
    coalesce(gp.is_captain, false),
    (select c.display_name from public.game_players c
      where c.team_id = gp.team_id and c.is_captain limit 1),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when p.effective in ('reveal', 'scoreboard')
         then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard')
         then a.points else null end,
    -- 隊長代表賽時，手機上顯示的是全桌的分數，因為那才是「我們的」成績
    case when coalesce(s.config->>'mode', 'team') = 'captain'
         then (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t where t.team_id = gp.team_id)
         else (select coalesce(sum(t.points), 0)::int
                 from public.quiz_answers t
                where t.session_id = s.id and t.player_id = gp.id)
    end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕：作答進度要按模式計算分母
-- ============================================================

drop function if exists public.get_quiz_stage_state(uuid);

create or replace function public.get_quiz_stage_state(p_session_id uuid)
returns table (
  phase          text,
  session_name   text,
  mode           text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  image_url      text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
  reveal_seconds int,
  started_at_ms  bigint,
  server_ms      bigint,
  answered_count int,
  player_count   int,
  correct_index  int,
  option_counts  int[]
)
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select
    p.effective,
    s.name,
    m.mode,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when p.effective = 'idle' then null else q.prompt end,
    case when p.effective = 'idle' then null else q.image_url end,
    case when p.effective = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    q.reveal_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    -- 分母是「有資格作答的人數」：隊長代表賽時是有隊長的桌數，
    -- 否則是入座人數。用錯分母會讓大螢幕永遠顯示不到滿
    case when m.mode = 'captain'
         then (select count(*)::int from public.game_players gp
                where gp.session_id = s.id and gp.is_captain)
         else (select count(*)::int from public.game_players gp
                where gp.session_id = s.id)
    end,
    case when p.effective in ('reveal', 'scoreboard') then q.correct_index else null end,
    case when p.effective in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  cross join lateral (select coalesce(s.config->>'mode', 'team') as mode) m
  cross join lateral (
    select public.quiz_phase_at(
      s.phase,
      case when s.started_at is null or q.id is null then null
           else (extract(epoch from (clock_timestamp() - s.started_at)) * 1000)::bigint end,
      coalesce(q.prep_seconds, 0),
      coalesce(q.answer_seconds, 0),
      coalesce(q.reveal_seconds, 0)
    ) as effective
  ) p
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');

-- ============================================================
-- 驗證
-- ============================================================
select
  case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'game_players'
       and column_name = 'is_captain'
  ) then '已建立' else '缺少' end as "game_players.is_captain",
  case when exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'game_players_one_captain_per_team'
  ) then '已建立' else '缺少' end as "一桌一位隊長的索引";
