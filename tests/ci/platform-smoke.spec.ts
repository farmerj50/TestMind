import { expect, test } from "@playwright/test";

test("web shell and API health endpoint are reachable", async ({ page, request }) => {
  const web = await request.get("/");
  expect(web.status()).toBe(200);
  expect(await web.text()).toContain('id="root"');

  const apiBase = process.env.VITE_API_URL ?? "http://localhost:8787";
  const api = await request.get(`${apiBase.replace(/\/$/, "")}/health`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual({ ok: true });

  await page.setContent("<main>Playwright browser ready</main>");
  await expect(page.getByRole("main")).toHaveText("Playwright browser ready");
});
