import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

export type BudgetConfig = {
  defaultBudgetKb?: number;
  budgets?: Record<string, number>;
};

export type Asset = {
  url: string;
  bytes: number;
  gzipBytes: number;
  shared: boolean;
};

export type Island = {
  component: string | null;
  renderer: string | null;
  client: string | null;
  bytes: number;
  gzipBytes: number;
};

export type RouteReport = {
  route: string;
  file: string;
  bytes: number;
  gzipBytes: number;
  inlineBytes: number;
  inlineGzipBytes: number;
  assets: Asset[];
  islands: Island[];
  budgetKb: number | null;
  overBudgetKb: number;
};

export type Report = {
  version: 1;
  dist: string;
  routes: RouteReport[];
  missing: string[];
};

type Page = {
  route: string;
  file: string;
  html: string;
};

type Size = {
  bytes: number;
  gzipBytes: number;
};

type Resolved = Size & {
  url: string;
  path: string | null;
};

type ParsedPage = Page & {
  assets: Map<string, Resolved>;
  islands: Island[];
  inlineBytes: number;
  inlineGzipBytes: number;
};

const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

export function auditSite(distDir: string, config: BudgetConfig = {}): Report {
  const root = resolve(distDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${distDir}`);
  }

  const pages = findPages(root);
  if (pages.length === 0) {
    throw new Error(`No HTML files found in ${distDir}`);
  }

  validateConfig(config);

  const missing = new Set<string>();
  const cache = new Map<string, Size>();
  const parsed = pages.map((page) => parsePage(page, root, missing, cache));

  const counts = new Map<string, number>();
  for (const page of parsed) {
    for (const key of page.assets.keys()) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const budgets = new Map<string, number>();
  for (const [route, kb] of Object.entries(config.budgets ?? {})) {
    budgets.set(normalizeRoute(route), kb);
  }

  const routes: RouteReport[] = parsed
    .map((page) => {
      const assets: Asset[] = [...page.assets.entries()]
        .map(([key, asset]) => ({
          url: asset.url,
          bytes: asset.bytes,
          gzipBytes: asset.gzipBytes,
          shared: parsed.length > 1 && counts.get(key) === parsed.length,
        }))
        .sort((a, b) => b.gzipBytes - a.gzipBytes || a.url.localeCompare(b.url));

      const assetBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
      const assetGzip = assets.reduce((sum, asset) => sum + asset.gzipBytes, 0);
      const budgetKb = budgets.get(page.route) ?? config.defaultBudgetKb ?? null;
      const gzipBytes = assetGzip + page.inlineGzipBytes;

      return {
        route: page.route,
        file: page.file,
        bytes: assetBytes + page.inlineBytes,
        gzipBytes,
        inlineBytes: page.inlineBytes,
        inlineGzipBytes: page.inlineGzipBytes,
        assets,
        islands: [...page.islands].sort(
          (a, b) => b.gzipBytes - a.gzipBytes || (a.component ?? "").localeCompare(b.component ?? ""),
        ),
        budgetKb,
        overBudgetKb: budgetKb === null ? 0 : Math.max(0, gzipBytes / 1000 - budgetKb),
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));

  return { version: 1, dist: distDir, routes, missing: [...missing].sort() };
}

function findPages(root: string): Page[] {
  const pages: Page[] = [];
  walk(root);
  return pages.sort((a, b) => a.route.localeCompare(b.route));

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
      const file = relative(root, path).split(sep).join("/");
      pages.push({ route: routeFor(file), file, html: readFileSync(path, "utf8") });
    }
  }
}

function parsePage(page: Page, root: string, missing: Set<string>, cache: Map<string, Size>): ParsedPage {
  const assets = new Map<string, Resolved>();
  const islands: Island[] = [];
  let inlineBytes = 0;
  let inlineGzipBytes = 0;

  const add = (url: string): Resolved | null => {
    const asset = resolveAsset(url, page.file, root, cache);
    if (!asset) return null;
    if (asset.path === null) {
      missing.add(asset.url);
      return asset;
    }
    const existing = assets.get(asset.path);
    if (existing) return existing;
    assets.set(asset.path, asset);
    return asset;
  };

  for (const match of page.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = parseAttrs(match[1]);
    if (attrs.src) {
      add(attrs.src);
      continue;
    }
    const type = (attrs.type ?? "").toLowerCase();
    if (!JS_TYPES.has(type)) continue;
    const content = Buffer.from(match[2], "utf8");
    inlineBytes += content.length;
    inlineGzipBytes += gzipSync(content).length;
  }

  for (const match of page.html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload") && attrs.href) {
      add(attrs.href);
    }
  }

  for (const match of page.html.matchAll(/<astro-island\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1]);
    const component = attrs["component-url"] ?? null;
    const renderer = attrs["renderer-url"] ?? null;
    let bytes = 0;
    let gzipBytes = 0;
    const seen = new Set<string>();

    for (const url of [component, renderer]) {
      if (!url) continue;
      const asset = add(url);
      if (!asset || asset.path === null || seen.has(asset.path)) continue;
      seen.add(asset.path);
      bytes += asset.bytes;
      gzipBytes += asset.gzipBytes;
    }

    islands.push({
      component,
      renderer,
      client: attrs.client ?? null,
      bytes,
      gzipBytes,
    });
  }

  return { ...page, assets, islands, inlineBytes, inlineGzipBytes };
}

function resolveAsset(raw: string, pageFile: string, root: string, cache: Map<string, Size>): Resolved | null {
  if (!raw || EXTERNAL_URL.test(raw)) return null;

  const url = raw.split("#")[0].split("?")[0];
  if (!url) return null;

  const path = url.startsWith("/")
    ? join(root, url.slice(1))
    : resolve(dirname(join(root, pageFile)), url);

  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;

  if (!existsSync(path) || !statSync(path).isFile()) {
    return { url, path: null, bytes: 0, gzipBytes: 0 };
  }

  let size = cache.get(path);
  if (!size) {
    const content = readFileSync(path);
    size = { bytes: content.length, gzipBytes: gzipSync(content).length };
    cache.set(path, size);
  }

  return { url, path, ...size };
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function routeFor(file: string): string {
  let path = file.replace(/index\.html$/, "");
  path = path.replace(/\.html$/, "");
  path = path.replace(/\/+$/, "");
  return path === "" ? "/" : `/${path}`;
}

function normalizeRoute(route: string): string {
  let value = route.trim();
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+$/, "");
  return value === "" ? "/" : value;
}

function validateConfig(config: BudgetConfig): void {
  const budgets: unknown = config.budgets;
  if (budgets !== undefined) {
    if (budgets === null || typeof budgets !== "object" || Array.isArray(budgets)) {
      throw new Error("budgets must be an object of route to kB values");
    }
    for (const [route, kb] of Object.entries(budgets as Record<string, unknown>)) {
      checkBudget(kb, `budget for ${route}`);
    }
  }
  if (config.defaultBudgetKb !== undefined) {
    checkBudget(config.defaultBudgetKb, "defaultBudgetKb");
  }
}

function checkBudget(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}
