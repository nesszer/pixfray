// The ?channel= value as a Twitch login, or "" when it isn't one. Twitch chat takes the punctuation right after a link
// into it ("…/?channel=<login>, then" opens "?channel=<login>,"), so trailing characters a login can't hold are dropped.
export function channelParam(raw: string | null | undefined): string {
  const m = /^([a-z0-9_]{1,25})[^a-z0-9_]*$/.exec((raw || "").trim().toLowerCase());
  return m ? m[1]! : ""; // group 1 is not optional, so it is set whenever the pattern matched
}
