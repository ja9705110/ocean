-- C19：主持人可以把任何一題重新叫出來
--
-- 現在的流程是單向的：出第 1 題、第 2 題……過去就過去了。
-- 但現場不是這樣走的。投影機斷訊、有人喊「題目沒看清楚」、
-- 主持人手滑按了下一題、中場休息回來想再放一次上一題——
-- 這些每一場都會發生，而系統只給得出「下一題」。
--
-- 重新顯示本身不需要新東西：start_quiz_question 本來就吃任何一個
-- question_id。缺的是清掉那一題的作答。
--
-- 為什麼要分成兩件事：
--
--   重新顯示（不清作答）  投影出問題、有人沒看到題目。分數是對的，
--                         不該因為重放一次就重算。已經答過的人
--                         會直接看到公布的畫面。
--   清掉作答再重來        那一題真的作廢了——題目打錯、選項貼錯、
--                         或是搶答時網路出問題整桌沒送出去。
--                         這時候要讓大家重答，舊的分數必須消失。
--
-- 只有活動的主人能清，而且在函式裡再檢查一次，不依賴呼叫端。
--
-- 此檔可重複執行。

drop function if exists public.reset_quiz_question(uuid);

create or replace function public.reset_quiz_question(p_question_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_removed    int;
begin
  select q.session_id into v_session_id
    from public.quiz_questions q
   where q.id = p_question_id;

  if v_session_id is null then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  -- 不是自己活動底下的題目：當成找不到，不透露它存不存在
  if not exists (
    select 1
      from public.game_sessions s
      join public.events e on e.id = s.event_id
     where s.id = v_session_id and e.host_id = auth.uid()
  ) then
    raise exception 'QUESTION_NOT_FOUND';
  end if;

  delete from public.quiz_answers where question_id = p_question_id;
  get diagnostics v_removed = row_count;

  return v_removed;
end;
$$;

revoke all on function public.reset_quiz_question(uuid) from public;
grant execute on function public.reset_quiz_question(uuid) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
