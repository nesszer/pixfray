// The ?channel= value as a Twitch login, or "" when it isn't one. Twitch chat takes the punctuation right after a link
// into it ("…/?channel=<login>, then" opens "?channel=<login>,"), so trailing characters a login can't hold are dropped.
/** @param {string | null | undefined} raw */
export function channelParam(raw) {
  const m = /^([a-z0-9_]{1,25})[^a-z0-9_]*$/.exec(
    String(raw || "")
      .trim()
      .toLowerCase(),
  );
  return m ? m[1] : "";
}
