// Someone who picked a stream before gets straight back to it: the intro's "Pick your fighter" links become
// "Back to <channel>" (the fighter page remembers the channel in this browser), and the picker stays one link away.
// Kept apart from main.js so the links change before the 3D scene loads.
let channel = "";
try {
  channel = localStorage.getItem("pixfray:channel") || "";
} catch {}
if (/^[a-z0-9_]{1,25}$/.test(channel)) {
  for (const a of document.querySelectorAll("a[data-pick]")) {
    a.href = "/?channel=" + channel;
    a.textContent = "Back to " + channel;
  }
  const other = document.createElement("a");
  other.className = "link";
  other.href = "/play/";
  other.textContent = "Pick another channel";
  document.querySelector("#hero-actions .btn")?.after(other);
}
