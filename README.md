# astro-budget

Per-route JavaScript budgets for Astro sites.

`astro-budget` reads a built Astro site and reports the JavaScript each route
downloads. It counts `<script src>`, `<link rel="modulepreload">` and inline
script code, attributes chunks to `astro-island` elements, and compares each
route against a gzip budget. A route over budget exits with code 1.

## Why

Astro ships no client JavaScript by default and hydrates only the islands marked
with `client:*`. That makes it easy to assume a site is light, and hard to see
the cost of one `client:load` added months ago.

Astro's bundle recipe points at `rollup-plugin-visualizer`, and the docs warn
that the build output does not show what a single page sends to the browser.
This tool measures the built pages instead, in the same units a budget uses.

## Usage

Build the site first, then point the CLI at the output.

```sh
npm run build
npx astro-budget dist
```

Until the package is published, run it from a clone:

```sh
npm install
npm run build
node dist/cli.js path/to/dist
```

Example output from the fixture in `fixtures/site`:

```
route     gzip    raw      islands  budget  status
/         1.9 kB  14.3 kB  1        2 kB    ok
/journal  1.7 kB  12.6 kB  1        1.5 kB  over 0.2 kB

2 routes, 1 over budget.
```

## Config

Create `astro-budget.config.json` in the directory where you run the CLI.

```json
{
  "defaultBudgetKb": 50,
  "budgets": {
    "/": 40,
    "/journal": 60
  }
}
```

Both values are gzip kilobytes. `budgets` overrides the default per route. A
missing config means no budgets: the report still prints and always exits 0.

## Options

```
astro-budget [dist] [options]

  --config <path>     Budget config. Default: astro-budget.config.json
  --baseline <path>   Compare against a saved JSON report
  --save <path>       Write the report as JSON
  --json              Print the report as JSON
  -h, --help
  -v, --version
```

Save a baseline on the main branch, then compare a pull request against it:

```sh
astro-budget dist --save baseline.json
astro-budget dist --baseline baseline.json
```

The table gains a `delta` column. A route that did not exist in the baseline
shows `new`.

Exit codes: `0` every route is inside budget, `1` at least one route is over,
`2` the audit could not run.

## What counts

- `<script src="...">` and `<link rel="modulepreload" href="...">` on each page.
- Inline JavaScript, gzipped on its own for the budget.
- CSS, images and fonts are ignored.
- Assets outside `dist` are ignored. Missing local assets are listed in the
  JSON report and do not count toward the total.
- `astro-island` component and renderer URLs are added to the page total when
  Astro did not already preload them.

## Limitations

- Island weights are attribution, not additive totals. A renderer shared by
  three islands is counted once in the page total and three times in the island
  list.
- Static imports are not followed beyond what Astro emits in the HTML. Astro
  writes modulepreload links for its imports, so a normal static build is
  covered.
- The inline gzip figure is not the same as gzipping the whole HTML document.
- Server output has no routes to read. This tool expects static HTML in `dist`.
- A site with no JavaScript reports `0.0 kB` on every route. That is a valid
  result, not an error.

## Development

```sh
npm install
npm test
```

Tests build their own fixtures in a temporary directory. The example under
`fixtures/site` is checked in for manual runs and for the output above.

```sh
npm run check
```

`npm run check` runs the CLI against the fixture and exits 1 because `/journal`
is over its budget on purpose.

## Status

v0.1.0, not published to npm yet. The next piece is a GitHub Action that posts
the budget delta on a pull request. After that, source-level checks for
`client:*` directives and budgets for images and fonts.

## Dogfood

The first real target is Far From Home
(https://dsaikou618.github.io/far-from-home/). Its current build ships no
JavaScript, so the first island added there is also the first real number.
Record the route before and after changing a `client:load` island to
`client:visible`.
