-- C18：以姓名查自己是不是已經報到過
--
-- 同一支手機重掃 QR 會直接跳到完成頁，那是靠瀏覽器裡存的紀錄。
-- 但現場真正會發生的是這些：手機換了、用無痕開、清了瀏覽資料、
-- 或是報到台幫忙用平板代簽過一次，本人自己再掃一次。
-- 這些情況下瀏覽器裡什麼都沒有，於是同一個人會被簽進去第二次——
-- 大螢幕上出現兩個一樣的名字，抽獎名單裡也多一份。
--
-- 這支函式讓報到頁在送出之前先問一次：這個名字報到過了嗎？
-- 報到過就直接把他帶到完成頁，看到的是他原本那一筆。
--
-- 為什麼只接受完整姓名相符：
--
--   participants 對匿名端是完全關閉的，就是為了不讓任何人把
--   與會者名單整份撈走。這支函式維持同樣的限制——要先知道
--   完整姓名才問得出東西，跟 lookup_roster 同一套規則。
--   前綴、模糊、列舉一律不支援。
--
-- 回傳裡沒有 device_token。那是別人手機的身分，一旦外流就能冒用。
--
-- 此檔可重複執行。

drop function if exists public.find_checkin_by_name(uuid, text);

create or replace function public.find_checkin_by_name(
  p_event_id uuid,
  p_name     text
)
returns table (
  id             uuid,
  display_name   text,
  organization   text,
  seat_no        text,
  image_path     text,
  signature_path text,
  joined_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         p.display_name,
         p.organization,
         p.seat_no,
         p.image_path,
         p.signature_path,
         p.joined_at
    from public.participants p
   where p.event_id = p_event_id
     -- btrim + lower：現場最常見的是多打一個空白或大小寫不同，
     -- 那不該被當成另一個人
     and lower(btrim(p.display_name)) = lower(btrim(coalesce(p_name, '')))
     and btrim(coalesce(p_name, '')) <> ''
   order by p.joined_at
   limit 5;
$$;

revoke execute on function public.find_checkin_by_name(uuid, text) from public;
grant execute on function public.find_checkin_by_name(uuid, text) to anon, authenticated;

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
