const channel = document.querySelector("#channel");
import { CHANNEL } from "./ui.js";
channel.value = CHANNEL;   // ?channel= from the page URL
const size = document.querySelector("#size");
const cap = document.querySelector("#cap");
function update() {
  const name = channel.value.trim().toLowerCase().replace(/^#/, "");
  const valid = /^[a-z0-9_]{1,25}$/.test(name);
  channel.setCustomValidity(valid ? "" : "Enter a Twitch channel name.");
  const url = new URL("/overlay.html", location.href);
  url.searchParams.set("channel", valid ? name : "nesszerra");
  url.searchParams.set("size", size.value);
  url.searchParams.set("cap", cap.value);
  url.searchParams.set("arena", "1"); // shared duels from the server; remove for the chat-only v1 overlay
  document.querySelector("#obs-url").value = url.href;
  document.querySelector("#preview-link").href = url.href;
  url.searchParams.set("demo","1");
  document.querySelector("#demo").href = url.href;
  document.querySelector("#size-label").value = size.value + "px";
}
for(const field of [channel,size,cap]) field.addEventListener("input",update);
document.querySelector("#copy").addEventListener("click", async () => {
  if (!channel.reportValidity()) return;
  const input = document.querySelector("#obs-url");
  const status = document.querySelector("#copy-status");
  try { await navigator.clipboard.writeText(input.value); status.textContent = "Copied — paste this into your OBS Browser Source."; }
  catch { input.focus(); input.select(); status.textContent = "Select the URL and copy it with Ctrl+C."; }
});
update();
