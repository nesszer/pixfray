import { defineConfig, defineWorker, bindings, exports } from "cf/config";
export default defineConfig(({mode}) => {
const testing=mode === 'test';
const name=testing ? 'nesszerra-mini-chat-test' : 'nesszerra-mini-chat';
// MINI_LOCAL_TEST=1 is only for `cf dev` in scripts/test-all.mjs: chat can then be marked connected without Twitch,
// and PUBLIC_ORIGIN is the loopback dev server. It can never reach a build or a deploy.
const localTest=process.env.MINI_LOCAL_TEST === '1';
if(localTest && (testing || process.argv.some(a => /^(build|deploy|publish|versions)$/.test(a))))throw new Error('MINI_LOCAL_TEST is only allowed with cf dev');
const origin=localTest ? 'http://127.0.0.1:' + (Number(process.env.MINI_PORT) || 5173) : testing ? "https://test.chat.miolaf.xyz" : "https://chat.miolaf.xyz";
return {
  worker: defineWorker({
    name, compatibilityDate: "2026-09-25",
    entrypoint: "./server/worker.js",
    domains: [testing ? "test.chat.miolaf.xyz" : "chat.miolaf.xyz"],
    assets: { runWorkerFirst: ["/api/*","/auth/*"], notFoundHandling:"none" },
    exports: {
      ChannelRoom: exports.durableObject({storage:"sqlite"}),
      AuthStore: exports.durableObject({storage:"sqlite"})
    },
    env: {
      ASSETS: bindings.assets(),
      ROOMS: bindings.durableObject({worker:name,exportName:"ChannelRoom"}),
      AUTH: bindings.durableObject({worker:name,exportName:"AuthStore"}),
      AUTH_SECRET: bindings.secret(), INTERNAL_SECRET: bindings.secret(),
      TWITCH_CLIENT_ID: bindings.secret(), TWITCH_CLIENT_SECRET: bindings.secret(),
      // Live-fix (/admin/dev): current version id. GITHUB_TOKEN, GITHUB_REPO, CF_API_TOKEN and CF_ACCOUNT_ID are optional
      // and set with `wrangler secret put` once the repo exists; declaring them here would make them required (docs/LIVE_FIX.md).
      CF_VERSION_METADATA: bindings.versionMetadata(),
      PUBLIC_ORIGIN: bindings.text(origin),
      // Test site only: owner access for scripts/devtools.mjs (docs/DEVTOOLS.md). Production never declares it.
      ...(testing ? { DEV_TOOLS_TOKEN: bindings.secret() } : {}),
      ...(localTest ? { MINI_LOCAL_TEST: bindings.text('1') } : {})
    }
  })
};
});
