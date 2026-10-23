import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * THE IMAGE'S HEALTHCHECK, RUN RATHER THAN READ (card b8412c7b).
 *
 * A test that only looked for "HEALTHCHECK" and "/health" in the Dockerfile
 * would stay green with a command that can never succeed (a wrong port, a
 * typo in the script, a tool the slim image does not have). So this takes
 * the exact `node -e` script out of the Dockerfile and runs it, with PORT
 * pointing at a local server: it must pass on 200, and fail on a non-2xx
 * answer (a failing database check makes /health throw, which is a 500) and
 * when nothing listens.
 */

// `npm test` runs from the repository root, as `dependency-audit.spec.ts` assumes too
const DOCKERFILE = join(process.cwd(), "Dockerfile");

function healthcheckScript(): string {
  const text = readFileSync(DOCKERFILE, "utf8").replace(/\\\n/g, " ");
  const line = text.split("\n").find((l) => l.startsWith("HEALTHCHECK "));
  assert.ok(line, "the Dockerfile has a HEALTHCHECK instruction");
  const match = /CMD node -e "(.*)"\s*$/.exec(line);
  assert.ok(match, "the HEALTHCHECK is a `node -e` script (the slim image has no curl or wget)");
  return match[1]!;
}

function runCheck(port: number): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["-e", healthcheckScript()],
      { env: { ...process.env, PORT: String(port) }, timeout: 10_000 },
      (error) => resolve(error ? (typeof error.code === "number" ? error.code : 1) : 0)
    );
  });
}

async function serve(status: number): Promise<{ server: Server; port: number; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.statusCode = status;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, paths };
}

describe("the image's HEALTHCHECK", () => {
  it("passes when GET /health answers 200, and asks /health on PORT", async () => {
    const { server, port, paths } = await serve(200);
    try {
      assert.equal(await runCheck(port), 0);
      assert.deepEqual(paths, ["/health"]);
    } finally {
      server.close();
    }
  });

  it("fails when /health answers 500 (the database check threw)", async () => {
    const { server, port } = await serve(500);
    try {
      assert.equal(await runCheck(port), 1);
    } finally {
      server.close();
    }
  });

  it("fails when nothing listens on PORT", async () => {
    const { server, port } = await serve(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await runCheck(port), 1);
  });
});
