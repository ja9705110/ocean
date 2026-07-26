-- 放寬角色圖片的單檔大小上限
--
-- 原本 200KB 是以純線條畫估算的。含個人照片的角色即使壓過仍可能接近
-- 上限，只要超過就整個送不出去（現場會看到「object exceeded the
-- maximum allowed size」）。前端已改為逐步降品質，這裡再留一層餘裕。

update storage.buckets
   set file_size_limit = 512000
 where id = 'characters';

notify pgrst, 'reload schema';

select id, file_size_limit, allowed_mime_types
  from storage.buckets
 where id = 'characters';
