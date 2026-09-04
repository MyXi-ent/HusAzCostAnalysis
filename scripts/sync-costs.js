#!/usr/bin/env node
/**
 * Runs the syncCosts handler directly in a GitHub Actions runner.
 *
 * The Static Web Apps managed-function host caps execution at 45s, but the Cost
 * Management API answers throttling with `Retry-After: 60`. Any 429 was therefore
 * an unrecoverable failure over HTTP. Running in the runner removes that ceiling.
 *
 * Usage:
 *   node scripts/sync-costs.js --days 5
 *   node scripts/sync-costs.js --start 2026-08-21 --end 2026-08-23
 *   node scripts/sync-costs.js --days 5 --subscription Xi_Sponsored_2
 */
const path = require("path");

const handler = require(path.join(__dirname, "..", "api", "syncCosts", "index.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Narrowing to a single subscription spreads Cost Management calls across
// separate invocations, which keeps each one under the throttling threshold.
if (args.subscription) {
  const all = JSON.parse(process.env.ARM_SUBSCRIPTIONS || "[]");
  const match = all.filter((s) => s.name === args.subscription);
  if (match.length === 0) {
    console.error(`Unknown subscription "${args.subscription}". Known: ${all.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  process.env.ARM_SUBSCRIPTIONS = JSON.stringify(match);
}

const body = args.start && args.end
  ? { startDate: args.start, endDate: args.end }
  : { days: parseInt(args.days, 10) || 5 };

const context = {
  log: Object.assign((...a) => console.log(...a), { error: (...a) => console.error(...a) }),
};

(async () => {
  const started = Date.now();
  await handler(context, { body });
  const result = context.res.body;

  console.log(`\n${result.startDate} → ${result.endDate}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const sub of result.subscriptions) {
    console.log(
      sub.error
        ? `  ${sub.subscription}: ERROR ${sub.error}`
        : `  ${sub.subscription}: ${sub.succeeded}/${sub.fetched} written${sub.failed ? `, ${sub.failed} failed` : ""}`
    );
  }

  const failures = result.subscriptions.filter((s) => s.error || s.failed > 0);
  if (failures.length > 0) process.exit(1);
})().catch((err) => {
  console.error("sync failed:", err.message);
  process.exit(1);
});
