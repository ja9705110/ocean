-- C11：刪除活動
--
-- 主持人測試時會建好幾個活動，活動清單很快就變成一堆「測試1」「測試2」。
-- 沒有刪除鍵的話那些永遠留著，正式那一場混在裡面很容易點錯——
-- 活動當天點錯活動是很難救的。
--
-- 幾個刻意的決定：
--
-- 1. 只有活動的主人刪得掉。RLS policy 已經是這樣，但刪除是不可逆的，
--    所以這裡再用 security definer 的函式檢查一次 host_id，
--    不依賴呼叫端有沒有帶對條件。
--
-- 2. 必須輸入活動代碼才刪得掉。函式要求呼叫端把代碼一起送上來，
--    對不上就拒絕。前端也會要求打字確認，但那只是介面；
--    真正擋住「手滑點到」的是這一層。
--
-- 3. 已經結束的活動也能刪。有人會想留紀錄，但那是主持人自己的判斷，
--    不是系統該替他決定的事——真的需要紀錄的是簽到表，那份可以先匯出。
--
-- 4. 關聯資料靠外鍵的 on delete cascade 帶走。M1 起所有子表都是
--    references public.events(id) on delete cascade，所以參與者、獎項、
--    抽獎結果、遊戲房間、題目、作答會一起消失。
--    Storage 裡的圖檔不會自動刪——那是另一個系統，而且刪錯了救不回來。
--
-- 此檔可重複執行。

-- 回傳型別可能改變，先丟掉再建（create or replace 不能改回傳型別）
drop function if exists public.delete_event(uuid, text);

create or replace function public.delete_event(
  p_event_id uuid,
  p_code     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events;
begin
  select * into v_event from public.events e where e.id = p_event_id;

  if v_event.id is null then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  -- 不是自己的活動：一律當成找不到，不透露這個 id 存不存在
  if v_event.host_id is null or v_event.host_id <> auth.uid() then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  -- 代碼對不上就是打錯了，不刪
  if upper(btrim(coalesce(p_code, ''))) <> upper(v_event.code) then
    raise exception 'CODE_MISMATCH';
  end if;

  delete from public.events where id = p_event_id;
end;
$$;

revoke all on function public.delete_event(uuid, text) from public;
grant execute on function public.delete_event(uuid, text) to authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
