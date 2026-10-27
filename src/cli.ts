#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { auditSite, type BudgetConfig, type Report } from "./audit.js";

const HELP = `Usage: astro-budget [dist] [options]

Reads a built Astro site and reports the JavaScript each route loads.

Arguments:
  dist                Built site directory. Default: dist

Options:
  --config <path>     Budget config. Default: astro-budget.config.json
  --baseline <path>   Compare against a saved JSON report
  --save <path>       Write the report as JSON
  --json              Print the report as JSON
  -h, --help          Show this help
  -v, --version       Show the version

Config:
  {
    "defaultBudgetKb": 50,
    "budgets": { "/": 40, "/journal": 60 }
  }

Exit codes:
  0  every route is inside budget
  1  at least one route is over budget
  2  the audit could not run
`;

type Options = {
  dist: string;
  config: string | null;
  baseline: string | null;
  save: string | null;
  json: boolean;
  help: boolean;
  version: boolean;
};

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(packageVersion());
    return;
  }

  const config = readConfig(options.config);
  const report = auditSite(options.dist, config);
  const baseline = options.baseline ? readBaseline(options.baseline) : null;

  if (options.save) {
    writeFileSync(options.save, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report, baseline);
  }

  if (report.routes.some((route) => route.overBudgetKb > 0)) {
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    dist: "dist",
    config: null,
    baseline: null,
    save: null,
    json: false,
    help: false,
    version: false,
  };
  let hasDist = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--config":
      case "--baseline":
      case "--save": {
        const value = args[++i];
        if (!value) throw new Error(`${arg} needs a path`);
        if (arg === "--config") options.config = value;
        else if (arg === "--baseline") options.baseline = value;
        else options.save = value;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        if (hasDist) throw new Error(`Unexpected argument: ${arg}`);
        options.dist = arg;
        hasDist = true;
    }
  }

  return options;
}

function readConfig(path: string | null): BudgetConfig {
  const file = path ?? "astro-budget.config.json";
  if (!existsSync(file)) {
    if (path !== null) throw new Error(`Config not found: ${path}`);
    return {};
  }

  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config must be a JSON object: ${file}`);
  }
  return raw as BudgetConfig;
}

function readBaseline(path: string): Map<string, number> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { routes?: unknown }).routes)) {
    throw new Error(`Not an astro-budget report: ${path}`);
  }

  const baseline = new Map<string, number>();
  for (const route of (raw as { routes: unknown[] }).routes) {
    if (route === null || typeof route !== "object") continue;
    const item = route as { route?: unknown; gzipBytes?: unknown };
    if (typeof item.route === "string" && typeof item.gzipBytes === "number") {
      baseline.set(item.route, item.gzipBytes);
    }
  }

  if (baseline.size === 0) throw new Error(`Report has no routes: ${path}`);
  return baseline;
}

function printTable(report: Report, baseline: Map<string, number> | null): void {
  const rows: Record<string, string>[] = report.routes.map((route) => {
    const previous = baseline?.get(route.route);
    const row: Record<string, string> = {
      route: route.route,
      gzip: formatKb(route.gzipBytes),
      raw: formatKb(route.bytes),
      islands: String(route.islands.length),
      budget: route.budgetKb === null ? "-" : `${route.budgetKb} kB`,
      status: route.overBudgetKb > 0 ? `over ${formatKb(route.overBudgetKb * 1000)}` : "ok",
    };
    if (baseline) {
      row.delta = previous === undefined ? "new" : formatDelta(route.gzipBytes - previous);
    }
    return row;
  });

  const columns = baseline
    ? ["route", "gzip", "delta", "raw", "islands", "budget", "status"]
    : ["route", "gzip", "raw", "islands", "budget", "status"];

  const widths = new Map(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => (row[column] ?? "").length)),
    ]),
  );

  const line = (row: Record<string, string>): string =>
    columns.map((column) => (row[column] ?? "").padEnd(widths.get(column) ?? 0)).join("  ").trimEnd();

  console.log(line(Object.fromEntries(columns.map((column) => [column, column]))));
  for (const row of rows) console.log(line(row));
  console.log("");

  const over = report.routes.filter((route) => route.overBudgetKb > 0).length;
  console.log(`${report.routes.length} route${report.routes.length === 1 ? "" : "s"}, ${over} over budget.`);
  if (report.missing.length > 0) {
    console.log(`Missing assets: ${report.missing.length}. Run with --json for the list.`);
  }
}

function formatKb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function formatDelta(bytes: number): string {
  if (Math.abs(bytes) < 50) return "0";
  return `${bytes > 0 ? "+" : "-"}${formatKb(Math.abs(bytes))}`;
}

function packageVersion(): string {
  const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof raw.version === "string" ? raw.version : "0.0.0";
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`astro-budget: ${message}`);
  process.exitCode = 2;
}
