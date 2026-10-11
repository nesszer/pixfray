// Owner page (/admin/dev/, Lane E). Owner-only page over /api/dev/* (server/developer.ts). No framework.
// T names the element the page HTML holds at that selector; every selector here is in admin/dev/index.html.
const $ = (s: string) => document.querySelector(s);
// The /api/dev/* answers this page reads; api() data is any until TS20, so these name only the fields it uses.
type Progress = {
  source?: string;
  overlays: number;
  duelModuleOff?: boolean;
  duelCommands?: boolean;
  rejectedAt: number;
  lastCommandAt: number;
  lastChatAt: number;
  commandsWorking: number;
  commands: number;
};
type Channel = {
  login: string;
  pausedAt?: number | null;
  pausedBy?: string;
  review?: { reasons: string[]; at: number };
};
type Channels = { max: number; builtin: string[]; channels: Channel[]; progressBatch?: number };
// One target's entry in the /api/dev/versions body (server/developer.ts versions()).
type TargetVersions = {
  deployments: { createdOn: string; message?: string; versions: { versionId: string; percentage: number }[] }[];
  versions: { id: string; number?: number; tag?: string; createdOn?: string }[];
  error?: string;
};
type Integration = { configured?: boolean; repo?: string; missing?: string[]; versionMetadata?: boolean };
type Run = {
  createdAt: string;
  url: string;
  title?: string;
  id: number;
  branch?: string;
  conclusion?: string | null;
  status: string;
};
type ConfigVersion = { version: number; at: number; actorName?: string; actorId?: string; note?: string };
type LogRow = { at: number; source: string; message: string; context?: unknown };
type SourceLabels = Record<string, string | undefined>;
type ApiResult = Awaited<ReturnType<typeof api>>;
const S: {
  session: unknown;
  diag: unknown;
  config: Record<string, unknown> | null;
  configVersion: number;
  fileSha: string;
  fileRef: string;
  filePath?: string;
  progress: Record<string, Progress>;
  progressRun?: number;
  progressTotal?: number;
  progressSeen?: number;
  progressLoading?: boolean;
  versions?: Record<string, TargetVersions> | null;
  channels?: Channels;
  restoreLoaded?: boolean;
} = { session: null, diag: null, config: null, configVersion: 0, fileSha: "", fileRef: "", progress: {} };
// Owner, default channel and sites, from site.config.js through the page's <html data-site-*> attributes.
const SITE = (({ siteOwner, siteChannel, siteOrigin, siteTestOrigin }) => ({
  owner: siteOwner,
  channel: siteChannel,
  origin: siteOrigin,
  testOrigin: siteTestOrigin,
}))(
  // the page's <html> carries all four data-site-* attributes (vite.config.js fills them from site.config.js)
  document.documentElement.dataset as {
    siteOwner: string;
    siteChannel: string;
    siteOrigin: string;
    siteTestOrigin: string;
  },
);
const LOGIN = "/auth/login?next=%2Fadmin%2Fdev%2F"; // come back here after signing in, not to the viewer page

async function api(
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
  // data is any: the parsed JSON body, read per route below (typed per route in TS20, as in src/ui.ts)
): Promise<{ ok: boolean; status: number; data: any }> {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, data: { error: "Network error; check your connection" } };
  }
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { ok: r.ok, status: r.status, data };
}
// r.data is any: api()'s parsed body, untyped until TS20
const errorText = (r: { status: number; data: any }, fallback = "Request failed") =>
  r.data?.error || (r.status ? `${fallback} (HTTP ${r.status})` : fallback);
// Tiny DOM builder; returns the element type of the tag, like h() in src/ui.ts.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: unknown[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v as string; // callers pass the class list as a string
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v as EventListener); // on* attrs are event handlers
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
function status(id: string, msg: string, kind = "") {
  // every status id names an element on the page
  const n = $(id) as HTMLElement;
  n.textContent = msg || "";
  n.className = "status" + (kind ? " " + kind : "");
}
const fmtTime = (v: number | string | null | undefined) => {
  if (!v) return "–";
  const d = new Date(v);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtNum = (n: unknown) => Number(n).toLocaleString("en-US");
const ago = (t: number | null | undefined) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1
    ? "just now"
    : m < 60
      ? m + " min ago"
      : m < 2880
        ? Math.round(m / 60) + " h ago"
        : Math.round(m / 1440) + " days ago";
};
const short = (id: unknown) => (id ? String(id).slice(0, 8) : "–");
function rows(tbody: string, list: Node[], empty: string, cols: number) {
  // every rows() target is a tbody on the page
  const t = $(tbody) as HTMLTableSectionElement;
  t.replaceChildren();
  if (!list.length) {
    t.append(h("tr", {}, h("td", { colspan: cols, class: "muted" }, empty)));
    return;
  }
  for (const r of list) t.append(r);
}
async function busy(button: HTMLButtonElement, fn: () => Promise<unknown>) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

// ---------- access ----------
async function start() {
  const s = await api("/api/session");
  S.session = s.data;
  // element type from the page HTML
  const who = $("#who") as HTMLDivElement;
  who.replaceChildren();
  if (s.data?.user)
    who.append(
      h("span", {}, "Signed in as " + s.data.user.displayName),
      h("button", { class: "btn btn-small", type: "button", onclick: signOut }, "Sign out"),
    );
  // signed out: the gate holds the one sign-in button
  if (!s.ok) return gate(errorText(s, "The server is unreachable"), []);
  if (!s.data.user)
    return gate("Sign in with the " + SITE.owner + " Twitch account to open the owner page.", [
      h("a", { class: "btn btn-primary", href: LOGIN }, "Sign in with Twitch"),
    ]);
  if (!s.data.owner)
    return gate("The owner page is limited to the " + SITE.owner + " account. Moderators can use Mod controls.", [
      h("a", { class: "btn", href: "/admin/" }, "Open mod controls"),
    ]);
  // element type from the page HTML
  ($("#gate") as HTMLElement).hidden = true;
  // element type from the page HTML
  ($("#app") as HTMLDivElement).hidden = false;
  // element type from the page HTML
  if (!($("#branch") as HTMLInputElement).value)
    // element type from the page HTML
    ($("#branch") as HTMLInputElement).value = "live-fix/" + new Date().toISOString().slice(0, 10);
  await Promise.all([loadDiagnostics(), loadConfig(), loadLogs(), loadChannels()]);
  loadRuns();
  loadVersions();
}
function gate(text: string, actions: Node[]) {
  // element type from the page HTML
  ($("#gate-text") as HTMLParagraphElement).textContent = text;
  // element type from the page HTML
  ($("#gate-actions") as HTMLDivElement).replaceChildren(...actions);
  // element type from the page HTML
  ($("#gate") as HTMLElement).hidden = false;
  // element type from the page HTML
  ($("#app") as HTMLDivElement).hidden = true;
}
async function signOut() {
  await api("/auth/logout", { method: "POST", body: {} });
  location.reload();
}

// ---------- diagnostics ----------
async function loadDiagnostics() {
  const r = await api("/api/dev/diagnostics");
  if (!r.ok) {
    // element type from the page HTML
    ($("#summary-title") as HTMLHeadingElement).textContent = "Diagnostics unavailable";
    // element type from the page HTML
    ($("#summary-text") as HTMLParagraphElement).textContent = errorText(r);
    return;
  }
  const d = (S.diag = r.data),
    room = d.room || {},
    use = d.usage || {},
    chat = room.chatStatus || {};
  // StreamElements counts as working only once a command has arrived; picking it as the source isn't enough.
  const se = chat.connected && chat.source === "streamelements",
    chatOn = chat.connected && (!se || room.seLastCommandAt > 0);
  // element type from the page HTML
  ($("#s-chat") as HTMLDivElement).textContent = !chat.connected ? "Offline" : se ? "StreamElements" : "Twitch chat";
  // element type from the page HTML
  ($("#s-chat") as HTMLDivElement).className = "value " + (chatOn ? "up" : "down");
  // element type from the page HTML
  ($("#s-chat-note") as HTMLDivElement).textContent = chat.lastRevocationReason
    ? "Revoked: " + chat.lastRevocationReason
    : se
      ? room.seLastCommandAt
        ? "Last command " + ago(room.seLastCommandAt)
        : "No command has arrived yet"
      : chat.lastNotificationAt
        ? "Last message " + ago(chat.lastNotificationAt)
        : chatOn
          ? "No chat message yet"
          : "Connect chat in Mod controls";
  if (use.configured && Number.isFinite(use.requests)) {
    // element type from the page HTML
    ($("#s-requests") as HTMLDivElement).textContent = fmtNum(use.requests);
    // element type from the page HTML
    ($("#s-requests-note") as HTMLDivElement).textContent = use.percent + "% used, resets " + fmtTime(use.resetsAt);
    // element type from the page HTML
    ($("#s-requests-note") as HTMLDivElement).className = "delta" + (use.percent >= 80 ? " down" : "");
  } else {
    // element type from the page HTML
    ($("#s-requests") as HTMLDivElement).textContent = "Unknown";
    // element type from the page HTML
    ($("#s-requests-note") as HTMLDivElement).textContent = use.configured
      ? use.error || "Analytics unavailable"
      : "Cloudflare API not configured";
  }
  // element type from the page HTML
  ($("#s-errors") as HTMLDivElement).textContent = fmtNum(room.errors ?? 0);
  // element type from the page HTML
  ($("#s-errors-note") as HTMLDivElement).textContent = room.lastError
    ? "Latest " + fmtTime(room.lastError.at)
    : "None stored";
  // element type from the page HTML
  ($("#s-errors-note") as HTMLDivElement).className = "delta" + (room.errors ? " down" : "");
  // element type from the page HTML
  ($("#s-sockets") as HTMLDivElement).textContent = fmtNum(room.sockets?.live ?? 0);
  // element type from the page HTML
  ($("#s-sockets-note") as HTMLDivElement).textContent =
    `${room.players ?? 0} players, ${room.openDuels ?? 0} open duels`;
  const ver = d.worker?.deployedVersion;
  // element type from the page HTML
  ($("#meta") as HTMLParagraphElement).textContent =
    `Worker ${d.worker?.version || ""}` +
    (ver ? ` · version ${short(ver.id)}${ver.tag ? " (" + ver.tag + ")" : ""}` : " · version id unavailable") +
    ` · checked ${fmtTime(Date.now())}`;
  const parts = [
    chatOn
      ? SITE.channel + " chat is connected"
      : se
        ? SITE.channel +
          " uses StreamElements, but no command has arrived yet; fix it on the Stream setup tab of Mod controls"
        : SITE.channel + " chat is not connected, so duels are paused",
    room.errors ? `${room.errors} errors are logged` : "no errors are logged",
  ];
  if (use.configured && Number.isFinite(use.requests))
    parts.push(`${fmtNum(use.requests)} of 100,000 daily requests are used (${use.percent}%)`);
  // element type from the page HTML
  ($("#summary-title") as HTMLHeadingElement).textContent = !chatOn
    ? "Site is up; " + SITE.channel + " chat offline"
    : room.errors
      ? `Site is up, with ${room.errors} logged errors`
      : "Site is running normally";
  // element type from the page HTML
  ($("#summary-text") as HTMLParagraphElement).textContent = parts.join("; ") + ".";
  renderIntegrations(d.integrations || {});
}

function renderIntegrations(i: { github?: Integration; cloudflare?: Integration }) {
  const g: Integration = i.github || {},
    c: Integration = i.cloudflare || {};
  const badge = (ok: boolean | undefined) =>
    h("span", { class: "badge " + (ok ? "positive" : "warning") }, ok ? "Configured" : "Not configured");
  rows(
    "#integrations",
    [
      h(
        "tr",
        {},
        h("td", {}, "GitHub" + (g.repo ? " (" + g.repo + ")" : "")),
        h("td", {}, badge(g.configured)),
        h("td", {}, (g.missing || []).join(", ") || "–"),
        h("td", {}, "Code editor, deploy, promote, hotfix, rollback"),
      ),
      h(
        "tr",
        {},
        h("td", {}, "Cloudflare API (read-only)"),
        h("td", {}, badge(c.configured)),
        h("td", {}, (c.missing || []).join(", ") || "–"),
        h("td", {}, "Request usage, Worker versions"),
      ),
      h(
        "tr",
        {},
        h("td", {}, "Version metadata binding"),
        h("td", {}, badge(c.versionMetadata)),
        h("td", {}, c.versionMetadata ? "–" : "CF_VERSION_METADATA"),
        h("td", {}, "Showing the version that served this page"),
      ),
    ],
    "",
    4,
  );
  // element type from the page HTML
  const missing = $("#github-missing") as HTMLParagraphElement;
  missing.hidden = !!g.configured;
  missing.textContent = g.configured
    ? ""
    : "GitHub is not configured yet (" +
      (g.missing || []).join(", ") +
      "), so saving, deploying and rolling back are unavailable. See docs/LIVE_FIX.md.";
  for (const id of [
    "#deploy-test",
    "#promote",
    "#rollback",
    "#hotfix",
    "#save-file",
    "#open-pr",
    "#load-file",
    "#load-tree",
  ])
    // every id in the list is a button on the page
    ($(id) as HTMLButtonElement).disabled = !g.configured;
  // Without GitHub, releases happen from a local checkout (gh and cf CLIs), so the editor and release steps stay out of the way.
  // element type from the page HTML
  ($("#sec-code") as HTMLElement).hidden = ($("#sec-release") as HTMLElement).hidden = !g.configured;
  // element type from the page HTML
  ($("#local-release") as HTMLParagraphElement).hidden = !!g.configured;
  // element type from the page HTML
  ($("#dev-tools-title") as HTMLElement).textContent = g.configured
    ? "Developer tools: code editor, releases and raw settings"
    : "Developer tools: raw settings and integrations";
}

// ---------- release ----------
function branch() {
  // element type from the page HTML
  return ($("#branch") as HTMLInputElement).value.trim();
}
function released(r: ApiResult, what: string) {
  if (!r.ok) return status("#release-status", errorText(r, what + " failed"), "error");
  const extra = r.data.merged ? ` Merged #${r.data.merged.number}.` : "";
  const pr = r.data.pr
    ? ` Pull request #${r.data.pr.number} is open for main.`
    : r.data.prError
      ? " " + r.data.prError + "."
      : "";
  status("#release-status", `${what} started (run ${r.data.requestId}).${extra}${pr} Watch the run below.`, "ok");
  setTimeout(loadRuns, 4000);
}
// element type from the page HTML
($("#deploy-test") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    released(await api("/api/dev/deploy", { method: "POST", body: { ref: branch() } }), "Test deploy of " + branch());
  }),
);
// element type from the page HTML
($("#promote") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    // element type from the page HTML
    const number = ($("#pr-number") as HTMLInputElement).value
        ? // element type from the page HTML
          Number(($("#pr-number") as HTMLInputElement).value)
        : undefined,
      // element type from the page HTML
      percentage = Number(($("#percentage") as HTMLInputElement).value || 100);
    const what = number ? `merge #${number} and deploy main` : "deploy main as it is";
    if (!confirm(`Promote to ${new URL(SITE.origin).host}: ${what}, ${percentage}% of traffic?`)) return;
    released(
      await api("/api/dev/promote", { method: "POST", body: { ...(number ? { number } : {}), percentage } }),
      "Promote",
    );
  }),
);
// element type from the page HTML
($("#hotfix") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    if (!branch().startsWith("hotfix/"))
      return status("#release-status", "Set the branch to hotfix/<name> in the code editor first.", "error");
    if (!confirm(`Deploy ${branch()} straight to ${new URL(SITE.origin).host} without the test site?`)) return;
    released(await api("/api/dev/hotfix", { method: "POST", body: { branch: branch() } }), "Hotfix");
  }),
);
// element type from the page HTML
($("#rollback") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    // element type from the page HTML
    const target = ($("#rb-target") as HTMLSelectElement).value,
      // element type from the page HTML
      versionId = ($("#rb-version") as HTMLSelectElement).value;
    if (
      !confirm(
        `Roll back ${new URL(target === "production" ? SITE.origin : SITE.testOrigin).host} to ${versionId ? short(versionId) : "the previous deployment"}?`,
      )
    )
      return;
    released(
      await api("/api/dev/rollback", { method: "POST", body: { target, ...(versionId ? { versionId } : {}) } }),
      "Rollback",
    );
  }),
);
// element type from the page HTML
($("#rb-target") as HTMLSelectElement).addEventListener("change", fillVersions);

async function loadRuns() {
  const r = await api("/api/dev/runs");
  if (!r.ok) return rows("#runs", [], errorText(r, "Runs unavailable"), 4);
  rows(
    "#runs",
    // /api/dev/runs body: the recent deploy workflow runs
    (r.data as Run[]).map((x) =>
      h(
        "tr",
        {},
        h("td", {}, fmtTime(x.createdAt)),
        h("td", { class: "wrap" }, h("a", { href: x.url, target: "_blank", rel: "noopener" }, x.title || String(x.id))),
        h("td", {}, x.branch || "–"),
        h(
          "td",
          {},
          h(
            "span",
            { class: "badge " + (x.conclusion === "success" ? "positive" : x.conclusion ? "negative" : "warning") },
            x.conclusion || x.status,
          ),
        ),
      ),
    ),
    "No deploy runs yet.",
    4,
  );
}
async function loadVersions() {
  const r = await api("/api/dev/versions");
  // /api/dev/versions body when ok
  S.versions = r.ok ? (r.data as Record<string, TargetVersions>) : null;
  if (!r.ok) {
    rows("#deployments", [], errorText(r, "Versions unavailable"), 5);
    return fillVersions();
  }
  const list = [];
  // /api/dev/versions body, keyed by target
  for (const [target, v] of Object.entries(r.data as Record<string, TargetVersions>)) {
    const d = v.deployments[0];
    if (!d) {
      list.push(h("tr", {}, h("td", {}, target), h("td", { colspan: 4, class: "muted" }, v.error || "No deployments")));
      continue;
    }
    for (const x of d.versions)
      list.push(
        h(
          "tr",
          {},
          h("td", {}, target),
          h("td", {}, h("code", {}, short(x.versionId))),
          h("td", { class: "num" }, x.percentage),
          h("td", {}, fmtTime(d.createdOn)),
          h("td", { class: "wrap" }, d.message || "–"),
        ),
      );
  }
  rows("#deployments", list, "No deployments.", 5);
  fillVersions();
}
function fillVersions() {
  // element type from the page HTML
  const sel = $("#rb-version") as HTMLSelectElement,
    // element type from the page HTML
    versions = S.versions?.[($("#rb-target") as HTMLSelectElement).value]?.versions || [];
  sel.replaceChildren(
    h("option", { value: "" }, "Previous deployment"),
    ...versions.map((v) =>
      h("option", { value: v.id }, `#${v.number ?? "?"} ${short(v.id)} ${v.tag || ""} ${fmtTime(v.createdOn)}`.trim()),
    ),
  );
}

// ---------- code editor ----------
// element type from the page HTML
($("#load-tree") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    const r = await api("/api/dev/code/tree?ref=" + encodeURIComponent(branch() || "main"));
    const r2 = r.ok ? r : await api("/api/dev/code/tree");
    if (!r2.ok) return status("#code-status", errorText(r2, "Could not list files"), "error");
    // element type from the page HTML
    ($("#files") as HTMLDataListElement).replaceChildren(
      // /api/dev/code/tree body: the repo's file list
      ...(r2.data.files as { path: string }[]).map((f) => h("option", { value: f.path })),
    );
    status("#code-status", `${r2.data.files.length} files on ${r2.data.ref}. Start typing a path in File.`, "ok");
  }),
);
// element type from the page HTML
($("#load-file") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    // element type from the page HTML
    const path = ($("#path") as HTMLInputElement).value.trim();
    if (!path) return status("#code-status", "Enter a file path.", "error");
    const r = await api(
      "/api/dev/code/file?path=" +
        encodeURIComponent(path) +
        (branch() ? "&branch=" + encodeURIComponent(branch()) : ""),
    );
    if (!r.ok) return status("#code-status", errorText(r, "Could not load the file"), "error");
    // element type from the page HTML
    ($("#editor") as HTMLTextAreaElement).value = r.data.content;
    S.fileSha = r.data.sha;
    S.fileRef = r.data.ref;
    S.filePath = path;
    // element type from the page HTML
    ($("#file-info") as HTMLSpanElement).textContent = `${path} from ${r.data.ref} (${fmtNum(r.data.size)} bytes)`;
    status(
      "#code-status",
      r.data.ref === branch()
        ? "Loaded from the branch."
        : `The branch doesn't exist yet; loaded from ${r.data.ref}. Saving creates the branch.`,
      "ok",
    );
  }),
);
// element type from the page HTML
($("#save-file") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    // element type from the page HTML
    const path = ($("#path") as HTMLInputElement).value.trim();
    if (!path || path !== S.filePath)
      return status("#code-status", "Load the file first so the save is based on its current version.", "error");
    const r = await api("/api/dev/code/save", {
      method: "POST",
      body: {
        path,
        branch: branch(),
        // element type from the page HTML
        content: ($("#editor") as HTMLTextAreaElement).value,
        sha: S.fileSha,
        // element type from the page HTML
        message: ($("#commit-msg") as HTMLInputElement).value.trim() || undefined,
      },
    });
    if (!r.ok) return status("#code-status", errorText(r, "Save failed"), "error");
    S.fileSha = r.data.sha;
    S.fileRef = r.data.branch;
    // element type from the page HTML
    ($("#file-info") as HTMLSpanElement).textContent = `${path} on ${r.data.branch}`;
    status(
      "#code-status",
      `Saved to ${r.data.branch}${r.data.branchCreated ? " (new branch)" : ""}, commit ${String(r.data.commit).slice(0, 7)}. Next: deploy the branch to test.`,
      "ok",
    );
  }),
);
// element type from the page HTML
($("#open-pr") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    const r = await api("/api/dev/code/pr", {
      method: "POST",
      // element type from the page HTML
      body: { branch: branch(), title: ($("#commit-msg") as HTMLInputElement).value.trim() || undefined },
    });
    if (!r.ok) return status("#code-status", errorText(r, "Could not open the pull request"), "error");
    // element type from the page HTML
    ($("#pr-number") as HTMLInputElement).value = r.data.number;
    // element type from the page HTML
    const s = $("#code-status") as HTMLParagraphElement;
    s.className = "status ok";
    s.replaceChildren(
      `Pull request #${r.data.number} ${r.data.existing ? "is already open" : "opened"}: `,
      h("a", { href: r.data.url, target: "_blank", rel: "noopener" }, r.data.url),
      ". Its number is filled in under Promote.",
    );
  }),
);

// ---------- live settings ----------
async function loadConfig() {
  const r = await api("/api/dev/settings");
  if (!r.ok) return status("#config-status", errorText(r, "Could not load settings"), "error");
  S.config = r.data.config;
  S.configVersion = r.data.configVersion;
  // element type from the page HTML
  ($("#config") as HTMLTextAreaElement).value = JSON.stringify(r.data.config, null, 2);
  // element type from the page HTML
  ($("#config-version") as HTMLSpanElement).textContent = "version " + r.data.configVersion;
  // element type from the page HTML
  ($("#history-title") as HTMLElement).textContent = "Config history (" + (r.data.history || []).length + " versions)";
  rows(
    "#history",
    // /api/dev/settings body: the saved config versions
    ((r.data.history || []) as ConfigVersion[]).map((x) =>
      h(
        "tr",
        {},
        h("td", { class: "num" }, "v" + x.version),
        h("td", {}, fmtTime(x.at)),
        h("td", {}, x.actorName || x.actorId || "–"),
        h("td", { class: "wrap" }, x.note || "–"),
        h(
          "td",
          {},
          x.version === r.data.configVersion
            ? h("span", { class: "muted small" }, "Current")
            : h(
                "button",
                { class: "btn btn-small", type: "button", onclick: () => rollbackConfig(x.version) },
                "Restore v" + x.version,
              ),
        ),
      ),
    ),
    "No history yet.",
    5,
  );
}
async function rollbackConfig(version: number) {
  if (!confirm(`Restore config v${version} as a new version?`)) return;
  const r = await api("/api/dev/settings", {
    method: "POST",
    body: { action: "rollbackConfig", payload: { version } },
  });
  status("#config-status", r.ok ? `Restored v${version}.` : errorText(r, "Restore failed"), r.ok ? "ok" : "error");
  if (r.ok) loadConfig();
}
// element type from the page HTML
($("#reload-config") as HTMLButtonElement).addEventListener("click", () => {
  status("#config-status", "");
  loadConfig();
});
// element type from the page HTML
($("#save-config") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    let next;
    try {
      // element type from the page HTML
      next = JSON.parse(($("#config") as HTMLTextAreaElement).value);
    } catch (err) {
      // JSON.parse throws a SyntaxError, which is an Error
      return status("#config-status", "Config is not valid JSON: " + (err as Error).message, "error");
    }
    if (!next || typeof next !== "object" || Array.isArray(next))
      return status("#config-status", "Config must be a JSON object.", "error");
    const patch = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(S.config?.[k])),
    );
    if (!Object.keys(patch).length) return status("#config-status", "Nothing changed.", "");
    const r = await api("/api/dev/settings", {
      method: "POST",
      body: {
        action: "config",
        // element type from the page HTML
        payload: { patch, baseVersion: S.configVersion, note: ($("#config-note") as HTMLInputElement).value.trim() },
      },
    });
    if (r.status === 409) {
      status("#config-status", "Someone else saved a newer version. Reloaded it; reapply your change.", "error");
      return loadConfig();
    }
    if (!r.ok) return status("#config-status", errorText(r, "Save failed"), "error");
    status("#config-status", `Saved ${Object.keys(patch).join(", ")}.`, "ok");
    // element type from the page HTML
    ($("#config-note") as HTMLInputElement).value = "";
    loadConfig();
  }),
);

// ---------- channels (server/channels.ts) ----------
async function loadChannels() {
  const r = await api("/api/dev/channels");
  if (!r.ok) return rows("#channels", [], errorText(r, "Channels unavailable"), 7);
  S.progress = {};
  renderChannels(r.data);
  loadProgress(r.data);
}
// Setup progress is one room read per channel, so the server answers for 40 channels at a time (the Free plan
// allows 50 subrequests per request). Rows fill in as each batch arrives; a newer load cancels an older one.
async function loadProgress(d: Channels, only?: string[]) {
  const size = d.progressBatch || 40,
    run = only ? S.progressRun : (S.progressRun = (S.progressRun || 0) + 1);
  const logins = only || [...d.builtin, ...d.channels.filter((c) => !c.pausedAt).map((c) => c.login)];
  if (!only) {
    S.progressTotal = logins.length;
    S.progressSeen = 0;
    S.progressLoading = true;
  }
  for (let i = 0; i < logins.length; i += size) {
    const r = await api("/api/dev/progress?logins=" + logins.slice(i, i + size).join(","));
    if (run !== S.progressRun) return;
    if (r.ok) Object.assign(S.progress, r.data.progress);
    else status("#channel-status", errorText(r, "Could not read setup progress"), "error");
    if (!only) S.progressSeen = Math.min(i + size, logins.length);
    if (i + size < logins.length) renderChannels(S.channels!); // S.channels!: renderChannels(d) ran before any progress load
  }
  if (!only) S.progressLoading = false;
  renderChannels(S.channels!); // S.channels!: as above
}
function channelAction(action: string, login: string, button: HTMLButtonElement, approve = false) {
  if (
    action === "pause" &&
    !confirm(
      "Turn PixFray off on " + login + "? The overlay, commands and viewer page stop; fighters and ranks are kept.",
    )
  )
    return;
  return busy(button, async () => {
    const r = await api("/api/dev/channels", { method: "POST", body: { action, login } });
    if (!r.ok) return status("#channel-status", errorText(r, "Could not change " + login), "error");
    status(
      "#channel-status",
      login + (action === "pause" ? " is off." : approve ? " is approved and on." : " is on."),
      "ok",
    );
    renderChannels(r.data);
    if (action === "resume") loadProgress(r.data, [login]);
  });
}
// The same three steps as the Stream setup checklist in Mod controls (src/admin.ts setupSteps).
function setupOf(p: Progress | null | undefined) {
  if (!p) return null;
  const twitch = p.source === "twitch";
  return [p.overlays > 0, twitch || p.duelModuleOff, twitch || p.duelCommands].filter(Boolean).length;
}
function chatCell(p: Progress | null | undefined) {
  if (!p) return "–";
  if (p.source === "twitch") return "Twitch chat";
  if (p.rejectedAt > p.lastCommandAt) return h("span", { class: "badge warning" }, "Old key: copy replies again");
  return p.commandsWorking + " of " + p.commands + " commands working";
}
// Why a sign-up waits for approval (server/channels.ts reviewReasons).
const REVIEW: Record<string, string | undefined> = {
  young: "Twitch account under 30 days old",
  never_streamed: "no past broadcast, not Affiliate or Partner",
  unchecked: "past broadcasts couldn't be checked",
};
// c.review!: only rows waiting for approval show the reasons
const reviewText = (c: Channel) => c.review!.reasons.map((r) => REVIEW[r] || r).join("; ");
function renderChannels(d: Channels) {
  S.channels = d;
  // element type from the page HTML
  ($("#channels-max") as HTMLSpanElement).textContent = d.max as unknown as string; // as it was: the DOM turns the number into text
  const admin = (login: string) => h("a", { href: "/admin/?channel=" + login + "#chat" }, login);
  const row = (login: string, state: "builtin" | "on" | "off", c?: Channel) => {
    const p = state === "off" ? null : S.progress[login],
      steps = setupOf(p);
    return h(
      "tr",
      {},
      h("td", {}, admin(login)),
      h(
        "td",
        {},
        h(
          "span",
          { class: "badge " + (state === "off" ? "warning" : state === "on" ? "positive" : "") },
          c?.review
            ? "Waiting for approval"
            : state === "off" && c?.pausedBy === "owner"
              ? "Off (by you)"
              : { builtin: "Built in", on: "On", off: "Off" }[state],
        ),
        c?.review ? h("div", { class: "small muted" }, reviewText(c)) : null,
      ),
      h(
        "td",
        {},
        steps === null
          ? "–"
          : h(
              "span",
              { class: "badge " + (steps === 3 ? "positive" : "") },
              steps === 3 ? "Done" : steps + " of 3 steps",
            ),
      ),
      h("td", {}, p ? (p.overlays ? p.overlays + " open" : "Not open") : "–"),
      h("td", {}, chatCell(p)),
      h(
        "td",
        {},
        p
          ? ago(Math.max(p.lastCommandAt, p.lastChatAt))
          : c?.review
            ? "Signed up " + fmtTime(c.review.at)
            : c?.pausedAt
              ? "Off since " + fmtTime(c.pausedAt)
              : "–",
      ),
      h(
        "td",
        {},
        h(
          "div",
          { class: "toolbar" },
          c
            ? h(
                "button",
                {
                  class: "btn btn-small",
                  type: "button",
                  onclick: (e: Event) =>
                    channelAction(
                      c.pausedAt ? "resume" : "pause",
                      c.login,
                      // the handler sits on this button
                      e.currentTarget as HTMLButtonElement,
                      !!c.review,
                    ),
                },
                c.review ? "Approve" : c.pausedAt ? "Turn on" : "Turn off",
              )
            : null,
          h(
            "a",
            {
              class: "btn btn-small",
              href: "/api/dev/export?channel=" + encodeURIComponent(login),
              download: "",
              "aria-label": "Export " + login,
            },
            "Export",
          ),
        ),
      ),
    );
  };
  // channels waiting for approval come first
  const waiting = d.channels.filter((c) => c.review);
  rows(
    "#channels",
    [
      ...waiting.map((c) => row(c.login, "off", c)),
      ...d.builtin.map((login) => row(login, "builtin")),
      ...d.channels.filter((c) => !c.review).map((c) => row(c.login, c.pausedAt ? "off" : "on", c)),
    ],
    "No channels.",
    7,
  );
  const on = d.builtin.length + d.channels.filter((c) => !c.pausedAt).length;
  const done = Object.values(S.progress).filter((p) => setupOf(p) === 3).length;
  // element type from the page HTML
  ($("#channels-title") as HTMLHeadingElement).textContent =
    on +
    (on === 1 ? " channel is on" : " channels are on") +
    ", " +
    done +
    " with setup done right now" +
    (S.progressLoading ? " (checked " + S.progressSeen + " of " + S.progressTotal + " so far)" : "");
  // element type from the page HTML
  ($("#channels-text") as HTMLParagraphElement).textContent =
    (waiting.length
      ? waiting.length +
        (waiting.length === 1 ? " sign-up is" : " sign-ups are") +
        " waiting for your approval at the top of the table. "
      : "") +
    "Setup counts as done while the overlay is open in OBS and the duel commands work, so streamers who are live right now show up as done.";
  // the error log and restore can read any channel that is set up
  for (const id of ["#log-channel", "#restore-channel"]) {
    // both ids are selects on the page
    const pick = $(id) as HTMLSelectElement,
      current = pick.value;
    pick.replaceChildren(
      ...[...d.builtin, ...d.channels.map((c) => c.login)].map((login) => h("option", { value: login }, login)),
    );
    if (current) pick.value = current;
  }
  if (!S.restoreLoaded) {
    S.restoreLoaded = true;
    loadRestore();
  }
}
// The sign-up page link to send a streamer: this site's /start/
// element type from the page HTML
($("#signup-link") as HTMLAnchorElement).href = ($("#signup-link") as HTMLAnchorElement).textContent =
  location.origin + "/start/";
// element type from the page HTML
($("#copy-signup") as HTMLButtonElement).addEventListener("click", async () => {
  try {
    // element type from the page HTML
    await navigator.clipboard.writeText(($("#signup-link") as HTMLAnchorElement).href);
    status("#channel-status", "Copied.", "ok");
  } catch {
    status("#channel-status", "Select the link and copy it with Ctrl+C.");
  }
});

// ---------- restore ----------
// Point-in-time restore (/api/dev/restore): Cloudflare keeps 30 days of each channel room's storage.
const MINUTE = 60000,
  RESTORE_DAYS = 30;
const localInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * MINUTE);
  return d.toISOString().slice(0, 16);
};
function restoreBounds() {
  // element type from the page HTML
  const input = $("#restore-at") as HTMLInputElement,
    now = Date.now();
  input.min = localInput(now - RESTORE_DAYS * 86400000 + 2 * MINUTE);
  input.max = localInput(now - MINUTE);
  if (!input.value) input.value = localInput(now - 60 * MINUTE);
}
async function loadRestore() {
  restoreBounds();
  // element type from the page HTML
  const login = ($("#restore-channel") as HTMLSelectElement).value;
  if (!login) return;
  const r = await api("/api/dev/restore?channel=" + encodeURIComponent(login));
  const last = r.ok ? r.data.last : null;
  // element type from the page HTML
  ($("#restore-last") as HTMLParagraphElement).textContent = !r.ok
    ? errorText(r, "Could not read the last restore")
    : last
      ? login + " was restored to " + fmtTime(last.at) + " by " + last.by + ", " + ago(last.restoredAt) + "."
      : "No restore to undo on " + login + ".";
  // element type from the page HTML
  ($("#undo-restore") as HTMLButtonElement).hidden = !last;
}
async function runRestore(button: HTMLButtonElement, undo: boolean) {
  // element type from the page HTML
  const login = ($("#restore-channel") as HTMLSelectElement).value,
    // element type from the page HTML
    at = new Date(($("#restore-at") as HTMLInputElement).value).getTime();
  if (!login) return;
  if (!undo && !Number.isFinite(at)) return status("#restore-status", "Pick a date and time first.", "error");
  const ask = undo
    ? "Undo the last restore of " + login + "? It goes back to how it was just before that restore."
    : "Restore " +
      login +
      " to " +
      fmtTime(at) +
      "? Everything it saved after that time is dropped: duels, ranks, dollars, fighter changes and settings.";
  if (!confirm(ask)) return;
  await busy(button, async () => {
    status("#restore-status", undo ? "Undoing the restore…" : "Restoring " + login + "…");
    const r = await api("/api/dev/restore", {
      method: "POST",
      body: undo ? { channel: login, undo: true } : { channel: login, at },
    });
    if (!r.ok) return status("#restore-status", errorText(r, "Could not restore " + login), "error");
    status(
      "#restore-status",
      (undo ? login + " is back to how it was before the restore: " : login + " is restored: ") +
        fmtNum(r.data.profiles) +
        " saved fighters, " +
        fmtNum(r.data.players) +
        " on stage." +
        (r.data.undoSaved ? "" : " The undo point could not be saved, so this one cannot be undone from here."),
      r.data.undoSaved ? "ok" : "warning",
    );
    loadRestore();
  });
}
// element type from the page HTML
($("#restore-channel") as HTMLSelectElement).addEventListener("change", loadRestore);
// element type from the page HTML
($("#restore") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on this button
  runRestore(e.currentTarget as HTMLButtonElement, false),
);
// element type from the page HTML
($("#undo-restore") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on this button
  runRestore(e.currentTarget as HTMLButtonElement, true),
);

// ---------- logs ----------
async function loadLogs() {
  // element type from the page HTML
  const source = ($("#log-source") as HTMLSelectElement).value,
    r = await api(
      // element type from the page HTML
      "/api/dev/logs?channel=" + ($("#log-channel") as HTMLSelectElement).value + (source ? "&source=" + source : ""),
    );
  if (!r.ok) return rows("#logs", [], errorText(r, "Logs unavailable"), 4);
  rows(
    "#logs",
    // /api/dev/logs body: the matching log rows
    (r.data as LogRow[]).map((x) =>
      h(
        "tr",
        {},
        h("td", {}, fmtTime(x.at)),
        h(
          "td",
          {},
          // indexed by any stored source; one this page doesn't name falls back to the raw text
          ({ room: "Durable Object", worker: "Worker", command: "Chat command", warn: "Warning" } as SourceLabels)[
            x.source
          ] || x.source,
        ),
        h("td", { class: "wrap" }, x.message),
        h("td", { class: "wrap ctx" }, h("code", {}, x.context ? JSON.stringify(x.context) : "–")),
      ),
    ),
    "Nothing logged.",
    4,
  );
}
// element type from the page HTML
($("#log-source") as HTMLSelectElement).addEventListener("change", loadLogs);
// element type from the page HTML
($("#log-channel") as HTMLSelectElement).addEventListener("change", loadLogs);
// element type from the page HTML
($("#clear-logs") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    // element type from the page HTML
    if (!confirm("Clear every stored log row for " + ($("#log-channel") as HTMLSelectElement).value + "?")) return;
    // element type from the page HTML
    const r = await api("/api/dev/logs?channel=" + ($("#log-channel") as HTMLSelectElement).value, {
      method: "DELETE",
    });
    if (r.ok) {
      loadLogs();
      loadDiagnostics();
    }
  }),
);
// element type from the page HTML
($('a[href="#dev-tools"]') as HTMLAnchorElement).addEventListener("click", () => {
  // element type from the page HTML
  ($("#dev-tools") as HTMLDetailsElement).open = true;
});
// element type from the page HTML
($("#refresh") as HTMLButtonElement).addEventListener("click", (e) =>
  // the listener sits on a button
  busy(e.currentTarget as HTMLButtonElement, async () => {
    await Promise.all([loadDiagnostics(), loadLogs(), loadChannels()]);
    loadRuns();
    loadVersions();
  }),
);

start();
