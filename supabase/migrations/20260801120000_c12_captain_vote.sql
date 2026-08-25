-- C12：桌長投票
--
-- 原本的桌長是「先搶先贏」——誰先按誰就是。那在趕時間的時候很有效，
-- 但它不是推派，是手速比賽：坐在最後面剛拿出手機的人永遠沒機會，
-- 而那個人可能才是這一桌想推的。
--
-- 這一版改成投票，並且把節奏交給主持人：
--
--   主持人確認大家都入座了 → 按「開始選桌長」並設定秒數
--   → 每個人在自己手機上選一位同桌的人（可以改，也可以投自己）
--   → 倒數結束，主持人按定案，票最多的那位成為桌長
--
-- 三個刻意的設計：
--
-- 1. 「現在是不是投票時間」是算出來的，不是存的狀態。
--    跟 Q2 的答題階段同一套：從 captain_vote_started_at 加上秒數推算。
--    手機、大螢幕、後台三邊各自算，永遠一致，中間不需要任何人
--    在正確的時間點寫入資料庫——那個寫入一旦漏掉（分頁被切到背景、
--    網路斷一下），全場就卡在投票畫面出不來。
--
-- 2. 定案是一次寫入，由主持人觸發，而且可以重複執行。
--    三百多支手機在倒數結束的同一秒各自去寫「誰是桌長」是災難；
--    只有一個寫入者就沒有競態。
--
-- 3. 平票取「最早投出那一票的人」。用時間決勝而不是隨機：
--    現場要能解釋為什麼是他，而「他先被投」講得通。
--
-- 此檔可重複執行。

-- ============================================================
-- 投票視窗
-- ============================================================

alter table public.game_sessions
  add column if not exists captain_vote_started_at timestamptz;

alter table public.game_sessions
  add column if not exists captain_vote_seconds int not null default 30;

do $$
begin
  alter table public.game_sessions
    add constraint game_sessions_captain_vote_range
    check (captain_vote_seconds between 10 and 300);
exception when duplicate_object then null;
end $$;

-- ============================================================
-- 票
-- ============================================================

create table if not exists public.captain_votes (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.game_sessions(id) on delete cascade,
  team_id             uuid not null references public.teams(id) on delete cascade,
  voter_player_id     uuid not null references public.game_players(id) on delete cascade,
  candidate_player_id uuid not null references public.game_players(id) on delete cascade,
  created_at          timestamptz not null default now(),

  -- 一人一票。改投是 update 這一列，不是插新的一列——
  -- 保留「第一次投票的時間」才有辦法用時間決平票。
  unique (session_id, voter_player_id)
);

create index if not exists captain_votes_team_idx
  on public.captain_votes (team_id);

alter table public.captain_votes enable row level security;

-- 票不開放給 anon 直接讀寫：能讀就能知道誰投給誰，
-- 而那在現場是會吵架的。所有存取一律走下面的函式。
drop policy if exists captain_votes_no_anon on public.captain_votes;

-- ============================================================
-- 開始投票（主持人）
-- ============================================================

create or replace function public.start_captain_vote(
  p_session_id uuid,
  p_seconds    int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seconds int := greatest(10, least(300, coalesce(p_seconds, 30)));
begin
  update public.game_sessions s
     set captain_vote_started_at = now(),
         captain_vote_seconds = v_seconds
   where s.id = p_session_id
     and exists (
       select 1 from public.events e
        where e.id = s.event_id and e.host_id = auth.uid());

  if not found then
    raise exception 'NOT_EVENT_HOST';
  end if;

  -- 重開一輪投票要把上一輪的票清掉，否則舊票會混進新的計算
  delete from public.captain_votes where session_id = p_session_id;
  update public.game_players set is_captain = false
   where session_id = p_session_id and is_captain;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'seconds', v_seconds),
    'captain:vote-start', 'game:' || p_session_id, false);
end;
$$;

revoke execute on function public.start_captain_vote(uuid, int) from public;
grant execute on function public.start_captain_vote(uuid, int) to authenticated;

-- ============================================================
-- 投票（玩家，匿名）
-- ============================================================

create or replace function public.cast_captain_vote(
  p_session_id   uuid,
  p_device_token text,
  p_candidate_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_voter     public.game_players;
  v_candidate public.game_players;
  v_session   public.game_sessions;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  -- 投票視窗是算出來的。過了就不收——主持人晚一點按定案，
  -- 不該讓遲到的票變成有效。
  if v_session.captain_vote_started_at is null
     or now() > v_session.captain_vote_started_at
                + make_interval(secs => v_session.captain_vote_seconds) then
    raise exception 'VOTE_CLOSED';
  end if;

  select * into v_voter from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_voter.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select * into v_candidate from public.game_players gp
   where gp.id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'CANDIDATE_NOT_FOUND';
  end if;

  -- 只能投同一桌的人。跨桌投票在現場只會製造混亂。
  if v_candidate.team_id <> v_voter.team_id then
    raise exception 'DIFFERENT_TEAM';
  end if;

  insert into public.captain_votes
    (session_id, team_id, voter_player_id, candidate_player_id)
  values
    (p_session_id, v_voter.team_id, v_voter.id, v_candidate.id)
  on conflict (session_id, voter_player_id) do update
    set candidate_player_id = excluded.candidate_player_id;

  -- 廣播給同一桌就好，不是整場。一桌三十幾個人，
  -- 整場三百多人——差別是十倍的扇出。
  perform realtime.send(
    jsonb_build_object('team_id', v_voter.team_id),
    'captain:vote', 'table:' || v_voter.team_id, false);
end;
$$;

revoke execute on function public.cast_captain_vote(uuid, text, uuid) from public;
grant execute on function public.cast_captain_vote(uuid, text, uuid) to anon, authenticated;

-- ============================================================
-- 定案（主持人）
-- ============================================================

-- 回傳型別可能改變，先丟掉再建
drop function if exists public.finalize_captain_votes(uuid);

create or replace function public.finalize_captain_votes(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_decided int := 0;
  v_pending int := 0;
  v_team    record;
  v_winner  uuid;
begin
  if not exists (
    select 1 from public.game_sessions s
     join public.events e on e.id = s.event_id
    where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  for v_team in
    select t.id from public.teams t where t.session_id = p_session_id
  loop
    -- 票最多的人。平票取「最早被投到那一票」的人：
    -- 現場要能解釋為什麼是他，而「他先被投」講得通。
    select cv.candidate_player_id into v_winner
      from public.captain_votes cv
     where cv.team_id = v_team.id
     group by cv.candidate_player_id
     order by count(*) desc, min(cv.created_at) asc
     limit 1;

    if v_winner is null then
      -- 這一桌沒有人投票。不自動指定：沒有人想當的桌，
      -- 主持人走過去問一句比系統亂點一個人有用。
      v_pending := v_pending + 1;
      continue;
    end if;

    update public.game_players set is_captain = false
     where team_id = v_team.id and is_captain and id <> v_winner;
    update public.game_players set is_captain = true
     where id = v_winner and not is_captain;

    v_decided := v_decided + 1;
  end loop;

  perform realtime.send(
    jsonb_build_object('session_id', p_session_id, 'decided', v_decided),
    'captain:decided', 'game:' || p_session_id, false);

  return jsonb_build_object('decided', v_decided, 'pending', v_pending);
end;
$$;

revoke execute on function public.finalize_captain_votes(uuid) from public;
grant execute on function public.finalize_captain_votes(uuid) to authenticated;

-- ============================================================
-- 我這一桌的投票畫面（玩家，匿名）
-- ============================================================

drop function if exists public.get_captain_vote_state(uuid, text);

create or replace function public.get_captain_vote_state(
  p_session_id   uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player  public.game_players;
  v_session public.game_sessions;
  v_members jsonb;
  v_my_vote uuid;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  select cv.candidate_player_id into v_my_vote
    from public.captain_votes cv
   where cv.session_id = p_session_id and cv.voter_player_id = v_player.id;

  -- 只回傳票數，不回傳「誰投給誰」。知道誰投給誰在現場只會吵架。
  select coalesce(jsonb_agg(m order by m.display_name), '[]'::jsonb)
    into v_members
    from (
      select gp.id,
             gp.display_name,
             gp.is_captain,
             (select count(*) from public.captain_votes cv
               where cv.candidate_player_id = gp.id) as votes
        from public.game_players gp
       where gp.team_id = v_player.team_id
    ) m;

  return jsonb_build_object(
    'team_id', v_player.team_id,
    'team_name', (select t.name from public.teams t where t.id = v_player.team_id),
    'my_player_id', v_player.id,
    'my_vote', v_my_vote,
    'members', v_members,
    'started_at_ms',
      case when v_session.captain_vote_started_at is null then null
           else extract(epoch from v_session.captain_vote_started_at) * 1000 end,
    'vote_seconds', v_session.captain_vote_seconds,
    'server_ms', extract(epoch from now()) * 1000
  );
end;
$$;

revoke execute on function public.get_captain_vote_state(uuid, text) from public;
grant execute on function public.get_captain_vote_state(uuid, text) to anon, authenticated;

-- ============================================================
-- 大螢幕：每一桌選好了沒
-- ============================================================

drop function if exists public.get_captain_stage_state(uuid);

create or replace function public.get_captain_stage_state(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.game_sessions;
  v_tables  jsonb;
begin
  select * into v_session from public.game_sessions s where s.id = p_session_id;
  if v_session.id is null then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(x order by x.table_no), '[]'::jsonb)
    into v_tables
    from (
      select t.id,
             t.table_no,
             t.name,
             t.color,
             t.player_count,
             (select gp.display_name from public.game_players gp
               where gp.team_id = t.id and gp.is_captain limit 1) as captain_name,
             (select count(*) from public.captain_votes cv
               where cv.team_id = t.id) as vote_count,
             coalesce((
               select jsonb_agg(gp.display_name order by gp.joined_at)
                 from public.game_players gp
                where gp.team_id = t.id and not gp.is_captain
             ), '[]'::jsonb) as members
        from public.teams t
       where t.session_id = p_session_id
    ) x;

  return jsonb_build_object(
    'tables', v_tables,
    'started_at_ms',
      case when v_session.captain_vote_started_at is null then null
           else extract(epoch from v_session.captain_vote_started_at) * 1000 end,
    'vote_seconds', v_session.captain_vote_seconds,
    'server_ms', extract(epoch from now()) * 1000
  );
end;
$$;

revoke execute on function public.get_captain_stage_state(uuid) from public;
grant execute on function public.get_captain_stage_state(uuid) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
