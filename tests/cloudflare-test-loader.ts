import type { ResolveFnOutput, ResolveHook, ResolveHookContext } from "node:module";

export async function resolve(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: Parameters<ResolveHook>[2],
): Promise<ResolveFnOutput> {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
