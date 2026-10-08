import test from "node:test";
import assert from "node:assert/strict";
import { channelParam } from "../src/channel-param.js";

test("channelParam reads a login and drops punctuation chat links carry", () => {
  assert.equal(channelParam("miolafff"), "miolafff");
  assert.equal(channelParam("MioLafff"), "miolafff");
  // Twitch chat linkifies "…/?channel=miolafff, then" with the comma.
  for (const tail of [",", ".", "!", ")", "),", "%"]) assert.equal(channelParam("miolafff" + tail), "miolafff", tail);
  for (const bad of [null, undefined, "", ",", "mio lafff", "miolafff,x", "a".repeat(26), "../admin"])
    assert.equal(channelParam(bad), "", String(bad));
});
