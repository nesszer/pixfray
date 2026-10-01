// OBS Browser Source link for this channel (mod controls, Stream setup tab).
import { CHANNEL } from "./ui.js";
const size = document.querySelector("#size");
const cap = document.querySelector("#cap");
function update() {
  const url = new URL("/overlay.html", location.href);
  url.searchParams.set("channel", CHANNEL);
  url.searchParams.set("size", size.value);
  url.searchParams.set("cap", cap.value);
  url.searchParams.set("arena", "1"); // shared duels from the server; remove for the chat-only v1 overlay
  document.querySelector("#obs-url").value = url.href;
  document.querySelector("#preview-link").href = url.href;
  url.searchParams.set("demo", "1");
  document.querySelector("#demo").href = url.href;
  document.querySelector("#size-label").value = size.value + "px";
}
for (const field of [size, cap]) field.addEventListener("input", update);
document.querySelector("#copy").addEventListener("click", async () => {
  const input = document.querySelector("#obs-url");
  const status = document.querySelector("#copy-status");
  try { await navigator.clipboard.writeText(input.value); status.textContent = "Copied. Paste it into your OBS Browser Source."; }
  catch { input.focus(); input.select(); status.textContent = "Select the URL and copy it with Ctrl+C."; }
});
update();
