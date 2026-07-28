-- Q1：題目可以配圖
--
-- 圖片放在既有的 assets 儲存桶（M8 建立，公開讀取、只有主持人能寫）。
-- 資料庫只存公開網址，不存圖片本身——與角色圖同一個原則。
--
-- 回傳欄位變了的函式一律先 drop 再建：
-- Postgres 不允許用 create or replace 改變回傳型別。
--
-- 此檔可重複執行。

alter table public.quiz_questions
  add column if not exists image_url text;

-- ============================================================
-- 出題
-- ============================================================

-- 舊簽章少一個參數，留著會變成多載，PostgREST 會不知道要呼叫哪一個
drop function if exists public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int);

create or replace function public.upsert_quiz_question(
  p_session_id     uuid,
  p_question_id    uuid,
  p_prompt         text,
  p_options        text[],
  p_correct_index  int,
  p_prep_seconds   int default 5,
  p_answer_seconds int default 20,
  p_points         int default 1000,
  p_image_url      text default null
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
           points         = p_points,
           image_url      = nullif(btrim(coalesce(p_image_url, '')), '')
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
     prep_seconds, answer_seconds, points, image_url)
  values
    (p_session_id, v_ordinal, btrim(p_prompt), p_options, p_correct_index,
     p_prep_seconds, p_answer_seconds, p_points,
     nullif(btrim(coalesce(p_image_url, '')), ''))
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) from public;
grant execute on function public.upsert_quiz_question(uuid, uuid, text, text[], int, int, int, int, text) to authenticated;

-- ============================================================
-- 查詢：補上 image_url
-- ============================================================

drop function if exists public.list_quiz_questions(uuid);

create or replace function public.list_quiz_questions(p_session_id uuid)
returns table (
  id uuid,
  ordinal int,
  prompt text,
  image_url text,
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
    q.id, q.ordinal, q.prompt, q.image_url, q.options, q.correct_index,
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
  image_url      text,
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
    case when s.phase = 'idle' then null else q.image_url end,
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
    case when s.phase = 'idle' then null else q.prompt end,
    case when s.phase = 'idle' then null else q.image_url end,
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
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';

-- ============================================================
-- 驗證
-- ============================================================
select
  case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quiz_questions'
       and column_name = 'image_url'
  ) then '已建立' else '缺少' end as "quiz_questions.image_url";
