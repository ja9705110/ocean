/**
 * 最小的 ZIP 打包器（C32）。
 *
 * 兩百多張餅乾照片要能一次存下來。一張一張下載的話瀏覽器會把
 * 「短時間內連續好幾個下載」當成可疑行為擋掉，而且兩百多個檔案
 * 散在下載資料夾裡等於沒有整理過。
 *
 * 為什麼自己寫而不是裝一套：
 *
 * 照片已經是 WebP／JPEG，本身就是壓過的，再壓一次省不到什麼
 * （實測整包只小 1%），所以只需要 ZIP 的「不壓縮」模式——
 * 那是規格裡最簡單的一段：三種區塊、一個 CRC32，加起來一百多行。
 * 為了這一百多行裝一套幾十 KB 的函式庫，還要多一個會過期的相依，
 * 不划算。
 *
 * 檔名一律以 UTF-8 寫入並打上語言編碼旗標（bit 11），
 * 中文檔名在 Windows 的檔案總管、macOS 的解壓縮程式都不會變亂碼。
 *
 * 不支援 ZIP64：那是給 4GB 以上或 65535 個檔案以上用的。
 * 兩百八十張、每張幾十 KB，差了三個數量級。
 */

/** CRC32 查表。第一次用到時才建，沒有用到打包功能的頁面不必付這個成本。 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) {
    return crcTable;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 壓縮檔裡的路徑。可以帶資料夾，例如 "餅乾/001.webp"。 */
  readonly name: string;
  /**
   * 檔案內容。
   *
   * 型別上寫死由 ArrayBuffer 支撐（而不是 ArrayBufferLike）：
   * Blob 不接受 SharedArrayBuffer 上的 view，讓型別在這裡擋掉，
   * 比在建 Blob 那一行才發現好。
   */
  readonly data: Uint8Array<ArrayBuffer>;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * MS-DOS 格式的日期時間。
 *
 * ZIP 的時間欄位是 1980 年起算、秒數只有兩秒精度的老格式。
 * 這個欄位不影響解壓縮，但留空的話有些工具會顯示 1980-01-01，
 * 看起來像壞檔。
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 每一段的位元組長度 */
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/**
 * 打成一個 ZIP。
 *
 * 回傳 Blob 而不是 Uint8Array：呼叫端要的是「一個可以下載的檔案」，
 * 而 Blob 由多個片段組成時瀏覽器不必把整包再複製一次——
 * 兩百八十張照片大約一百 MB，多複製一次是實際會卡住畫面的成本。
 */
export function buildZip(entries: readonly ZipEntry[], now = new Date()): Blob {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);

  const parts: (Uint8Array<ArrayBuffer>)[] = [];
  const central: (Uint8Array<ArrayBuffer>)[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(LOCAL_HEADER + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50); // local file header signature
    writeUint16(localView, 4, 20); // version needed：2.0 就夠（store）
    writeUint16(localView, 6, 0x0800); // bit 11：檔名是 UTF-8
    writeUint16(localView, 8, 0); // method 0 = 不壓縮
    writeUint16(localView, 10, stamp.time);
    writeUint16(localView, 12, stamp.date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, size); // compressed
    writeUint32(localView, 22, size); // uncompressed（store 兩者相同）
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0); // extra field 長度
    local.set(nameBytes, LOCAL_HEADER);

    parts.push(local, entry.data);

    const dir = new Uint8Array(CENTRAL_HEADER + nameBytes.length);
    const dirView = new DataView(dir.buffer);
    writeUint32(dirView, 0, 0x02014b50); // central directory header signature
    writeUint16(dirView, 4, 20); // version made by
    writeUint16(dirView, 6, 20); // version needed
    writeUint16(dirView, 8, 0x0800);
    writeUint16(dirView, 10, 0);
    writeUint16(dirView, 12, stamp.time);
    writeUint16(dirView, 14, stamp.date);
    writeUint32(dirView, 16, checksum);
    writeUint32(dirView, 20, size);
    writeUint32(dirView, 24, size);
    writeUint16(dirView, 28, nameBytes.length);
    writeUint16(dirView, 30, 0); // extra
    writeUint16(dirView, 32, 0); // comment
    writeUint16(dirView, 34, 0); // disk number
    writeUint16(dirView, 36, 0); // internal attributes
    writeUint32(dirView, 38, 0); // external attributes
    writeUint32(dirView, 42, offset); // 這一筆的 local header 在哪裡
    dir.set(nameBytes, CENTRAL_HEADER);
    central.push(dir);

    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);

  const end = new Uint8Array(END_RECORD);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50); // end of central directory signature
  writeUint16(endView, 4, 0); // 這一片磁碟的編號
  writeUint16(endView, 6, 0); // 中央目錄起始磁碟
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset); // 中央目錄的位置
  writeUint16(endView, 20, 0); // 註解長度

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

/**
 * 檔名裡不能出現的字元。
 *
 * 署名是使用者自己打的，可能有斜線、冒號、問號。這些字元在
 * Windows 上會讓整個解壓縮失敗，不是只有那一個檔案有問題。
 */
export function safeFileName(name: string): string {
  return (
    name
      // 控制字元與 Windows 不接受的那幾個。中文、數字、空白都要留著。
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "未署名"
  );
}
