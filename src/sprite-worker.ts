// Builds the sprite off the page's main thread for src/sprite-maker.ts: finding the subject takes up to a second,
// which froze the fighter page.
import { spritify } from "./spritify.ts";
import type { Img } from "./spritify.ts";

export type SpriteJob = { id: number; img: Img; removeBg: boolean };
export type SpriteDone = { id: number; sprite: Img | null };

// as: this file runs as a dedicated worker, whose postMessage takes no target origin (tsconfig.web.json has DOM types)
const scope = self as unknown as Worker;
scope.onmessage = ({ data }: MessageEvent<SpriteJob>) =>
  scope.postMessage({ id: data.id, sprite: spritify(data.img, { removeBg: data.removeBg }) } satisfies SpriteDone);
