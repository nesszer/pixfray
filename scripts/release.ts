#!/usr/bin/env node
// Release steps for .github/workflows/deploy.yml, using Cloudflare Worker versions and deployments.
//   node scripts/release.ts deploy   --target test|production [--percentage 1-100] [--tag T] [--message M] [--dry-run]
//   node scripts/release.ts rollback --target test|production [--version <uuid>] [--message M] [--dry-run]
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. Never prints either.
// deploy = upload a new version (`cf workers versions create`, which builds the project), check that it
// still has the Worker secrets, then point traffic at it (100%, or a gradual split with the current version).
// rollback = point 100% of traffic at an older version (the previous deployment's main version by default).
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import site from "../site.config.js";
import type { Environment } from "../types/site.ts";

/** Checked release options, as parseArgs returns them. */
export type ReleaseOpts = {
  command: "deploy" | "rollback";
  target: Environment;
  percentage: number;
  tag: string;
  message: string;
  version?: string;
  dryRun?: boolean;
};
/** One traffic split of a deployment. */
export type Split = { version_id: string; percentage: number };
/** A Worker deployment, as the Cloudflare API lists it (only the fields read here). */
export type Deployment = { created_on?: string; versions?: Split[] };
/** A Worker version, as the Cloudflare API lists it (only the fields read here). */
export type Version = { id: string; metadata?: { created_on?: string }; annotations?: Record<string, string> };
/** One version's detail: its bindings, which include the secrets. */
export type VersionDetail = { resources?: { bindings?: { name: string; type?: string }[] } };
/** What api() passes to fetch. */
export type ApiInit = { method?: string; body?: string };
export type FetchLike = (url: string, init: ApiInit & { headers: Record<string, string> }) => Promise<Response>;
/** The Cloudflare credentials api() reads. */
export type ApiEnv = { CLOUDFLARE_ACCOUNT_ID?: string | undefined; CLOUDFLARE_API_TOKEN?: string | undefined };
/** The Cloudflare API envelope: `result` on success, `errors` on failure. */
type Envelope<T> = { success?: boolean; errors?: { message: string }[]; result: T };
/** Test seams for run(). */
export type ReleaseDeps = {
  fetch?: FetchLike;
  upload?: (opts: ReleaseOpts) => void;
  summary?: (lines: string[]) => void;
};

export const SCRIPTS = { production: site.workers.production, test: site.workers.test };
export const REQUIRED_SECRETS = ["AUTH_SECRET", "INTERNAL_SECRET"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseArgs(argv: string[]): ReleaseOpts {
  const [command, ...rest] = argv,
    raw: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i] ?? "";
    if (k === "--dry-run") dryRun = true;
    else if (/^--(target|percentage|tag|message|version)$/.test(k) && i + 1 < rest.length)
      raw[k.slice(2)] = rest[++i] ?? "";
    else throw new Error("Unknown argument: " + k);
  }
  const { target, version } = raw;
  if (command !== "deploy" && command !== "rollback") throw new Error("Command must be deploy or rollback");
  if (target !== "test" && target !== "production") throw new Error("--target must be test or production");
  const percentage = raw.percentage ? Number(raw.percentage) : 100;
  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100)
    throw new Error("--percentage must be an integer from 1 to 100");
  if (target === "test" && percentage !== 100) throw new Error("Gradual deployments are for production only");
  if (version && !UUID.test(version)) throw new Error("--version must be a Worker version UUID");
  return {
    command,
    target,
    percentage,
    tag: (raw.tag ?? "").slice(0, 25),
    message: (raw.message ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 100),
    ...(version !== undefined ? { version } : {}),
    ...(dryRun ? { dryRun } : {}),
  };
}

// The main version of a deployment is the one carrying the most traffic.
export const mainVersion = (deployment: Deployment | undefined): string | null =>
  [...(deployment?.versions || [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id || null;
const newestFirst = <T extends { created_on?: unknown }>(list: T[]): T[] =>
  [...list].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));

export function findVersionByTag(versions: Version[] | undefined, tag: string): string | null {
  return (
    newestFirst((versions || []).map((v) => ({ ...v, created_on: v.metadata?.created_on }))).find(
      (v) => v.annotations?.["workers/tag"] === tag,
    )?.id || null
  );
}

export function planDeploy(
  deployments: Deployment[] | undefined,
  newVersion: string,
  percentage: number,
): { previous: string | null; versions: Split[] } {
  const current = mainVersion(newestFirst(deployments || [])[0]);
  const whole = percentage === 100 || !current || current === newVersion;
  const versions = [{ version_id: newVersion, percentage: whole ? 100 : percentage }];
  if (!whole) versions.push({ version_id: current, percentage: 100 - percentage });
  return { previous: current, versions };
}

export function planRollback(
  deployments: Deployment[] | undefined,
  requested?: string,
): { previous: string | null; target: string | null } {
  const list = newestFirst(deployments || []),
    current = mainVersion(list[0]);
  const earlier = list.slice(1).map(mainVersion);
  return { previous: current, target: requested || earlier.find((id) => id && id !== current) || null };
}

export function missingSecrets(versionDetail: VersionDetail | null | undefined): string[] {
  const names = new Set((versionDetail?.resources?.bindings || []).map((b) => b.name));
  return REQUIRED_SECRETS.filter((n) => !names.has(n));
}

export function api(env: ApiEnv, fetchImpl: FetchLike = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID,
    token = env.CLOUDFLARE_API_TOKEN;
  if (!token || !/^[a-f0-9]{32}$/.test(account || ""))
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  return async <T = unknown>(path: string, init: ApiInit = {}): Promise<T> => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${path}`, {
      ...init,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    });
    const data = await r.json<Envelope<T>>().catch(() => null);
    if (!r.ok || data?.success === false)
      throw new Error(
        `Cloudflare API ${r.status} on ${path.split("?")[0]}: ${(data?.errors || []).map((e) => e.message).join("; ") || "request failed"}`,
      );
    // an ok answer that isn't JSON leaves data null, and this read throws, as it always has
    return data!.result;
  };
}

function uploadVersion(opts: ReleaseOpts) {
  const args = ["cf", "workers", "versions", "create", ...(opts.target === "test" ? ["--mode", "test"] : [])];
  args.push("--tag", opts.tag, "--message", opts.message || "deploy " + opts.tag);
  const r = spawnSync("bunx", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("cf workers versions create failed (exit " + r.status + ")");
}

function summary(lines: string[]) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

/** What run() resolves to: the deploy or rollback plan it carried out. */
export type RunResult = {
  previous: string | null;
  target?: string | null;
  versionId?: string;
  versions?: Split[];
};

export async function run(opts: ReleaseOpts, env: ApiEnv = process.env, deps: ReleaseDeps = {}): Promise<RunResult> {
  const call = api(env, deps.fetch),
    script = SCRIPTS[opts.target],
    log = deps.summary || summary;
  const deployments = async () =>
    (await call<{ deployments?: Deployment[] }>(script + "/deployments")).deployments || [];
  const deployTo = (versions: Split[], message?: string) =>
    call(script + "/deployments", {
      method: "POST",
      body: JSON.stringify({
        strategy: "percentage",
        versions,
        annotations: { "workers/message": message || opts.message || opts.command },
      }),
    });
  if (opts.command === "rollback") {
    const plan = planRollback(await deployments(), opts.version);
    if (!plan.target) throw new Error("No earlier version to roll back to; pass --version");
    if (!opts.dryRun) await deployTo([{ version_id: plan.target, percentage: 100 }], opts.message || "rollback");
    log([
      `### Rollback ${opts.target}${opts.dryRun ? " (dry run)" : ""}`,
      `- Worker: ${script}`,
      `- From: ${plan.previous || "none"}`,
      `- To: ${plan.target} (100%)`,
    ]);
    return plan;
  }
  if (!opts.tag) throw new Error("--tag is required for deploy");
  if (!opts.dryRun) (deps.upload || uploadVersion)(opts);
  const versions = (await call<{ items?: Version[] }>(script + "/versions")).items || [];
  const versionId = findVersionByTag(versions, opts.tag);
  if (!versionId && opts.dryRun) throw new Error("Dry run: no uploaded version is tagged " + opts.tag);
  if (!versionId) throw new Error("Uploaded version with tag " + opts.tag + " not found");
  const missing = missingSecrets(await call<VersionDetail>(script + "/versions/" + versionId)).join(", ");
  if (missing)
    throw new Error(
      `New version is missing secrets ${missing}; set them with cf deploy --secrets-file first. Traffic was not moved.`,
    );
  const plan = planDeploy(await deployments(), versionId, opts.percentage);
  if (!opts.dryRun) await deployTo(plan.versions);
  log([
    `### Deploy ${opts.target}${opts.dryRun ? " (dry run)" : ""}`,
    `- Worker: ${script}`,
    `- Tag: ${opts.tag}`,
    `- New version: ${versionId}`,
    `- Previous version: ${plan.previous || "none"}`,
    `- Traffic: ${plan.versions.map((v) => v.version_id + " " + v.percentage + "%").join(", ")}`,
    `- Roll back with: operation=rollback target=${opts.target}`,
  ]);
  return { versionId, ...plan };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    // parseArgs, run and the API helper throw Error objects only
    console.error("release: " + (error as Error).message);
    process.exit(1);
  }
}
