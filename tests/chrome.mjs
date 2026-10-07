// Launch options for every browser test: headed Chrome (HEADLESS=1 hides it) with WebGL on the GPU, not software.
// Windows open on the second monitor so they stay off the main one; BROWSER_POS="x,y" moves them. --hide-scrollbars
// (which headless Playwright adds itself) keeps widths like a phone's overlay scrollbars.
export const chromeOptions = (extra = []) => ({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--hide-scrollbars', '--window-position=' + (process.env.BROWSER_POS || '-3400,-1000'), ...extra],
});
