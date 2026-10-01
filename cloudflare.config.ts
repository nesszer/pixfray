import { defineConfig, defineWorker, bindings, exports } from "cf/config";
export default defineConfig(({mode}) => {
const testing=mode === 'test';
const name=testing ? 'nesszerra-mini-chat-test' : 'nesszerra-mini-chat';
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
      PUBLIC_ORIGIN: bindings.text(testing ? "https://test.chat.miolaf.xyz" : "https://chat.miolaf.xyz")
    }
  })
};
});
