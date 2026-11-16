#!/usr/bin/env node
// Runs the pinned question set against a live AI service (card 7a5ea203). The logic and its tests are in
// apps/api/src/question-set-run.ts; this only calls it from the build.
//
// Usage (after `npm run build`):
//   AI_API_TOKEN=<token> node scripts/question-set-run.mjs --url <base url> --out <report.json> [--client-key <key>]
// The token goes in the environment, never on the command line. The default client key is `question-set-run`, so the
// run's conversations stay apart from every OS user's.
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../dist/question-set-run.js", import.meta.url));
const { main } = await import(built);
process.exitCode = await main(process.argv.slice(2), process.env);
