// OBS Browser Source link for this channel (mod controls, Stream setup tab).
// Duel announcements and the on-screen limit are channel settings (src/admin.ts), not part of the link, so they change without touching OBS.
import { $, CHANNEL } from "./ui.ts";
const size = $<HTMLInputElement>("#size");
function update() {
  const url = new URL("/overlay.html", location.href);
  url.searchParams.set("channel", CHANNEL);
  url.searchParams.set("size", size.value);
  url.searchParams.set("arena", "1"); // shared duels from the server; remove for the chat-only v1 overlay
  $<HTMLInputElement>("#obs-url").value = url.href;
  $<HTMLAnchorElement>("#preview-link").href = url.href;
  url.searchParams.set("demo", "1");
  $<HTMLAnchorElement>("#demo").href = url.href;
  $<HTMLOutputElement>("#size-label").value = size.value + "px";
}
size.addEventListener("input", update);
$<HTMLButtonElement>("#copy").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("#obs-url");
  const status = $<HTMLParagraphElement>("#copy-status");
  try {
    await navigator.clipboard.writeText(input.value);
    status.textContent = "Copied. Paste it into your OBS Browser Source.";
  } catch {
    input.focus();
    input.select();
    status.textContent = "Select the URL and copy it with Ctrl+C.";
  }
});
update();
