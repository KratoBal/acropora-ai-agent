import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acroporaOsConfig,
  customerChatFields,
  customerChatInstructions,
  customerContextErrorBody,
  resolveCustomerContext,
  type AcroporaCustomerContext,
  type CustomerContextFailure
} from "./customer-context.js";

const TOKEN = "raw-service-token-value-that-must-never-leak";

const environment: NodeJS.ProcessEnv = {
  ACROPORA_OS_BASE_URL: "https://os.example/",
  ACROPORA_OS_AI_SERVICE_TOKEN: TOKEN
};

const context: AcroporaCustomerContext = {
  subjectType: "customer",
  customerId: "cus_1",
  customerNumber: "V-00123",
  entitlements: {},
  entitlementsStatus: "not-modelled",
  entitlementsNote:
    "Az Acropora OS-ben ma nincs elofizetes-, csomag- vagy funkcio-jogosultsagi modell."
};

const resolvedCustomer = {
  ok: true as const,
  mode: "customer" as const,
  context
};

/**
 * Records what the code actually sent, then answers.
 *
 * The call is recorded rather than the arguments this test passed in: an
 * assertion on its own input measures the test, not the program.
 */
function recordingFetch(
  respond: (call: { url: string; init: RequestInit }) => Response | never
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);

    return respond(call);
  }) as typeof fetch;

  return { impl, calls };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const headerValue = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string>)[name];

describe("acroporaOsConfig", () => {
  it("reads both halves and trims the trailing slash", () => {
    assert.deepEqual(acroporaOsConfig(environment), {
      baseUrl: "https://os.example",
      token: TOKEN
    });
  });

  it("returns null when either half is missing", () => {
    assert.equal(acroporaOsConfig({}), null);
    assert.equal(
      acroporaOsConfig({ ACROPORA_OS_BASE_URL: "https://os.example" }),
      null
    );
    assert.equal(
      acroporaOsConfig({ ACROPORA_OS_AI_SERVICE_TOKEN: TOKEN }),
      null
    );
    assert.equal(
      acroporaOsConfig({
        ACROPORA_OS_BASE_URL: "   ",
        ACROPORA_OS_AI_SERVICE_TOKEN: TOKEN
      }),
      null
    );
  });
});

describe("resolveCustomerContext", () => {
  it("returns the customer context on a valid token, and sends what the OS expects", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(context));

    const result = await resolveCustomerContext("  cus_1  ", {
      environment,
      fetchImpl: impl
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.mode, "customer");
    assert.deepEqual(
      result.ok && result.mode === "customer" && result.context,
      context
    );

    // What went out, not what was passed in.
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://os.example/integrations/ai/user-context"
    );
    assert.equal(calls[0].init.method, "GET");
    assert.equal(
      headerValue(calls[0].init, "authorization"),
      `Bearer ${TOKEN}`
    );
    assert.equal(headerValue(calls[0].init, "x-acropora-user-id"), "cus_1");
  });

  it("maps an OS 401 to 502 customer_context_auth_error", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse({ statusCode: 401, message: "Érvénytelen token." }, 401)
    );

    const result = await resolveCustomerContext("cus_1", {
      environment,
      fetchImpl: impl
    });

    assert.equal(result.ok, false);
    assert.equal((result as CustomerContextFailure).status, 502);
    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_context_auth_error"
    );
  });

  it("maps an OS 403 the same way, although the OS cannot produce one today", async () => {
    // The OS guard answers 401 on every branch it has. The mapping exists
    // because it was asked for, and this test records that it is untriggered
    // by the real system rather than untested.
    const { impl } = recordingFetch(() => jsonResponse({}, 403));

    const result = await resolveCustomerContext("cus_1", {
      environment,
      fetchImpl: impl
    });

    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_context_auth_error"
    );
  });

  it("maps an OS 404 to 404 customer_not_found", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse({ statusCode: 404, message: "Ismeretlen vevő." }, 404)
    );

    const result = await resolveCustomerContext("cus_missing", {
      environment,
      fetchImpl: impl
    });

    assert.equal((result as CustomerContextFailure).status, 404);
    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_not_found"
    );
  });

  it("treats a request with no header as an anonymous chat, and never calls the OS", async () => {
    // An anonymous visitor may use the aquarium chat, and is never pushed into
    // identifying themselves for it. No call means no 502 and no 404 either.
    const { impl, calls } = recordingFetch(() => jsonResponse(context));

    const result = await resolveCustomerContext(undefined, {
      environment,
      fetchImpl: impl
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.mode, "anonymous");
    assert.equal(calls.length, 0);
  });

  it("refuses a header that was sent but carries nothing, without calling the OS", async () => {
    /**
     * The distinction from the test above is the point of both.
     *
     * An anonymous visitor sends no header at all. The only thing that
     * produces an empty one is a caller whose variable did not get filled in,
     * and answering that as "anonymous" would turn their bug into a silently
     * context-free answer. A duplicated header arrives as an array and is
     * refused the same way.
     */
    const { impl, calls } = recordingFetch(() => jsonResponse(context));

    for (const value of ["", "   ", 42, ["cus_1", "cus_2"]]) {
      const result = await resolveCustomerContext(value, {
        environment,
        fetchImpl: impl
      });

      assert.equal(
        result.ok,
        false,
        `${JSON.stringify(value)} must not pass as anonymous`
      );
      assert.equal((result as CustomerContextFailure).status, 400);
      assert.equal(
        (result as CustomerContextFailure).error,
        "customer_id_required"
      );
    }

    assert.equal(calls.length, 0);
  });

  it("answers unavailable when the base url or the token is not configured, and sends nothing", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(context));

    const result = await resolveCustomerContext("cus_1", {
      environment: {},
      fetchImpl: impl
    });

    assert.equal((result as CustomerContextFailure).status, 502);
    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_context_unavailable"
    );
    assert.equal(calls.length, 0);
  });

  it("maps every unplanned OS status to unavailable, including the OS's own 400", async () => {
    /**
     * The body is a VALID customer context on purpose, and that is the whole
     * point of this test.
     *
     * With an empty body the status branch cannot be measured: removing it
     * lets the answer fall through to the shape check, which returns the same
     * error code, and the test stays green while the code no longer looks at
     * the status at all. Falsification caught exactly that. With a valid body,
     * dropping the status branch turns a 500 into a successful chat.
     */
    for (const status of [400, 418, 500, 502, 503]) {
      const { impl } = recordingFetch(() => jsonResponse(context, status));

      const result = await resolveCustomerContext("cus_1", {
        environment,
        fetchImpl: impl
      });

      assert.equal(
        result.ok,
        false,
        `status ${status} must not be answered as a success`
      );
      assert.equal(
        (result as CustomerContextFailure).error,
        "customer_context_unavailable",
        `status ${status} should not fall through`
      );
      assert.equal((result as CustomerContextFailure).status, 502);
      assert.equal(
        (result as CustomerContextFailure).detail,
        `Acropora OS answered ${status}`
      );
    }
  });

  it("answers unavailable when the OS cannot be reached", async () => {
    const { impl } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });

    const result = await resolveCustomerContext("cus_1", {
      environment,
      fetchImpl: impl
    });

    assert.equal((result as CustomerContextFailure).status, 502);
    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_context_unavailable"
    );
  });

  it("answers unavailable on a 200 that is not a customer context", async () => {
    // A 200 without an identity would put undefined in front of the model and
    // in the answer. It is an upstream failure, not a success.
    for (const body of [{}, { subjectType: "user" }, { customerId: "" }, []]) {
      const { impl } = recordingFetch(() => jsonResponse(body));

      const result = await resolveCustomerContext("cus_1", {
        environment,
        fetchImpl: impl
      });

      assert.equal(
        (result as CustomerContextFailure).error,
        "customer_context_unavailable",
        `body ${JSON.stringify(body)} should not pass as a context`
      );
    }
  });

  it("answers unavailable on a 200 whose body is not JSON", async () => {
    const { impl } = recordingFetch(
      () => new Response("<html>maintenance</html>", { status: 200 })
    );

    const result = await resolveCustomerContext("cus_1", {
      environment,
      fetchImpl: impl
    });

    assert.equal(
      (result as CustomerContextFailure).error,
      "customer_context_unavailable"
    );
  });
});

describe("the raw service token", () => {
  it("never appears in anything this module returns, on any branch", async () => {
    const branches: Array<() => Promise<unknown>> = [
      () =>
        resolveCustomerContext("cus_1", {
          environment,
          fetchImpl: recordingFetch(() => jsonResponse(context)).impl
        }),
      () =>
        resolveCustomerContext("", { environment, fetchImpl: fetch }),
      () =>
        resolveCustomerContext("cus_1", {
          environment,
          fetchImpl: recordingFetch(() => jsonResponse({}, 401)).impl
        }),
      () =>
        resolveCustomerContext("cus_1", {
          environment,
          fetchImpl: recordingFetch(() => jsonResponse({}, 404)).impl
        }),
      () =>
        resolveCustomerContext("cus_1", {
          environment,
          fetchImpl: recordingFetch(() => jsonResponse({}, 500)).impl
        }),
      () =>
        resolveCustomerContext("cus_1", {
          environment,
          fetchImpl: recordingFetch(() => {
            // A transport error that carries the token, which is exactly what
            // an undici failure can do. It must still not come back out.
            throw new Error(`connect ECONNREFUSED (Bearer ${TOKEN})`);
          }).impl
        })
      ];

    for (const branch of branches) {
      const result = await branch();

      assert.equal(
        JSON.stringify(result).includes(TOKEN),
        false,
        `a branch returned the token: ${JSON.stringify(result)}`
      );
    }
  });

  it("is not in the block handed to the model either", () => {
    assert.equal(
      customerChatInstructions(resolvedCustomer).includes(TOKEN),
      false
    );
  });
});

describe("customerContextErrorBody", () => {
  it("sends the code to the caller and keeps the diagnostic for the log", () => {
    const failure: CustomerContextFailure = {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: "Acropora OS answered 503"
    };

    assert.deepEqual(customerContextErrorBody(failure), {
      error: "customer_context_unavailable"
    });
    assert.deepEqual(Object.keys(customerContextErrorBody(failure)), [
      "error"
    ]);
  });
});

describe("customerChatFields", () => {
  it("returns the four temporary fields and a resolved marker for a customer", () => {
    const fields = customerChatFields(resolvedCustomer);

    assert.deepEqual(fields, {
      customerContextStatus: "resolved",
      subjectType: "customer",
      customerId: "cus_1",
      customerNumber: "V-00123",
      entitlements: {}
    });
    assert.deepEqual(Object.keys(fields).sort(), [
      "customerContextStatus",
      "customerId",
      "customerNumber",
      "entitlements",
      "subjectType"
    ]);
  });

  it("omits every customer field for an anonymous chat, and says so", () => {
    // Omission alone would not be enough: a caller testing `!customerId`
    // cannot tell an absent field from an empty one. The named mode is the
    // positive statement.
    const fields = customerChatFields({ ok: true, mode: "anonymous" });

    assert.deepEqual(fields, { customerContextStatus: "anonymous" });
    assert.deepEqual(Object.keys(fields), ["customerContextStatus"]);
  });

  it("never sends an empty string in place of an identifier", () => {
    const fields = customerChatFields({ ok: true, mode: "anonymous" }) as Record<
      string,
      unknown
    >;

    for (const key of [
      "customerId",
      "customerNumber",
      "subjectType",
      "entitlements"
    ]) {
      assert.equal(key in fields, false, `${key} must not be present`);
    }
  });

  it("carries no note and no entitlement status for a customer either", () => {
    const fields = customerChatFields({
      ok: true,
      mode: "customer",
      context: { ...context, entitlementsNote: "should not travel" }
    }) as Record<string, unknown>;

    assert.equal("entitlementsNote" in fields, false);
    assert.equal("entitlementsStatus" in fields, false);
  });
});

describe("customerChatInstructions", () => {
  it("tells the model the identity and that an empty entitlement set is not a denial", () => {
    const instructions = customerChatInstructions(resolvedCustomer);

    assert.match(instructions, /cus_1/);
    assert.match(instructions, /V-00123/);
    assert.match(instructions, /not-modelled/);
    assert.match(instructions, /not\s+because this customer was denied/);
  });

  it("tells the model outright that it has no customer, rather than saying nothing", () => {
    /**
     * The assertion is that the absence is stated, not merely left out.
     *
     * A block that simply omits the customer lets the model answer as if it
     * knew who it was talking to. This is the same rule the OS side already
     * follows with entitlementsStatus: an absence has to say why it is absent,
     * or it gets read as a fact.
     */
    const instructions = customerChatInstructions({
      ok: true,
      mode: "anonymous"
    });

    assert.match(instructions, /no customer context/i);
    assert.match(instructions, /anonymous/i);
    assert.match(instructions, /must not imply otherwise/i);
  });

  it("does not push an anonymous visitor to identify themselves for a general question", () => {
    const instructions = customerChatInstructions({
      ok: true,
      mode: "anonymous"
    });

    assert.match(instructions, /Do not ask them to identify themselves/i);
    assert.match(instructions, /ONLY when/);
    assert.match(instructions, /order, a warranty, a device/i);
  });

  it("leaks no customer identifier into the anonymous block", () => {
    const instructions = customerChatInstructions({
      ok: true,
      mode: "anonymous"
    });

    assert.equal(instructions.includes("cus_1"), false);
    assert.equal(instructions.includes("V-00123"), false);
  });
});
