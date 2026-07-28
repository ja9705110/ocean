"use client";

/**
 * 觸感回饋（G1c）。
 *
 * 划船的時候人是看著大螢幕的，手上有沒有感覺就是唯一的即時確認。
 * 沒有震動，玩家會低頭看手機確認自己有沒有划到——那一低頭，
 * 整場的氣氛就散了。
 *
 * 現實限制要講清楚：
 * - Android 的 Chrome 支援 navigator.vibrate。
 * - iOS 的 Safari 不支援，網頁完全碰不到 Taptic Engine，沒有替代方案。
 *   iPhone 上的即時回饋只能靠聲音與畫面，這是平台限制不是取捨。
 *
 * 每次震動都很短（十幾毫秒）。長震動在連續划槳時會疊在一起變成嗡嗡聲，
 * 反而讓人分不出自己划了幾下。
 */

/** 兩次震動之間的最短間隔，避免高速划槳時排隊堆積 */
const MIN_GAP_MS = 90;

let lastAt = 0;
let enabled = true;

export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && "vibrate" in navigator;
}

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    pulse(0);
  }
}

function pulse(pattern: number | number[]): void {
  if (!canVibrate()) {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    // 某些瀏覽器在非使用者手勢中會拒絕，忽略即可
  }
}

/** 一次划槳。力道隨強度微幅變化，划得猛的時候手感更明確。 */
export function hapticStroke(intensity: number): void {
  if (!enabled) {
    return;
  }
  const now = performance.now();
  if (now - lastAt < MIN_GAP_MS) {
    return;
  }
  lastAt = now;
  pulse(Math.round(10 + Math.min(Math.max(intensity, 0), 1) * 12));
}

/** 兩隻拇指都到位，感應器啟動 */
export function hapticGrip(): void {
  if (enabled) {
    pulse([14, 60, 14]);
  }
}

/** 划到一半放開了手，這是安全提醒，要明顯 */
export function hapticGripLost(): void {
  if (enabled) {
    pulse([40, 70, 40]);
  }
}

/** 開始前的倒數。最後一下要不一樣，人才知道「就是現在」。 */
export function hapticCountdown(final: boolean): void {
  if (enabled) {
    pulse(final ? [30, 50, 30, 50, 90] : 16);
  }
}

export function hapticFinish(): void {
  if (enabled) {
    pulse([60, 80, 60, 80, 180]);
  }
}
