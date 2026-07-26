-- 手動確認主持人帳號的信箱（開發／自用）
--
-- 用途：Supabase 內建寄信服務有嚴格速率限制且常被信箱端擋下，
-- 主持人收不到驗證信就無法登入。這份 SQL 直接標記為已確認，
-- 不需要等信。
--
-- 這是專案擁有者對自己專案的管理操作。若日後開放外部主持人註冊，
-- 應改為在 Supabase 設定自訂 SMTP，而不是繼續用這份 SQL。

-- 1) 先看看目前有哪些帳號、確認狀態如何
select
  email,
  created_at,
  email_confirmed_at,
  case when email_confirmed_at is null then '未確認' else '已確認' end as 狀態
from auth.users
order by created_at desc;

-- 2) 確認所有尚未確認的帳號
--    （只會影響已經註冊過的帳號，不會建立新帳號）
update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now())
 where email_confirmed_at is null;

-- 3) 再查一次，確認狀態都變成「已確認」
select
  email,
  email_confirmed_at,
  case when email_confirmed_at is null then '未確認' else '已確認' end as 狀態
from auth.users
order by created_at desc;
