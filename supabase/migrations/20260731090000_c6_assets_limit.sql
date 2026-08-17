-- C6：把 assets bucket 的單檔上限提高到 4MB
--
-- 原本是 1MB，那個數字是當初只放 logo 時訂的。現在同一個 bucket 還要放
-- 大螢幕的背景圖——活動主視覺這種圖動輒好幾 MB，主持人上傳時會撞到
-- 「The object exceeded the maximum allowed size」，而那句英文
-- 看不出是什麼意思，也看不出該怎麼辦。
--
-- 前端已經會在上傳前把圖縮到 2560 寬並壓到 900KB 以內，所以正常情況
-- 根本碰不到這個上限。這裡調高只是餘裕：編碼器的輸出大小會浮動，
-- 而活動當天不該卡在這種地方。
--
-- 為什麼不調更高：這個 bucket 是公開讀取的，每次大螢幕開場都會把
-- 背景圖整張抓下來。會場的 Wi-Fi 通常沒有那麼寬裕，留一個上限
-- 可以擋掉「不小心上傳一張 20MB 的原始輸出」這種事。

update storage.buckets
   set file_size_limit = 4194304
 where id = 'assets';

-- 順便確認 WebP 在允許的格式裡：前端壓縮之後輸出的就是 WebP
update storage.buckets
   set allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
 where id = 'assets';

-- ============================================================
-- 讓 PostgREST 立即看見上面的變更
-- ============================================================
notify pgrst, 'reload schema';
select pg_notify('pgrst', 'reload schema');
