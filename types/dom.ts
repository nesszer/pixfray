// Browser globals for the strict browser program (tsconfig.strict-web.json) that lib.dom leaves out. The loose web
// program (tsconfig.web.json) reads types/browser.d.ts instead, which also makes selector lookups untyped; strict
// files cast each lookup to the element the page holds.
export {};

declare global {
  interface Window {
    __arenaMove?: (userId: string, x: number) => void; // overlay ?debug=1 hooks (src/served/overlay.ts)
    __arenaDebug?: () => unknown;
    // Home page test hooks (src/intro/main.ts); the dev server adds the scene objects too.
    __intro?: { readonly C: number; setC(x: number): void; readonly quality: { step: number; pixelRatio: number } };
    webkitAudioContext?: typeof AudioContext; // older Safari
  }
  interface Navigator {
    connection?: { saveData?: boolean; effectiveType?: string }; // Network Information API, Chromium only
  }
}
