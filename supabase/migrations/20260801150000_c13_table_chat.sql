-- C13：同桌聊天室
--
-- 每一桌一個聊天室，只有同桌的人看得到。桌長要做決定之前，
-- 組員在自己手機上把想法丟出來——包含直接按「我覺得 B」這種快捷鍵，
-- 那比打字快得多，而現場只有二十秒。
--
-- 三百五十個人同時打字是這個系統最容易垮的地方，所以扇出的設計
-- 是這一份最重要的部分：
--
-- 1. 廣播的頻道是「桌」不是「場」。
--    一則訊息推給同桌的三十幾個人，不是推給全場三百五十個人。
--    十桌的話，同樣的流量差十倍；而現場真正會同時講話的
--    也就是那幾桌。
--
-- 2. 廣播只送「有新訊息」這件事，不送訊息內容。
--    內容由收到通知的那一桌自己去拉。這樣訊息本體只走一次查詢，
--    而且遲到的人拉一次就有完整的上下文，不必補播歷史。
--    （送內容的話還要處理順序、重送、離線補齊，那是另一個工程。）
--
-- 3. 送出的速率在資料庫這一層擋。
--    前端的節流可以被繞過，而一個人瘋狂按貼圖就能把同桌洗版。
--    每個人每則之間至少 1.2 秒——快到不會妨礙討論，
--    但擋得住連按。
--
-- 此檔可重複執行。

create table if not exists public.table_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  player_id  uuid not null references public.game_players(id) on delete cascade,
  -- text 是打出來的字，sticker 是快捷鍵（答題選項 A/B/C/D 或簡單的反應）
  kind       text not null default 'text',
  body       text not null,
  created_at timestamptz not null default now(),

  constraint table_messages_kind_valid check (kind in ('text', 'sticker')),
  constraint table_messages_body_length
    check (char_length(btrim(body)) between 1 and 200)
);

create index if not exists table_messages_team_idx
  on public.table_messages (team_id, created_at desc);

alter table public.table_messages enable row level security;

-- 不開放 anon 直接讀寫：能直接讀就能讀到別桌的討論，
-- 而別桌的討論在答題遊戲裡就是答案。一律走函式。
drop policy if exists table_messages_no_anon on public.table_messages;

-- ============================================================
-- 送出訊息（玩家，匿名）
-- ============================================================

create or replace function public.send_table_message(
  p_session_id   uuid,
  p_device_token text,
  p_kind         text,
  p_body         text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.game_players;
  v_last   timestamptz;
  v_kind   text := case when p_kind = 'sticker' then 'sticker' else 'text' end;
  v_body   text := btrim(coalesce(p_body, ''));
begin
  if char_length(v_body) = 0 then
    raise exception 'EMPTY_MESSAGE';
  end if;
  -- 超過的直接截斷而不是報錯：現場沒有人想看到「訊息太長」，
  -- 而超長的訊息在手機上本來就讀不完
  v_body := left(v_body, 200);

  select * into v_player from public.game_players gp
   where gp.session_id = p_session_id and gp.device_token = p_device_token;
  if v_player.id is null then
    raise exception 'NOT_SEATED';
  end if;

  -- 速率限制。擋的是連按貼圖把同桌洗版，不是正常的討論。
  select max(tm.created_at) into v_last
    from public.table_messages tm
   where tm.player_id = v_player.id;

  if v_last is not null and now() - v_last < interval '1.2 seconds' then
    raise exception 'TOO_FAST';
  end if;

  insert into public.table_messages (session_id, team_id, player_id, kind, body)
  values (p_session_id, v_player.team_id, v_player.id, v_kind, v_body);

  -- 只通知「有新訊息」，內容讓那一桌自己去拉。
  -- 頻道是桌不是場：扇出從三百五十變成三十幾。
  perform realtime.send(
    jsonb_build_object('team_id', v_player.team_id),
    'table:message', 'table:' || v_player.team_id, false);
end;
$$;

revoke execute on function public.send_table_message(uuid, text, text, text) from public;
grant execute on function public.send_table_message(uuid, text, text, text)
  to anon, authenticated;

-- ============================================================
-- 讀同桌的訊息（玩家，匿名）
-- ============================================================

drop function if exists public.list_table_messages(uuid, text, int);

create or replace function public.list_table_messages(
  p_session_id   uuid,
  p_device_token text,
  p_limit        int default 50
)
returns jsonb
language plpgsql
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

  -- 只給最近的幾十則。現場的討論是即時的，往上滑三百則沒有意義，
  -- 而每一則都要過網路。
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
       order by tm.created_at desc
       limit v_limit
    ) x;

  return jsonb_build_object(
    'team_id', v_player.team_id,
    'my_player_id', v_player.id,
    'i_am_captain', v_player.is_captain,
    'messages', v_rows
  );
end;
$$;

revoke execute on function public.list_table_messages(uuid, text, int) from public;
grant execute on function public.list_table_messages(uuid, text, int)
  to anon, authenticated;

-- ============================================================
-- 清空一桌的訊息（主持人）
-- ============================================================

create or replace function public.clear_table_messages(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.game_sessions s
     join public.events e on e.id = s.event_id
    where s.id = p_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'NOT_EVENT_HOST';
  end if;

  delete from public.table_messages where session_id = p_session_id;
end;
$$;

revoke execute on function public.clear_table_messages(uuid) from public;
grant execute on function public.clear_table_messages(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
