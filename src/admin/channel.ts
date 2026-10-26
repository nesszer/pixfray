// The channel's own extras on the Stream setup tab: the bot's text commands and counters, channel point rewards, and
// turning PixFray off.
import { errorText, h, $, setStatus, dateTime, on, onSubmit, busy, button, row, emptyRow, CHANNEL } from "../ui.ts";
import { S, admin, liveChat, mayBroadcast, broadcasterHere, post, load, selectTab, connectLive } from "./state.ts";

// ---------- the bot's own text commands (server/botcommands.ts), shown while the PixFray bot reads chat ----------
let editingCommand = "",
  shownCommands = "";
const COMMAND_ERRORS: Record<string, string | undefined> = {
  command_name_taken: "PixFray already uses that name",
  command_exists: "that command already exists; edit it in the table",
  invalid_command_name: "use 1 to 24 letters, digits or _",
  empty_command_reply: "type a reply",
  command_reply_too_long: "keep the reply under 400 characters",
  too_many_commands: "a channel can have 50 commands",
};
const commandStatus = $("#command-status");
export function renderBotCommands() {
  const a = admin(),
    chat = liveChat(a),
    data = a.botCommands || { commands: [], counters: [] },
    section = $("#bot-commands");
  section.hidden = !(a.chatBot && chat.connected === true && chat.source !== "streamelements");
  const key = JSON.stringify(data),
    focused = document.activeElement;
  // keep a counter being typed into
  if (key === shownCommands || (focused?.tagName === "INPUT" && section.contains(focused.closest("#bot-counters"))))
    return;
  shownCommands = key;
  const commands = data.commands.map((c) =>
    row([
      h("code", {}, c.name),
      c.reply,
      [
        button("Edit", () => editCommand(c.name), { "data-edit": c.name, "aria-label": "Edit " + c.name }),
        " ",
        button("Delete", (b) => deleteCommand(c.name, b), {
          class: "btn btn-small btn-danger",
          "data-delete": c.name,
          "aria-label": "Delete " + c.name,
        }),
      ],
    ]),
  );
  $("#bot-commands-table tbody").replaceChildren(
    ...(commands.length ? commands : [emptyRow(3, "No commands yet. Add one below.")]),
  );
  $("#bot-counters").hidden = !data.counters.length;
  $("#bot-counters-table tbody").replaceChildren(
    ...data.counters.map((c) => {
      const input = h("input", {
        type: "number",
        min: "0",
        max: "1000000000",
        step: "1",
        inputmode: "numeric",
        value: String(c.value),
        "aria-label": "Value of " + c.name,
        "data-counter": c.name,
      });
      const save = button("Save", (b) => saveCounter(c.name, Number(input.value), b), {
        "data-save-counter": c.name,
        "aria-label": "Save " + c.name,
      });
      return row([h("code", {}, c.name), input, save], [1]);
    }),
  );
}
function editCommand(name: string) {
  const c = (admin().botCommands?.commands || []).find((x) => x.name === name);
  editingCommand = c ? c.name : "";
  $<HTMLInputElement>("#command-name").value = c ? c.name : "";
  $<HTMLInputElement>("#command-reply").value = c ? c.reply : "";
  $("#command-save").textContent = c ? "Save changes" : "Add command";
  $("#command-cancel").hidden = !c;
  if (c) $("#command-reply").focus();
}
async function commandAction(action: string, payload: Record<string, unknown>, status: Element) {
  const r = await post({ action, payload });
  if (!r.ok) {
    setStatus(status, `Couldn't save: ${COMMAND_ERRORS[r.data?.error] || errorText(r)}.`, "error");
    return false;
  }
  admin().botCommands = r.data.botCommands;
  renderBotCommands();
  return r.data;
}
onSubmit("#command-form", async () => {
  const name = $<HTMLInputElement>("#command-name").value.trim().toLowerCase().replace(/^!?/, "!"),
    reply = $<HTMLInputElement>("#command-reply").value.trim();
  if (!/^![a-z0-9_]{1,24}$/.test(name))
    return setStatus(commandStatus, "Name the command with 1 to 24 letters, digits or _, like !sens.", "error");
  if (!reply) return setStatus(commandStatus, "Type the reply the bot should send.", "error");
  setStatus(commandStatus, "Saving…");
  const was = editingCommand,
    saved = await busy($<HTMLButtonElement>("#command-save"), () =>
      commandAction("saveCommand", { name, reply, ...(was ? { oldName: was } : {}) }, commandStatus),
    );
  if (!saved) return;
  editCommand("");
  const done = `${was ? "Saved" : "Added"} ${name}. `,
    cut = `With long names or counters it can reach ${saved.longest} characters, so the bot cuts it at ${saved.max}.`;
  if (saved.warning === "reply_may_be_cut") setStatus(commandStatus, done + cut, "warning");
  else setStatus(commandStatus, done + "Type it in chat to try it.", "ok");
});
on("#command-cancel", () => {
  editCommand("");
  setStatus(commandStatus, "");
});
async function deleteCommand(name: string, b: HTMLButtonElement) {
  if (!confirm("Delete " + name + "? Its counter stays.")) return;
  if (!(await busy(b, () => commandAction("deleteCommand", { name }, commandStatus)))) return;
  if (editingCommand === name) editCommand("");
  setStatus(commandStatus, "Deleted " + name + ".", "ok");
}
async function saveCounter(name: string, value: number, b: HTMLButtonElement) {
  const status = $("#counter-status");
  if (!Number.isInteger(value) || value < 0 || value > 1e9)
    return setStatus(status, "Pick a whole number from 0 to 1000000000.", "error");
  if (await busy(b, () => commandAction("setCounter", { name, value }, status)))
    setStatus(status, `Counter ${name} is ${value} now.`, "ok");
}

// ---------- channel point rewards (server/points.ts; the broadcaster or the owner adds and deletes, mods read) ----------
const POINT_OUTCOMES: Record<string, string | undefined> = {
  granted: "Style dollars added",
  refunded: "No saved fighter, points refunded",
  no_fighter: "No saved fighter, not refunded",
  ignored: "Not a PixFray reward",
};
const POINT_ERRORS: Record<string, string | undefined> = {
  invalid_title: "Name the reward with 1 to 45 characters",
  invalid_cost: "Pick a cost from 1 to 1000000 channel points",
  invalid_dollars: "Pick 1 to 10000 dollars",
  points_max_rewards: "A channel can have 5 PixFray rewards. Delete one first",
  points_not_connected: "Twitch needs the channel point permission again. Use Allow channel point rewards",
  reward_not_found: "That reward is already gone",
};
const pointsStatus = $("#points-status");
const usd = (n: number) => "$" + n.toLocaleString("en-US");
let shownPoints = "";
export function renderPoints() {
  const a = admin(),
    p = a.points;
  $("#points").hidden = !p;
  if (!p) return;
  const rewards = Array.isArray(p.rewards) ? p.rewards : [],
    redemptions = Array.isArray(p.redemptions) ? p.redemptions : [],
    max = p.limits?.maxRewards || 5,
    owner = mayBroadcast(),
    ready = !!a.pointsReady;
  // only the broadcaster's own Twitch account can grant the permission, so the site owner elsewhere gets the note instead
  $("#points-connect").hidden = ready || !broadcasterHere();
  $("#points-connect-text").textContent = rewards.length
    ? "Twitch no longer lets PixFray manage these rewards. Allow it again so redemptions add dollars and refunds work."
    : "First let PixFray make rewards on your channel. Twitch asks for one more permission, then you come back here.";
  $<HTMLAnchorElement>("#points-login").href = a.pointsLogin || "#";
  $("#points-form").hidden = !(owner && ready);
  $<HTMLButtonElement>("#points-add").disabled = rewards.length >= max;
  $("#points-note").textContent = !owner
    ? `Only ${CHANNEL} can add or delete rewards.${ready ? "" : " Channel point rewards aren't allowed yet."}`
    : !ready && !broadcasterHere()
      ? CHANNEL + " has to allow channel point rewards, signed in to Twitch as themself."
      : ready && rewards.length >= max
        ? `${max} of ${max} rewards. Delete one to add another.`
        : "";
  const key = JSON.stringify([p, owner]);
  if (key === shownPoints) return;
  shownPoints = key;
  const rewardRows = rewards.map((r) =>
    row(
      [
        r.title,
        r.cost.toLocaleString("en-US"),
        usd(r.dollars),
        owner
          ? button("Delete", (b) => deleteReward(r.rewardId, r.title, b), {
              class: "btn btn-small btn-danger",
              "data-reward": r.rewardId,
              "aria-label": "Delete " + r.title,
            })
          : "",
      ],
      [1, 2],
    ),
  );
  $("#points-table tbody").replaceChildren(...(rewardRows.length ? rewardRows : [emptyRow(4, "No rewards yet.")]));
  const titles = new Map(rewards.map((r) => [r.rewardId, r.title]));
  const redemptionRows = redemptions.map((x) => {
    // marked: 0 until Twitch answers, -1 when PixFray leaves it alone, else Twitch's HTTP status (1: no answer)
    const unmarked = x.marked > 0 && (x.marked < 200 || x.marked > 299);
    const outcome = POINT_OUTCOMES[x.outcome] || x.outcome;
    return row(
      [
        dateTime(x.at),
        x.user,
        titles.get(x.rewardId) || "A deleted reward",
        outcome + (unmarked ? ". Twitch's request queue wasn't updated, so check it there" : ""),
        x.dollars ? usd(x.dollars) : "0",
      ],
      [4],
    );
  });
  $("#points-redemptions tbody").replaceChildren(
    ...(redemptionRows.length ? redemptionRows : [emptyRow(5, "No redemptions yet.")]),
  );
}
async function pointsAction(action: string, payload: Record<string, unknown>) {
  setStatus(pointsStatus, "Working…");
  const r = await post({ action, payload });
  if (!r.ok) {
    setStatus(pointsStatus, `That didn't work: ${POINT_ERRORS[r.data?.reason] || errorText(r)}.`, "error");
    if (r.data?.reason === "points_not_connected") await load();
    return false;
  }
  admin().points = { rewards: r.data.rewards, redemptions: r.data.redemptions, limits: r.data.limits };
  renderPoints();
  return true;
}
onSubmit("#points-form", async () => {
  const title = $<HTMLInputElement>("#points-title-input").value.trim(),
    cost = Number($<HTMLInputElement>("#points-cost").value),
    dollars = Number($<HTMLInputElement>("#points-dollars").value);
  const bad = (code: string) => setStatus(pointsStatus, POINT_ERRORS[code] + ".", "error");
  if (!title || title.length > 45) return bad("invalid_title");
  if (!Number.isInteger(cost) || cost < 1 || cost > 1e6) return bad("invalid_cost");
  if (!Number.isInteger(dollars) || dollars < 1 || dollars > 1e4) return bad("invalid_dollars");
  const ok = await busy($<HTMLButtonElement>("#points-add"), () =>
    pointsAction("createPointReward", { title, cost, dollars }),
  );
  renderPoints();
  if (!ok) return;
  $<HTMLFormElement>("#points-form").reset();
  setStatus(pointsStatus, `Added ${title}. It shows under channel points on Twitch now.`, "ok");
});
async function deleteReward(rewardId: string, title: string, b: HTMLButtonElement) {
  if (!confirm("Delete " + title + "? It disappears from Twitch too. Dollars already added stay.")) return;
  if (await busy(b, () => pointsAction("deletePointReward", { rewardId })))
    setStatus(pointsStatus, "Deleted " + title + ".", "ok");
}

// ---------- turning PixFray off (signed-up channels; the broadcaster or the owner, and only the owner undoes the owner's off) ----------
// undefined is simply not in the list, as before
const mayPower = () => mayBroadcast() && ["on", "paused"].includes(S.admin?.channelState as string);
const powerToggle = $<HTMLButtonElement>("#power-toggle"),
  powerStatus = $("#power-status");
export function renderPower() {
  const paused = admin().channelState === "paused";
  $("#channel-power").hidden = !mayPower();
  $("#power-title").textContent = paused ? "PixFray is off on " + CHANNEL : "Turn PixFray off";
  $("#power-text").textContent = paused
    ? "The overlay, the chat commands and the viewer page are stopped. Fighters and ranks are kept, so turning it back on picks up where it left off."
    : `Stops the overlay, the chat commands and the viewer page on ${CHANNEL}. ` +
      "Fighters and ranks are kept, and you can turn it back on here at any time.";
  powerToggle.textContent = paused ? "Turn PixFray back on" : "Turn PixFray off";
  powerToggle.className = paused ? "btn btn-primary" : "btn btn-danger";
  const note = $("#paused-note");
  note.hidden = !paused;
  if (paused)
    note.replaceChildren(
      "PixFray is off on " + CHANNEL + ": the overlay, the commands and the viewer page are stopped. ",
      mayPower()
        ? h(
            "a",
            {
              href: "#chat",
              onclick: (e: Event) => {
                e.preventDefault();
                selectTab($("#tab-chat"));
                $("#channel-power").scrollIntoView({ block: "center" });
                powerToggle.focus({ preventScroll: true });
              },
            },
            "Turn it back on",
          )
        : CHANNEL + " can turn it back on.",
    );
}
on("#power-toggle", async (b) => {
  const pause = admin().channelState !== "paused";
  const stops = "The overlay, the commands and the viewer page stop until you turn it back on.";
  if (pause && !confirm(`Turn PixFray off on ${CHANNEL}? ${stops} Fighters and ranks are kept.`)) return;
  const r = await busy(b, () => post({ action: pause ? "pauseChannel" : "resumeChannel" }));
  if (!r.ok) return setStatus(powerStatus, "Couldn't change it: " + errorText(r) + ".", "error");
  setStatus(
    powerStatus,
    pause
      ? "PixFray is off. Overlays and chat commands stop within a minute."
      : "PixFray is back on. Refresh the OBS source if the overlay stays empty.",
    "ok",
  );
  await load();
  if (!pause && !S.socket) connectLive();
});
