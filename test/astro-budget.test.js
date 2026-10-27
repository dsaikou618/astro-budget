import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { auditSite } from "../dist/audit.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function makeSite(files) {
  const root = mkdtempSync(join(tmpdir(), "astro-budget-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function size(text) {
  const content = Buffer.from(text);
  return { bytes: content.length, gzipBytes: gzipSync(content).length };
}

test("maps routes, dedupes assets and counts inline code", (t) => {
  const app = "export const app = 1;\n".repeat(20);
  const shared = "export const shared = 2;\n".repeat(10);
  const everywhere = "export const everywhere = 4;\n";
  const inline = 'console.log("home")';

  const root = makeSite({
    "index.html": `<html><head><link rel="modulepreload" href="/_astro/shared.js"><link rel="modulepreload" href="/_astro/everywhere.js"></head><body><script type="module" src="/_astro/app.js"></script><script type="module" src="/_astro/app.js"></script><script>${inline}</script></body></html>`,
    "journal/index.html": `<html><head><link rel="modulepreload" href="/_astro/shared.js"><link rel="modulepreload" href="/_astro/everywhere.js"></head><body><script type="module" src="/_astro/journal.js"></script></body></html>`,
    "about.html": `<html><head><link rel="modulepreload" href="/_astro/everywhere.js"></head><body><script src="/_astro/app.js"></script></body></html>`,
    "_astro/app.js": app,
    "_astro/shared.js": shared,
    "_astro/everywhere.js": everywhere,
    "_astro/journal.js": "export const journal = 3;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = auditSite(root);
  assert.deepEqual(report.routes.map((route) => route.route), ["/", "/about", "/journal"]);

  const home = report.routes[0];
  assert.equal(home.assets.length, 3);
  assert.equal(home.inlineBytes, Buffer.byteLength(inline));
  assert.equal(
    home.gzipBytes,
    size(app).gzipBytes + size(shared).gzipBytes + size(everywhere).gzipBytes + size(inline).gzipBytes,
  );

  const appAsset = home.assets.find((asset) => asset.url === "/_astro/app.js");
  const sharedAsset = home.assets.find((asset) => asset.url === "/_astro/everywhere.js");
  assert.equal(appAsset?.shared, false);
  assert.equal(sharedAsset?.shared, true);
});

test("ignores external and non-JS scripts", (t) => {
  const inline = 'console.log("inline")';
  const root = makeSite({
    "index.html": `<script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script><script type="application/json">{"a":1}</script><script>${inline}</script>`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = auditSite(root);
  const page = report.routes[0];
  assert.equal(page.assets.length, 0);
  assert.equal(page.inlineBytes, Buffer.byteLength(inline));
  assert.equal(page.gzipBytes, size(inline).gzipBytes);
});

test("attributes islands to their component and renderer", (t) => {
  const counter = "export const counter = 1;\n".repeat(40);
  const client = "export const client = 2;\n".repeat(10);
  const root = makeSite({
    "index.html": `<script type="module" src="/_astro/home.js"></script><astro-island uid="1" component-url="/_astro/Counter.js" renderer-url="/_astro/client.js" props="{}" client="load"></astro-island>`,
    "_astro/home.js": "export const home = 3;\n",
    "_astro/Counter.js": counter,
    "_astro/client.js": client,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const page = auditSite(root).routes[0];
  assert.equal(page.islands.length, 1);
  assert.deepEqual(page.islands[0], {
    component: "/_astro/Counter.js",
    renderer: "/_astro/client.js",
    client: "load",
    bytes: size(counter).bytes + size(client).bytes,
    gzipBytes: size(counter).gzipBytes + size(client).gzipBytes,
  });
  assert.equal(page.assets.length, 3);
});

test("flags routes over budget", (t) => {
  const big = randomBytes(20000).toString("hex");
  const root = makeSite({
    "index.html": `<script src="/big.js"></script>`,
    "big.js": big,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const strict = auditSite(root, { defaultBudgetKb: 1 });
  assert.equal(strict.routes[0].budgetKb, 1);
  assert.ok(strict.routes[0].overBudgetKb > 0);

  const loose = auditSite(root, { budgets: { "/": 1000 } });
  assert.equal(loose.routes[0].overBudgetKb, 0);
});

test("records missing assets without counting them", (t) => {
  const root = makeSite({
    "index.html": `<script src="/_astro/gone.js"></script><script src="/_astro/here.js"></script>`,
    "_astro/here.js": "export const here = 1;\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = auditSite(root);
  assert.deepEqual(report.missing, ["/_astro/gone.js"]);
  assert.deepEqual(report.routes[0].assets.map((asset) => asset.url), ["/_astro/here.js"]);
});

test("cli saves a report, compares a baseline and fails a budget", (t) => {
  const root = makeSite({
    "index.html": `<script type="module" src="/app.js"></script>`,
    "app.js": randomBytes(1000).toString("hex"),
    "budget.json": JSON.stringify({ defaultBudgetKb: 0.001 }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = spawnSync(process.execPath, [cli, root, "--json", "--save", join(root, "baseline.json")], {
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.routes.length, 1);

  writeFileSync(join(root, "app.js"), randomBytes(5000).toString("hex"));

  const second = spawnSync(process.execPath, [cli, root, "--baseline", join(root, "baseline.json")], {
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /\+[0-9]+\.[0-9] kB/);

  const third = spawnSync(process.execPath, [cli, root, "--config", join(root, "budget.json"), "--json"], {
    encoding: "utf8",
  });
  assert.equal(third.status, 1, third.stderr);
  assert.ok(JSON.parse(third.stdout).routes[0].overBudgetKb > 0);
});
