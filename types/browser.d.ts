// Type checking only (tsconfig.web.json): what lib.dom leaves out or types more narrowly than the pages use it.
export {};

declare global {
  interface ParentNode {
    // The pages look elements up by selector and use them as the element they know it is (an input's value, a
    // canvas's context), so selector lookups are untyped instead of plain Element.
    querySelector(selectors: string): any;
    querySelectorAll(selectors: string): NodeListOf<any>;
  }
  interface Window {
    __arenaMove?: (userId: string, x: number) => void; // overlay ?debug=1 hooks (public/overlay.js)
    __arenaDebug?: () => unknown;
    __intro?: any; // home page test hooks (src/intro/main.js)
    webkitAudioContext?: typeof AudioContext; // older Safari
  }
  interface Navigator {
    connection?: { saveData?: boolean; effectiveType?: string }; // Network Information API, Chromium only
  }
}
