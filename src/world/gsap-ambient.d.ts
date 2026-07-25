// GSAP 的型別是以全域 namespace（gsap.core.Timeline 等）宣告的，
// 需要這行才會被 TypeScript 載入，否則 world/types.ts 無法引用。
// 這裡刻意不使用 import，避免型別依賴把 gsap 的執行期程式碼帶進 server bundle。
/// <reference types="gsap" />

export {};
