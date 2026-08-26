# The public boundary of the AI API

This API is **not** a public endpoint for a browser or a mobile app to call. A server-side layer
belongs in front of it. This page says what that means concretely, what is true today, and which
of it is held in place by a test rather than by a promise.

## The required chain

```text
Browser / mobile app
        |  a public, client-shaped request
        v
Acropora OS BFF, or a dedicated server-side AI gateway
        |  carries the server-side secrets
        v
Acropora AI API            <- this service
        |  carries the dedicated OS service token
        v
Acropora OS user-context endpoint
```

## What must never happen

- The browser must not call `/v1/chat` directly, and the same is true of every other route
  here: `/v1/messages/:messageId/rating` and `/v1/conversations/:conversationId/ratings` sit
  behind the same shared token and the same absent CORS.
- `API_ACCESS_TOKEN`, `ACROPORA_OS_AI_SERVICE_TOKEN` and any OpenAI key must not reach a browser
  bundle, a mobile app, a URL, a query parameter, a client-side log, this repository, or
  `.env.example`.
- **The layer in front must take the customer identifier from its own proven session, never from
  the request it received.** This is the single most important line on this page. A BFF that
  forwards a `customerId` its own caller supplied has rebuilt the hole it exists to close, and
  nothing downstream can tell the difference: this API cannot see where the identifier came from.
- An anonymous visitor must not be given order, warranty, device or any other personal data.

## What is true today, measured

- **`X-Acropora-User-Id` is a claim, not proof.** The only credential this API checks is
  `API_ACCESS_TOKEN`, which identifies the *calling system*. Whoever holds it may name any
  customer. Which mechanism replaces this is an open decision.
- **The service is reachable from the public internet.** The reverse proxy publishes it with no
  path restriction, so the shared token is the only gate in front of any route.
- **A rating names its author, and the name is a claim like any other.** `ratedBy` is required
  and stored as sent; this API cannot tell whether the layer in front took it from a proven
  session. Ownership is still enforced: a rating is refused unless the answer belongs to a
  conversation of the calling client, and the refusal is the same 404 for an unknown id, for
  somebody else's conversation and for a message that is a question rather than an answer, so
  the route cannot be used to find out which ids exist.
- **No browser page on another origin can use it.** Nothing here speaks CORS: a preflight gets no
  route, and no response carries an `Access-Control-Allow-Origin` header. A cross-origin page can
  therefore neither complete a call that carries an `Authorization` header nor read a reply.
- **Secrets do not reach the log.** The default request logger records the method, url, host and
  remote address - never headers, never the body. Upstream failures are logged through a summary
  that keeps four fields and redacts known secret values and provider key shapes; the provider's
  error object is never handed to the logger.

## What a test holds in place

| Claim | Where |
|---|---|
| a cross-origin browser page cannot preflight or read a response | `app.spec.ts` |
| an anonymous chat never calls the Acropora OS | `customer-context.spec.ts` |
| a request with no API access token is refused | `app.spec.ts` |
| a rating is refused without the token, and stored against nothing | `app.spec.ts` |
| a rating against another client's answer is refused | `app.spec.ts` |
| the model is handed the clause about what it cannot see | `app.spec.ts` |
| the stored rating values and the ones the code accepts are the same set | `evaluations.spec.ts` |
| no branch of the customer-context lookup returns a secret | `customer-context.spec.ts` |
| an upstream error summary carries no secret, whatever the provider attached | `redact.spec.ts` |
| the failure branch hands the logger that summary and not the provider's error | `app.spec.ts` |

The CORS test is the one worth understanding: it does not claim the API is unreachable. It claims
that **a browser page on another origin** cannot use it, and it turns red the moment a permissive
CORS plugin is added - which is exactly the change that would quietly make a direct browser call
possible.

## What this page does not cover

The boundary above is what the code can hold. Two things it cannot, and they are named here on
purpose: a page that lists only what is settled makes the system look safer than it is.

A third used to stand here: the log line that redacts an upstream error was itself untested,
because the failure branch sat behind the database and nothing could reach it. It is covered
now - the model client is injectable, and the logger is too, so a test reads back what the
line was given rather than trusting that it was the summary.

- **Whether the layer in front is honest.** If the BFF takes the customer identifier from its own
  caller instead of from its session, every check here still passes.
- **What a deployment does.** Whether the service is reachable, and from where, is set by the
  reverse proxy and the network. That is the first item above, and no test can settle it.

One more thing this page is not: a claim that merging here is neutral. There is no PR check in
this repository, and the one workflow deploys to stage on a push to `main` - so a merge is a
release, not a checkpoint.
