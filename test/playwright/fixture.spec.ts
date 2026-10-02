// Spawned by test/playwright.test.ts; WALKMATE_CWD points .walkmate/runs at a temporary project.
import { createServer, type Server } from "node:http";
import { test as base, expect } from "@playwright/test";
import { withWalkmate } from "../../src/playwright/index.ts";

const test = withWalkmate(base);

const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlLWZpeHR1cmU";
const html = `<!doctype html><title>Login fixture</title>
<form><label>Email<input data-testid="email"></label><label>Password<input data-testid="password" type="password"></label>
<button data-testid="login">Sign in</button></form><p data-testid="result">Signed out</p>
<script>
document.querySelector("form").onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: document.querySelector("[data-testid=email]").value, password: document.querySelector("[data-testid=password]").value }) });
  const { user } = await res.json();
  document.querySelector("[data-testid=result]").textContent = "Welcome " + user;
};
</script>`;
let server: Server, url: string;

test.beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.url === "/api/login") {
			req.resume();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ access_token: jwt, user: "kim" }));
		} else {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	url = `http://127.0.0.1:${address.port}/`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("logs in", async ({ page }) => {
	await test.step("1-open-login", () => page.goto(url));
	await test.step("2-fill-credentials", async () => {
		await page.getByTestId("email").fill("kim@example.invalid");
		await page.getByTestId("password").fill(process.env.WALKMATE_PW_SECRET!);
	});
	await test.step("3-submit", () => page.getByTestId("login").click());
	await expect(page.getByTestId("result")).toHaveText("Welcome kim");
});

test("records failures", async ({ page }) => {
	test.fail();
	await test.step("1-open-login", () => page.goto(url));
	await expect(page.getByTestId("result")).toHaveText("Impossible", { timeout: 500 });
});

test.describe("retain-on-failure", () => {
	test.use({ walkmate: { mode: "retain-on-failure" } });
	test("drops passing recordings", async ({ page }) => {
		await page.goto(url);
	});
});
