# The timeout chain

> **Reopen this page the moment an unnamed failure shows up.** If anyone sees a
> failure with no code and no `waitedMs` - an empty reply, or a bare 500 - that
> is not a new mystery. It is this page, and the first suspect is the outermost
> limit, whose value we never measured. See "What is still assumed" below.

A chat answer crosses six hops. Each one may give up on its own, and until this was measured the
tolerances were in the wrong order: the innermost hop waited the longest, so the chain was cut in
the middle and the caller saw a failure while the work was still running.

```text
1. browser
2. Next.js server            <- rewrite: /api/:path*  ->  Acropora OS API
3. Acropora OS API           (Nest, Node http server)
4. Caddy in front of the AI stack
5. Acropora AI API           (this service, Fastify)
6. OpenAI
```

Plus the proxy in front of the Acropora OS deployment, which is configured outside every
repository.

## The chain is mixed, and the numbers do not belong to one system

The internal test surface lives on the **production** Acropora OS dashboard and calls the
**stage** AI API. So hops 1-3 are production, hops 5-6 are stage, and the proxy in front of the
Acropora OS deployment sits between them on the production side.

This matters when reading any number below: a limit measured on one side is not evidence about
the other. Two deployments running the same software with the same defaults is a reasonable
guess, and a guess is what it stays until someone measures the side they are talking about.

## The rule

**The inner limit must be shorter than the outer one.** Whoever gives up first is the one that
can explain why, and an explanation is the whole difference between "the chat is broken" and "it
timed out after 25 seconds".

A corollary that is easy to miss: **a retry counts towards the inner limit.** Three attempts at
25 seconds is over a minute, and the hop in front knows nothing about our retries. That is why
this service does not retry by default.

## What was measured (2026-08-26)

| Hop | Limit | Value | How it was established |
|---|---|---|---|
| Next.js rewrite proxy (2) | `experimental.proxyTimeout` | **30 000 ms** | measured: 25 s passes, 31 s and 45 s come back as a bare 500 at 30.03 s |
| Acropora OS API (3) | `server.requestTimeout` | 300 000 ms | measured, Node 22 defaults |
| Caddy (4) | response timeout | none configured | read from the Caddyfile |
| this service (5) | Fastify `requestTimeout` | 0, no limit | measured from the running config |
| this service → OpenAI (6) | SDK timeout | was 600 000 ms with 2 retries | measured, `openai` 5.23.2 defaults |
| the proxy in front of the OS | ? | **not measured** | its configuration lives outside the repositories, on the production host |

One limit on that list was measured locally rather than in production: the 30 000 ms came from a
development server on a developer machine, and the constant that produces it is the same one the
production server uses. That is source-level evidence for the production path, not a measurement
of it - and since the surface will run on production, the difference is worth keeping in sight.

The Next.js number deserves its detail: when it fires, the browser receives a plain
`500 Internal Server Error`. Nothing in it says a timeout happened, and nothing says which hop
gave up. That failure mode - not the length - is what makes a slow chain expensive to debug.

## The ladder, as agreed

| Rung | Limit | Value | What the caller gets when it fires |
|---|---|---|---|
| 1 | the model call, in this service | **40 000 ms** | `504 ai_provider_timeout` with `waitedMs` |
| 2 | the socket net, in this service | **45 000 ms** | **nothing** - the connection closes with no HTTP answer |
| 3 | the Next.js rewrite proxy, in the OS web app | **50 000 ms** | a bare `500` |
| - | the Traefik proxy in front of the OS | **assumed to be unlimited** | see below |

**Only rung 1 explains itself.** That is why it is the shortest: whoever gives up
first has to be the one that can say why. Rungs 2 and 3 are there to stop a hang
that rung 1 cannot see, and both fail in a way that tells nobody anything.

The five second gaps are not taste. They are the window in which the named
failure can fire before a silent one takes the request away.

Rung 1 was 25 000 until the ladder was agreed. It was measured tight against
real questions rather than theoretical ones: of eleven product questions run on
stage, one timed out at 25 s and another answered at 24.9 s.

## What is still assumed, and what would reopen it

**The Traefik proxy in front of the Acropora OS was never measured.** Two
independent readings of its configuration came back empty - no timeout key
among the container's start flags, and none in the three files of its dynamic
configuration - so it runs on the image's defaults. That those defaults leave
the response side unlimited is a **documentation-level claim, not a measurement
of ours**: this machine has no container runtime, so the image could not be
started and timed here.

It is written down rather than hidden because the ladder depends on it. It also
does not matter while rung 1 holds: no answer reaches Traefik's limit unless
that limit is under 40 seconds. **And if it were, we would see it** - the person
asking would get an unnamed failure instead of a named one, which is exactly the
condition at the top of this page.

## What this service does now

`ACROPORA_AI_OPENAI_TIMEOUT_MS` (default **40 000**) and `ACROPORA_AI_OPENAI_MAX_RETRIES`
(default **0**), both passed to the OpenAI client explicitly, plus
`ACROPORA_AI_CONNECTION_TIMEOUT_MS` (default **45 000**) for the socket net. The first sits under
everything in front of it on purpose, so the timeout that fires is the one that can explain
itself.

When it fires, the answer is:

```json
{ "error": "ai_provider_timeout", "waitedMs": 25004 }
```

with status **504**, distinct from `502 ai_provider_error` for every other failure. `waitedMs`
travels on both, so a surface in front can show how long it waited rather than only saying that
something went wrong.

**Neither default is a decision that can outlive its measurement.** If the outer ceiling moves -
by raising `experimental.proxyTimeout` in the web app, or because the proxy in front of the OS
turns out to be shorter than 30 seconds - this value has to move with it, which is why it is an
environment variable and not a constant.
