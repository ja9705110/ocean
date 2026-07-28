-- Q0：海洋問答（Kahoot 形式）
--
-- 主持人出題，大螢幕顯示題目與四個選項，玩家在手機上按對應的海洋生物。
-- 可以個人計分，也可以按桌加總成分組競賽。
--
-- 三個不可退讓的設計：
--
-- 1. 正確答案在公布之前絕對不能送到手機。任何人打開開發者工具就看得到
--    網路回應，因此 quiz_questions 對匿名端完全關閉，一切走 RPC，
--    而給手機的 RPC 在公布前不回傳 correct_index。
--
-- 2. 作答時間由伺服器計算，手機不送時間戳。讓前端報時間等於把計分權
--    交給玩家——改一下系統時間就永遠滿分。
--
-- 3. 作答視窗以題目的 started_at 推算，與 phase 無關。主持人晚一點按
--    「公布答案」不該讓遲到的作答變成有效，phase 只管畫面顯示。
--
-- 此檔可重複執行。
--
-- 所有 returns table 的函式一律先 drop 再建：Postgres 不允許用
-- create or replace 改變回傳型別，只要後面的 migration 加了一個欄位，
-- 這一份第二次執行就會整個中斷。

-- ============================================================
-- 題目
-- ============================================================

create table if not exists public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.game_sessions(id) on delete cascade,
  ordinal        int  not null,                 -- 出題順序（position 是 Postgres 保留字，不能當欄位名用在 order by）
  prompt         text not null,
  options        text[] not null,               -- 固定四個，對應四種海洋生物
  correct_index  int  not null,                 -- 0~3
  prep_seconds   int  not null default 5,       -- 開始作答前的準備時間
  answer_seconds int  not null default 20,
  points         int  not null default 1000,    -- 秒答的滿分
  created_at     timestamptz not null default now(),

  unique (session_id, ordinal),
  constraint quiz_questions_options_count
    check (array_length(options, 1) = 4),
  constraint quiz_questions_correct_range
    check (correct_index between 0 and 3),
  constraint quiz_questions_prompt_length
    check (char_length(btrim(prompt)) between 1 and 300),
  constraint quiz_questions_prep_range
    check (prep_seconds between 0 and 60),
  constraint quiz_questions_answer_range
    check (answer_seconds between 5 and 180),
  constraint quiz_questions_points_range
    check (points between 100 and 10000)
);

create index if not exists quiz_questions_session_idx
  on public.quiz_questions (session_id, ordinal);

-- ============================================================
-- 作答
-- ============================================================

create table if not exists public.quiz_answers (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.game_sessions(id) on delete cascade,
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  player_id   uuid not null references public.game_players(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  choice_index int not null,
  elapsed_ms  int  not null,                    -- 從開放作答到按下去的毫秒
  is_correct  boolean not null,
  points      int  not null default 0,
  answered_at timestamptz not null default now(),

  -- 一題只能答一次，按下去就不能改
  unique (question_id, player_id),
  constraint quiz_answers_choice_range check (choice_index between 0 and 3)
);

create index if not exists quiz_answers_question_idx
  on public.quiz_answers (question_id);
create index if not exists quiz_answers_session_player_idx
  on public.quiz_answers (session_id, player_id);

-- ============================================================
-- 場次上的問答進度
-- ============================================================

alter table public.game_sessions
  add column if not exists current_question_id uuid
    references public.quiz_questions(id) on delete set null;

alter table public.game_sessions
  add column if not exists phase text not null default 'idle';

do $$
begin
  alter table public.game_sessions
    add constraint game_sessions_phase_valid
    check (phase in ('idle', 'prep', 'answer', 'reveal', 'scoreboard'));
exception when duplicate_object then null;
end $$;

-- ============================================================
-- RLS
-- ============================================================

alter table public.quiz_questions enable row level security;
alter table public.quiz_answers   enable row level security;

drop policy if exists quiz_questions_host_all on public.quiz_questions;
drop policy if exists quiz_answers_host_read  on public.quiz_answers;

-- 題目只有主持人能碰。匿名端連 select 都不給——
-- 開放讀取就等於把正確答案公開，遊戲直接失去意義。
create policy quiz_questions_host_all on public.quiz_questions
  for all to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()))
  with check (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- 作答紀錄同理：能讀就能反推別人選什麼
create policy quiz_answers_host_read on public.quiz_answers
  for select to authenticated
  using (exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = session_id and e.host_id = auth.uid()));

-- ============================================================
-- 出題（主持人）
-- ============================================================

drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000
)
returns public.quiz_questions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.quiz_questions;
  v_ordinal int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_question_id is not null then
    update public.quiz_questions
       set prompt         = btrim(p_prompt),
           options        = p_options,
           correct_index  = p_correct_index,
           prep_seconds   = p_prep_seconds,
           answer_seconds = p_answer_seconds,
           points         = p_points
     where id = p_question_id and session_id = p_session_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'QUESTION_NOT_FOUND';
    end if;
    return v_row;
  end if;

  select coalesce(max(q.ordinal), 0) + 1 into v_ordinal
    from public.quiz_questions q where q.session_id = p_session_id;

  insert into public.quiz_questions
    (session_id, ordinal, prompt, options, correct_index,
     prep_seconds, answer_seconds, points)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int) to authenticated;

-- 刪題之後把順序補回連續，否則之後新增的題目會插在奇怪的位置
create or replace function public.delete_quiz_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
begin
  select q.session_id into v_session_id
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.quiz_questions where id = p_question_id;

  with renumbered as (
    select id, row_number() over (order by ordinal) as rn
      from public.quiz_questions where session_id = v_session_id
  )
  update public.quiz_questions q
     set ordinal = r.rn
    from renumbered r
   where q.id = r.id and q.ordinal is distinct from r.rn;
end;
$$;

revoke execute on function public.delete_quiz_question(uuid) from public;
grant execute on function public.delete_quiz_question(uuid) to authenticated;

-- 上下移動一題
create or replace function public.move_quiz_question(
  p_question_id uuid,
  p_direction   int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_ordinal int;
  v_other_id uuid;
  v_other_ordinal int;
begin
  select q.session_id, q.ordinal into v_session_id, v_ordinal
    from public.quiz_questions q
    join public.game_sessions s on s.id = q.session_id
    join public.events e on e.id = s.event_id
   where q.id = p_question_id and e.host_id = auth.uid();

  if v_session_id is null then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if p_direction < 0 then
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal < v_ordinal
     order by ordinal desc limit 1;
  else
    select id, ordinal into v_other_id, v_other_ordinal
      from public.quiz_questions
     where session_id = v_session_id and ordinal > v_ordinal
     order by ordinal asc limit 1;
  end if;

  if v_other_id is null then
    return;  -- 已經在頭或尾，不是錯誤
  end if;

  -- 唯一索引擋著不能直接對調，先借一個不會撞到的暫時值
  update public.quiz_questions set ordinal = -1 where id = p_question_id;
  update public.quiz_questions set ordinal = v_ordinal where id = v_other_id;
  update public.quiz_questions set ordinal = v_other_ordinal where id = p_question_id;
end;
$$;

revoke execute on function public.move_quiz_question(uuid, int) from public;
grant execute on function public.move_quiz_question(uuid, int) to authenticated;

-- 主持人的題目清單（含正確答案）
drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  options text[],
  correct_index int,
  prep_seconds int,
  answer_seconds int,
  points int,
  answer_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    q.id, q.ordinal, q.prompt, q.options, q.correct_index,
    q.prep_seconds, q.answer_seconds, q.points,
    (select count(*) from public.quiz_answers a where a.question_id = q.id)
  from public.quiz_questions q
  where q.session_id = p_session_id
    and exists (
      select 1 from public.game_sessions s
        join public.events e on e.id = s.event_id
       where s.id = p_session_id and e.host_id = auth.uid())
  order by q.ordinal;
$$;

revoke execute on function public.list_quiz_questions(uuid) from public;
grant execute on function public.list_quiz_questions(uuid) to authenticated;

-- ============================================================
-- 出題進行（主持人）
-- ============================================================

-- 開始某一題。started_at 是這一題的時間原點：
-- 準備時間結束才開放作答，全部由 started_at 推算，
-- 因此一次寫入就涵蓋「準備」與「作答」兩個階段。
drop function if exists public.start_quiz_question(uuid, uuid);

create or replace function public.start_quiz_question(
  p_session_id  uuid,
  p_question_id uuid
)
returns table (started_at_ms bigint, server_ms bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_started timestamptz;
begin
  if not exists (
    select 1 from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  if not exists (
    select 1 from public.quiz_questions q
     where q.id = p_question_id and q.session_id = p_session_id
  ) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  v_started := clock_timestamp();

  update public.game_sessions
     set current_question_id = p_question_id,
         phase = 'prep',
         started_at = v_started,
         status = 'playing'
   where id = p_session_id;

  perform realtime.send(
    jsonb_build_object(
      'session_id', p_session_id,
      'question_id', p_question_id,
      'started_at_ms', (extract(epoch from v_started) * 1000)::bigint
    ),
    'quiz:question', 'game:' || p_session_id, false);

  return query select
    (extract(epoch from v_started) * 1000)::bigint,
    (extract(epoch from clock_timestamp()) * 1000)::bigint;
end;
$$;

revoke execute on function public.start_quiz_question(uuid, uuid) from public;
grant execute on function public.start_quiz_question(uuid, uuid) to authenticated;

-- 切換顯示階段：公布答案、看排行榜、回到待機
create or replace function public.set_quiz_phase(
  p_session_id uuid,
  p_phase      text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phase not in ('idle', 'prep', 'answer', 'reveal', 'scoreboard') then
    raise exception 'INVALID_PHASE';
  end if;

  update public.game_sessions s
     set phase = p_phase
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid());

  if not found then
    raise exception 'NOT_EVENT_HOST';
  end if;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'phase', p_phase),
    'quiz:phase', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.set_quiz_phase(uuid, text) from public;
grant execute on function public.set_quiz_phase(uuid, text) to authenticated;

-- ============================================================
-- 作答（匿名）
-- ============================================================

-- 作答時間一律由伺服器算。前端只送「選了哪一個」，
-- 送出時間戳等於把計分權交給玩家。
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

  -- 只有「正在進行的那一題」能作答，不能挑舊題目補答
  if v_session.current_question_id is distinct from p_question_id
     or v_session.started_at is null then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = v_session.id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  v_open_at := v_session.started_at + make_interval(secs => v_q.prep_seconds);
  v_limit := v_q.answer_seconds * 1000;
  v_elapsed := floor(
    extract(epoch from (clock_timestamp() - v_open_at)) * 1000
  )::int;

  if v_elapsed < -150 then
    raise exception 'ANSWER_NOT_OPEN';
  end if;

  -- 給一點寬限，網路延遲不該讓壓線的作答被丟掉
  if v_elapsed > v_limit + 1500 then
    raise exception 'TOO_LATE';
  end if;

  v_elapsed := least(greatest(v_elapsed, 0), v_limit);
  v_correct := p_choice_index = v_q.correct_index;

  -- 答對的得分隨時間遞減：秒答滿分，壓線答對拿一半。
  -- 全有全無會讓慢答的人乾脆亂猜，遞減才會逼人快一點又不敢亂按。
  v_points := case
    when v_correct then greatest(1, round(v_q.points * (1 - 0.5 * v_elapsed::numeric / v_limit))::int)
    else 0
  end;

  -- 按下去就不能改。on conflict do nothing 讓重送不會報錯，
  -- 現場網路不穩時手機重試很常見。
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
-- 手機端狀態
-- ============================================================

-- 給手機的狀態。
--
-- 題目與選項文字手機上也要有：現場一定會有長輩、坐後排、
-- 或視力不好的人，只靠大螢幕等於把他們排除在遊戲外。
-- 選項文字本來就會出現在大螢幕上，送到手機不洩漏任何東西——
-- 真正不能提早送的只有 correct_index。
drop function if exists public.get_quiz_play_state(uuid, text);

create or replace function public.get_quiz_play_state(
  p_session_id   uuid,
  p_device_token text
)
returns table (
  phase          text,
  question_id    uuid,
  question_no    int,
  question_total int,
  prompt         text,
  options        text[],
  prep_seconds   int,
  answer_seconds int,
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
    s.phase,
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    a.choice_index,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then q.correct_index else null end,
    case when s.phase = 'reveal' or s.phase = 'scoreboard'
         then a.points else null end,
    (select coalesce(sum(t.points), 0)::int
       from public.quiz_answers t
      where t.session_id = s.id and t.player_id = gp.id)
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  left join public.game_players gp
         on gp.session_id = s.id and gp.device_token = p_device_token
  left join public.quiz_answers a
         on a.question_id = q.id and a.player_id = gp.id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_play_state(uuid, text) from public;
grant execute on function public.get_quiz_play_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕狀態
-- ============================================================

-- 大螢幕要題目與選項文字，還要作答進度。
-- 正確答案同樣只在公布之後才回傳——大螢幕是匿名身分，
-- 提早送出去等於任何人都能先看到。
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
  options        text[],
  prep_seconds   int,
  answer_seconds int,
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
    s.phase,
    s.name,
    coalesce(s.config->>'mode', 'team'),
    q.id,
    q.ordinal,
    (select count(*)::int from public.quiz_questions x where x.session_id = s.id),
    -- 題目在準備階段就要出現在大螢幕，那正是給大家讀題的時間
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.options end,
    q.prep_seconds,
    q.answer_seconds,
    case when s.started_at is null then null
         else (extract(epoch from s.started_at) * 1000)::bigint end,
    (extract(epoch from clock_timestamp()) * 1000)::bigint,
    (select count(*)::int from public.quiz_answers a where a.question_id = q.id),
    (select count(*)::int from public.game_players gp where gp.session_id = s.id),
    case when s.phase in ('reveal', 'scoreboard') then q.correct_index else null end,
    -- count(a.id) 而不是 count(*)：left join 沒配對到時仍會產生一列，
    -- count(*) 會把那個空列算成 1，沒人選的選項就變成 1 票
    case when s.phase in ('reveal', 'scoreboard') then array(
      select count(a.id)::int from generate_series(0, 3) g
       left join public.quiz_answers a
              on a.question_id = q.id and a.choice_index = g
       group by g order by g
    ) else null end
  from public.game_sessions s
  left join public.quiz_questions q on q.id = s.current_question_id
  where s.id = p_session_id;
$$;

revoke execute on function public.get_quiz_stage_state(uuid) from public;
grant execute on function public.get_quiz_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 排行榜
-- ============================================================

drop function if exists public.quiz_individual_leaderboard(uuid, int);

create or replace function public.quiz_individual_leaderboard(
  p_session_id uuid,
  p_limit int default 10
)
returns table (
  player_id uuid,
  display_name text,
  team_name text,
  team_color text,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    gp.id, gp.display_name, t.name, t.color,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.game_players gp
  join public.teams t on t.id = gp.team_id
  left join public.quiz_answers a on a.player_id = gp.id
  where gp.session_id = p_session_id
  group by gp.id, gp.display_name, t.name, t.color
  order by 5 desc, 6 desc, gp.display_name
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

revoke execute on function public.quiz_individual_leaderboard(uuid, int) from public;
grant execute on function public.quiz_individual_leaderboard(uuid, int) to anon, authenticated;

drop function if exists public.quiz_team_leaderboard(uuid);

create or replace function public.quiz_team_leaderboard(p_session_id uuid)
returns table (
  team_id uuid,
  table_no int,
  name text,
  color text,
  creature_key text,
  player_count int,
  total_points int,
  correct_count int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count,
    coalesce(sum(a.points), 0)::int,
    coalesce(sum(case when a.is_correct then 1 else 0 end), 0)::int
  from public.teams t
  left join public.quiz_answers a on a.team_id = t.id
  where t.session_id = p_session_id
  group by t.id, t.table_no, t.name, t.color, t.creature_key, t.player_count
  order by 7 desc, 8 desc, t.table_no;
$$;

revoke execute on function public.quiz_team_leaderboard(uuid) from public;
grant execute on function public.quiz_team_leaderboard(uuid) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
with expected(fn) as (
  values ('upsert_quiz_question'), ('delete_quiz_question'), ('move_quiz_question'),
         ('list_quiz_questions'), ('start_quiz_question'), ('set_quiz_phase'),
         ('submit_quiz_answer'), ('get_quiz_play_state'), ('get_quiz_stage_state'),
         ('quiz_individual_leaderboard'), ('quiz_team_leaderboard')
)
select
  e.fn as 函式名稱,
  case when p.oid is null then '缺少' else '已建立' end as 狀態
from expected e
left join pg_proc p
       on p.proname = e.fn and p.pronamespace = 'public'::regnamespace
order by 狀態, e.fn;
