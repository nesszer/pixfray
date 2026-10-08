// `cf dev` (Vite) does not apply public/_headers, so the overlay would load with no Content-Security-Policy in
// the browser tests. This adds the policy the deployed site sends (server/security.js), so a violation fails the test.
import { OVERLAY_CSP } from "../server/security.js";
export async function enforceCsp(target) {
  await target.route(
    (url) => url.pathname.endsWith("/overlay.html"),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch(),
        headers = response.headers();
      if (!headers["content-security-policy"]) headers["content-security-policy"] = OVERLAY_CSP;
      await route.fulfill({ response, headers });
    },
  );
}
