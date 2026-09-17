import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const samplePath = path.join(process.cwd(), "public/tradepersona-sample.csv");
const sample = readFileSync(samplePath, "utf8");

test("real CSV passes through Python and renders evidence, explanations and counterfactuals", async ({
  page,
}) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      warnings.push(message.text());
  });
  await page.goto("/");
  await page.locator("#csv-upload").setInputFiles(samplePath);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/uploads/usertrades") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Analyze my trades" }).click();
  const upload = await response;
  expect(upload.status()).toBe(201);
  const body = await upload.json();
  expect(body.analysis.quality.usable_rows).toBe(
    sample.trim().split("\n").length - 1,
  );
  expect(body.analysis.prediction.status).toBe("classified");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "Post-loss escalation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The evidence behind the pattern" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Keep post-loss size near baseline" }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic benchmark", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Post-loss escalation", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    warnings.filter(
      (message) =>
        message.includes("width(-1)") || message.includes("height(-1)"),
    ),
  ).toEqual([]);
});

test("short history withholds a class while still displaying measured evidence", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#csv-upload").setInputFiles({
    name: "short.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(sample.split("\n").slice(0, 9).join("\n")),
  });
  await page.getByRole("button", { name: "Analyze my trades" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("heading", {
      name: "Insufficient evidence for a confident classification.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("At least 30 completed trades are needed."),
  ).toBeVisible();
  await expect(
    page.getByText("Probabilities are unavailable for this input."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The evidence behind the pattern" }),
  ).toBeVisible();
});

test("malformed CSV gives actionable validation without a successful session", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#csv-upload").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("timestamp,quantity\nnot-a-date,abc\n"),
  });
  await page.getByRole("button", { name: "Analyze my trades" }).click();
  await expect(page.locator("main [role=alert]")).toContainText(
    "Missing required columns",
  );
  await expect(page).toHaveURL("http://localhost:3000/");
});

test("evaluation displays values from the served artifact", async ({
  page,
  request,
}) => {
  const response = await request.get("http://localhost:3001/api/evaluation");
  const artifact = await response.json();
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      warnings.push(message.text());
  });
  await page.goto("/evaluation");
  await expect(
    page.getByRole("heading", { name: "Untouched synthetic holdout" }),
  ).toBeVisible();
  await expect(page.locator(".metric-card").first()).toContainText(
    artifact.test.macro_f1.toFixed(3),
  );
  await expect(
    page.getByRole("heading", { name: "Where the model gets confused" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Beyond a single clean benchmark" }),
  ).toBeVisible();
  await expect(page.locator(".fingerprint")).toHaveText(
    artifact.dataset.fingerprint,
  );
  expect(errors).toEqual([]);
  expect(
    warnings.filter(
      (message) =>
        message.includes("width(-1)") || message.includes("height(-1)"),
    ),
  ).toEqual([]);
});

test("empty and expired sessions are understandable, including mobile layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(page.locator("main [role=alert]")).toContainText(
    "Upload a completed trade history",
  );
  await page.evaluate(() =>
    sessionStorage.setItem(
      "tradepersona.session.v1",
      "550e8400-e29b-41d4-a716-446655440000",
    ),
  );
  await page.reload();
  await expect(page.locator("main [role=alert]")).toContainText("expired");
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Analyze my trades" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
