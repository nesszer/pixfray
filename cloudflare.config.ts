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
      PUBLIC_ORIGIN: bindings.text(testing ? "https://test.chat.miolaf.xyz" : "https://chat.miolaf.xyz")
    }
  })
};
});
