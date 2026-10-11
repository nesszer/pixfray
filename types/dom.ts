// Browser globals that lib.dom leaves out, for the browser program (tsconfig.web.json) and the Node programs with DOM
// types. Selector lookups stay typed as lib.dom has them, so each one is cast to the element the page holds.
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
