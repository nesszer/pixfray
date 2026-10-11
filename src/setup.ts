// OBS Browser Source link for this channel (mod controls, Stream setup tab).
// Duel announcements and the on-screen limit are channel settings (src/admin.js), not part of the link, so they change without touching OBS.
import { CHANNEL } from "./ui.ts";
const size = document.querySelector("#size") as HTMLInputElement; // element type from the page HTML
function update() {
  const url = new URL("/overlay.html", location.href);
  url.searchParams.set("channel", CHANNEL);
  url.searchParams.set("size", size.value);
  url.searchParams.set("arena", "1"); // shared duels from the server; remove for the chat-only v1 overlay
  // element types from the page HTML
  (document.querySelector("#obs-url") as HTMLInputElement).value = url.href;
  (document.querySelector("#preview-link") as HTMLAnchorElement).href = url.href; // element type from the page HTML
  url.searchParams.set("demo", "1");
  (document.querySelector("#demo") as HTMLAnchorElement).href = url.href; // element type from the page HTML
  (document.querySelector("#size-label") as HTMLOutputElement).value = size.value + "px"; // element type from the page HTML
}
size.addEventListener("input", update);
// element types from the page HTML
(document.querySelector("#copy") as HTMLButtonElement).addEventListener("click", async () => {
  const input = document.querySelector("#obs-url") as HTMLInputElement; // element type from the page HTML
  const status = document.querySelector("#copy-status") as HTMLParagraphElement; // element type from the page HTML
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
