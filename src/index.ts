interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * FRED MCP — Federal Reserve Economic Data (St. Louis Fed)
 *
 * BYO key: requires a FRED API key from https://fred.stlouisfed.org/docs/api/api_key.html
 * Passed via _apiKey parameter.
 *
 * Tools:
 * - fred_get_series: get observations for a data series (e.g., MORTGAGE30US, HOUST, CSUSHPISA)
 *   accepts `as_of` (or explicit realtime_start/realtime_end) for ALFRED "as published on
 *   date X" vintage queries; default (no vintage args) behavior is unchanged.
 * - fred_search: search for series by keyword
 * - fred_series_info: get metadata about a series
 * - fred_category: browse FRED categories
 * - fred_releases: get latest data releases
 * - fred_release_dates: release calendar (past + scheduled)
 * - fred_vintage_dates: every ALFRED vintage (revision) date for a series
 * - fred_revisions: how one observation's value changed across vintages (first release -> latest)
 *
 * - nyfed_gdp_nowcast / cleveland_fed_inflation_nowcast (added fleet #3239):
 *   KEYLESS — neither series is mirrored in FRED itself (confirmed by search
 *   before building: fred_search has no GDP-nowcast or inflation-nowcast
 *   series), so these proxy each regional Fed's own published page directly
 *   rather than going through the St. Louis Fed's API. No _apiKey required;
 *   dispatched before extractKey() below so a caller doesn't need a FRED key
 *   to use them.
 */


const BASE = 'https://api.stlouisfed.org/fred';

// Tool names that do NOT require a FRED API key — dispatched in callTool()
// before extractKey() runs, so a missing _apiKey never blocks them.
const KEYLESS_TOOLS = new Set(['nyfed_gdp_nowcast', 'cleveland_fed_inflation_nowcast']);

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('FRED API key required. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and pass via _apiKey.');
  return key;
}

// FRED's upstream (api.stlouisfed.org) periodically slows/stalls. Without a
// timeout the fetch hangs until Cloudflare kills the worker and returns a raw
// 504 to the agent — the failure isn't catchable, so the gateway circuit
// breaker can't trip. Abort at 8s instead: a clean error returns fast, and the
// breaker can short-circuit the pack after repeated failures.
//
// In-pack retry on 5xx + timeout (revised 2026-06-08). Initial single-retry
// landed 2026-06-07; production analytics next day showed FRED at 27 calls /
// 9 errors (33% — only a modest improvement from the pre-retry 37.5%). Per-
// attempt error rate is ~55%, suggesting FRED's CF origin has sustained
// flakiness, not isolated flakes. Bumped to 3 attempts total with
// exponential backoff (250ms, 1000ms). At p=0.55 per attempt, P(all 3 fail)
// drops to ~17%, vs ~30% with 2 attempts and 55% with 1. Attempt count is
// included in the final error message so we can see whether the cap should
// be raised further.
const FRED_RETRY_DELAYS_MS = [250, 1000]; // delay before attempts 2 and 3
async function fredFetch(url: string, attempt = 1): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (attempt <= FRED_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, FRED_RETRY_DELAYS_MS[attempt - 1]));
        return fredFetch(url, attempt + 1);
      }
      throw new Error(`upstream_down: FRED API timeout — api.stlouisfed.org did not respond within 8s on any of ${attempt} attempts.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500 && res.status < 600 && attempt <= FRED_RETRY_DELAYS_MS.length) {
    await new Promise((r) => setTimeout(r, FRED_RETRY_DELAYS_MS[attempt - 1]));
    return fredFetch(url, attempt + 1);
  }
  if (!res.ok) {
    // FRED answers a throttle with an Akamai HTML page, so pasting the body
    // handed the caller `<HTML><HEAD><TITLE>Access Denied</TITLE>…` verbatim.
    // httpErrorMessage keeps the title and drops the markup (fleet #712).
    const attemptNote = attempt > 1 ? ` (after ${attempt} attempts)` : '';
    throw new Error(`${await httpErrorMessage(res, 'FRED API')}${attemptNote}`);
  }
  return parseJson(res, 'FRED');
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'fred_get_series',
    description:
      'AUTHORITATIVE historical time-series for US economic indicators from FRED (Federal Reserve Bank of St. Louis — the official US macroeconomic data repository, 800k+ series). Every series is an AGGREGATE for a whole country, state, or METROPOLITAN AREA (e.g. the Phoenix or Oklahoma City metro), reported monthly or quarterly. Pass a series ID like "MORTGAGE30US" (30y mortgage rate), "UNRATE" (unemployment), "CPIAUCSL" (CPI), "GDP", "FEDFUNDS" (Fed funds rate), "HOUST" (housing starts), "RHORUSQ156N" (US homeownership rate — the percent of households that OWN their home, distinct from the mortgage interest rate). Returns dates + values + the indicator\'s units. Use for macro, Fed, and metro-level US indicator questions. DO NOT GUESS a non-US series ID by pattern-matching a US one — "DEUUNRATE", "JPNUNRATE", "CANUNRATE" and similar <ISO3><METRIC> codes do NOT exist on FRED and 400 with "the series does not exist". For a NON-US country\'s unemployment/GDP/inflation/population, use worldbank_get_indicator (ISO country code + indicator, e.g. SL.UEM.TOTL.ZS for unemployment) instead — it is the reliable source for foreign macro data. If you don\'t know a FRED series ID, call fred_search first rather than inventing one.',
    summary: 'A US economic indicator\'s full history, from the St. Louis Fed\'s FRED database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "MORTGAGE30US", "HOUST", "CSUSHPISA")' },
        observation_start: { type: 'string', description: 'Start date in YYYY-MM-DD format (optional)' },
        observation_end: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
        frequency: { type: 'string', description: 'Frequency aggregation (optional). Codes: d, w, bw, m, q, sa, a — English words also accepted (daily/weekly/biweekly/monthly/quarterly/semiannual/annual).' },
        units: { type: 'string', description: 'Data transformation: lin (levels), chg (change), ch1 (change from year ago), pch (% change), pc1 (% change from year ago), pca (compounded annual rate of change), cch (continuously compounded rate of change), cca (continuously compounded annual rate of change), log (natural log). Default: lin' },
        // Read at runtime since the newest-first fix, but never declared — so it
        // was invisible to callers and to every schema-based check.
        limit: { type: 'number', description: 'Max observations, newest first (1-100000, default 20)' },
        // Same gap `limit` had: read at runtime, never declared. Declared now so
        // a caller who wants a series in chronological order can ask for it
        // instead of reversing a truncated tail (fleet #718).
        sort_order: { type: 'string', description: 'Observation order: desc = newest first (default), asc = oldest first.', enum: ['asc', 'desc'] },
        as_of: { type: 'string', description: 'ALFRED vintage query: return the data as it was PUBLISHED on this date (YYYY-MM-DD), before any later revisions. Shorthand for realtime_start=realtime_end=as_of. Omit for the default: today\'s latest-revised values (unchanged from before this parameter existed).' },
        realtime_start: { type: 'string', description: 'ALFRED vintage query: start of the realtime (publication) window, YYYY-MM-DD. Use with realtime_end for a custom vintage range; use `as_of` for the common single-date case. Omit for the default latest-revised behavior.' },
        realtime_end: { type: 'string', description: 'ALFRED vintage query: end of the realtime (publication) window, YYYY-MM-DD. See realtime_start.' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', '_apiKey'],
    },
  },
  {
    name: 'fred_vintage_dates',
    description:
      'ALFRED revision history: every date FRED published a new vintage (initial release or a later revision) of a series. Use before fred_revisions to see which dates have a distinct vintage, or pass one of these dates as `as_of`/`realtime_start`+`realtime_end` to fred_get_series to get the data as it stood on that date.',
    summary: 'The ALFRED vintage (revision) dates for one FRED series, from the St. Louis Fed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "GDPC1", "PAYEMS")' },
        limit: { type: 'number', description: 'Max vintage dates to return (1-10000, default 100)' },
        sort_order: { type: 'string', description: 'asc = oldest vintage first, desc = newest vintage first (default desc)', enum: ['asc', 'desc'] },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', '_apiKey'],
    },
  },
  {
    name: 'fred_revisions',
    description:
      'How ONE observation (one date) in a FRED series was revised over time, from first release through every later vintage to the latest. Use on series that get revised after initial publication (e.g. GDP "GDPC1", payrolls "PAYEMS") to see the originally reported value versus the current one. Returns every ALFRED vintage on record for that observation, oldest first — consecutive vintages can repeat the same value, so compare `first_release.value` to `latest.value` (or scan `revisions`) to see whether it was ever actually revised.',
    summary: 'The revision history of one observation in a FRED series, across every ALFRED vintage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "GDPC1", "PAYEMS")' },
        observation_date: { type: 'string', description: 'The observation date to trace revisions for, YYYY-MM-DD (must match an actual observation date in the series — e.g. the first day of the quarter for quarterly series).' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', 'observation_date', '_apiKey'],
    },
  },
  {
    name: 'fred_search',
    description:
      'Search for economic data series by keyword. Returns series IDs, titles, and descriptions to identify the right indicator.',
    summary: 'US economic data series matching a keyword search, from the St. Louis Fed\'s FRED database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search_text: { type: 'string', description: 'Keywords to search for (e.g., "mortgage rate", "housing starts")' },
        limit: { type: 'number', description: 'Max results to return (1-1000, default 20)' },
        order_by: { type: 'string', description: 'Order results by: search_rank, series_id, title, units, frequency, seasonal_adjustment, realtime_start, realtime_end, last_updated, observation_start, observation_end, popularity, group_popularity. Default: search_rank' },
        sort_order: { type: 'string', description: 'Sort direction: asc or desc. Default: asc for search_rank' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['search_text', '_apiKey'],
    },
  },
  {
    name: 'fred_series_info',
    description:
      'Get metadata for a series: title, units, frequency, seasonal adjustment, notes, and date range. Check this before fetching historical data.',
    summary: 'The metadata for one FRED economic data series — units, frequency, last updated — from the St. Louis Fed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'FRED series ID (e.g., "MORTGAGE30US")' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['series_id', '_apiKey'],
    },
  },
  {
    name: 'fred_category',
    description:
      'Browse economic data by category (housing, employment, money/banking, etc.). Returns subcategories and related series IDs.',
    summary: 'The economic data series filed under one FRED category, from the St. Louis Fed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category_id: { type: 'number', description: 'Category ID to browse children of (default: 0 for root)' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'fred_releases',
    description:
      'Check upcoming and recent economic data releases. Returns release dates, names, and which series they update.',
    summary: 'The economic data releases (e.g. Employment Situation) tracked by FRED, from the St. Louis Fed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (1-1000, default 20)' },
        offset: { type: 'number', description: 'Result offset for pagination (default 0)' },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'fred_release_dates',
    description:
      'Economic data RELEASE CALENDAR from FRED — the dates indicators are/were published, including FUTURE scheduled dates. PREFER OVER WEB SEARCH for "when is the next CPI / jobs report / GDP release", "economic calendar", "Fed data release schedule". Omit release_id for the cross-release calendar; pass a release_id (from fred_releases — e.g. 10 = CPI, 50 = Employment Situation, 53 = GDP) for one release schedule. Returns release name + date, newest/upcoming first by default.',
    summary: 'The past and scheduled publication dates for one FRED data release, from the St. Louis Fed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        release_id: { type: 'number', description: 'Optional FRED release id (from fred_releases). Omit for the all-releases calendar.' },
        limit: { type: 'number', description: 'Max dates to return (1-1000, default 25)' },
        sort_order: { type: 'string', description: 'asc or desc (default desc — newest/upcoming first)', enum: ['asc', 'desc'] },
        _apiKey: { type: 'string', description: 'FRED API key' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'nyfed_gdp_nowcast',
    description:
      'The New York Fed Staff Nowcast — a weekly real GDP growth nowcast for the currently-tracked US quarter(s), from the Federal Reserve Bank of New York (keyless, NOT a FRED series — FRED\'s own catalog does not carry this). Answers "what is the NY Fed GDP nowcast", "current GDP growth estimate", "is the economy growing this quarter". Returns the headline nowcast percentage (annualized QoQ) for the quarter(s) actively being tracked (typically the most recent quarter awaiting its official BEA GDP release, plus the quarter in progress), with 50%/80% probability intervals where published, the publisher\'s own narrative explaining what moved the estimate this week, and recent CONCLUDED quarters\' final nowcast versus the actual BEA advance/latest GDP print. Updated every Friday (except federal holidays).',
    summary: 'This week\'s New York Fed real GDP growth nowcast, with the narrative behind the number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_history: { type: 'boolean', description: 'Include recent CONCLUDED quarters (final nowcast vs. actual BEA GDP). Default true.' },
        history_quarters: { type: 'number', description: 'How many concluded quarters of history to include (default 6, max 20). Ignored if include_history is false.' },
      },
    },
  },
  {
    name: 'cleveland_fed_inflation_nowcast',
    description:
      'Daily CPI and PCE inflation nowcasts (headline and core) from the Federal Reserve Bank of Cleveland — keyless, NOT a FRED series. Answers "what is the Cleveland Fed inflation nowcast", "current CPI estimate before the official release", "PCE inflation nowcast today". Returns month-over-month and year-over-year nowcasts for the current and prior month, plus quarterly annualized nowcasts for the current and next quarter. A blank value for a period/measure means the actual BLS (CPI) or BEA (PCE) release for that period has already been published, so the nowcast model stops estimating it. Updated every business day.',
    summary: 'Today\'s Cleveland Fed CPI/PCE inflation nowcast — month, year, and quarterly annualized.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'nyfed_gdp_nowcast') return nyfedGdpNowcast(args);
  if (name === 'cleveland_fed_inflation_nowcast') return clevelandInflationNowcast();

  const key = extractKey(args);

  switch (name) {
    case 'fred_get_series':
      return getSeries(key, args);
    case 'fred_search':
      return searchSeries(key, args);
    case 'fred_series_info':
      return seriesInfo(key, args.series_id as string);
    case 'fred_category':
      return getCategory(key, args.category_id as number | undefined);
    case 'fred_releases':
      return getReleases(key, args);
    case 'fred_release_dates':
      return getReleaseDates(key, args);
    case 'fred_vintage_dates':
      return getVintageDates(key, args);
    case 'fred_revisions':
      return getRevisions(key, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// FRED's `frequency` accepts only its short codes (d/w/bw/m/q/sa/a + week-
// ending variants). LLMs routinely pass the English word ("monthly", "Quarterly")
// → FRED 400s "Value of frequency is invalid" (the #1 fred error: 78/day). Map
// the common synonyms; pass valid codes through; DROP anything unrecognized
// (frequency is optional → return native-frequency data, never fail the fetch).
const FRED_FREQ = new Set(['d', 'w', 'bw', 'm', 'q', 'sa', 'a', 'wef', 'weth', 'wew', 'wetu', 'wem', 'wesm', 'wesa', 'bwew', 'bwem']);
const FRED_FREQ_SYNONYMS: Record<string, string> = {
  daily: 'd', day: 'd',
  weekly: 'w', week: 'w', wk: 'w',
  biweekly: 'bw', 'bi-weekly': 'bw', fortnightly: 'bw',
  monthly: 'm', month: 'm', mo: 'm', mon: 'm',
  quarterly: 'q', quarter: 'q', qtr: 'q', qtrly: 'q',
  semiannual: 'sa', 'semi-annual': 'sa', semiannually: 'sa', biannual: 'sa', 'half-yearly': 'sa',
  annual: 'a', annually: 'a', yearly: 'a', year: 'a', yr: 'a', y: 'a',
};
function normalizeFredFrequency(v: unknown): string | null {
  const s = String(v).trim().toLowerCase();
  if (FRED_FREQ.has(s)) return s;
  return FRED_FREQ_SYNONYMS[s] ?? null;
}

// ── Tool implementations ────────────────────────────────────────────────

// ALFRED vintage args. `as_of` is shorthand for realtime_start=realtime_end=as_of;
// explicit realtime_start/realtime_end (either or both) take precedence over
// `as_of` when present, so a caller can set a custom window. Absent all three,
// this returns {} and callers of getSeries set nothing extra on the request —
// which is the point: default behavior must stay byte-for-byte unchanged.
function resolveVintageArgs(args: Record<string, unknown>): { realtimeStart?: string; realtimeEnd?: string; asOf?: string } {
  const realtimeStart = args.realtime_start as string | undefined;
  const realtimeEnd = args.realtime_end as string | undefined;
  const asOf = args.as_of as string | undefined;
  if (realtimeStart || realtimeEnd) return { realtimeStart, realtimeEnd };
  if (asOf) return { realtimeStart: asOf, realtimeEnd: asOf, asOf };
  return {};
}

async function getSeries(key: string, args: Record<string, unknown>) {
  const seriesId = args.series_id as string;
  const { realtimeStart, realtimeEnd, asOf } = resolveVintageArgs(args);
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
  });
  if (args.observation_start) params.set('observation_start', args.observation_start as string);
  if (args.observation_end) params.set('observation_end', args.observation_end as string);
  if (args.frequency) {
    const f = normalizeFredFrequency(args.frequency);
    if (f) params.set('frequency', f); // unknown → drop, return native frequency (don't 400)
  }
  if (args.units) params.set('units', args.units as string);
  if (realtimeStart) params.set('realtime_start', realtimeStart);
  if (realtimeEnd) params.set('realtime_end', realtimeEnd);
  // FRED's observations API defaults to sort_order=asc + ALL observations, so a
  // bare fred_get_series(UNRATE) returned the full series from 1948 OLDEST-first
  // and ignored the documented `limit: 20` — agents read a decades-old value,
  // surfacing as "stale unemployment data" (user feedback 2026-06-24). Default to
  // NEWEST-first + honor the limit so the latest observation leads.
  params.set('sort_order', (args.sort_order as string) || 'desc');
  params.set('limit', String(Math.min(100000, Math.max(1, (args.limit as number) ?? 20))));

  const infoParams = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: 'json' });
  if (realtimeStart) infoParams.set('realtime_start', realtimeStart);
  if (realtimeEnd) infoParams.set('realtime_end', realtimeEnd);
  const [data, infoRaw] = await Promise.all([
    fredFetch(`${BASE}/series/observations?${params}`) as Promise<{
      realtime_start: string;
      realtime_end: string;
      observation_start: string;
      observation_end: string;
      count: number;
      observations: { date: string; value: string }[];
    }>,
    fredFetch(`${BASE}/series?${infoParams}`)
      .then((d) => ((d as { seriess?: { title: string; units: string; frequency: string; observation_start?: string; observation_end?: string }[] }).seriess?.[0] ?? null))
      .catch(() => null),
  ]);

  // Empty-window rescue. A "what is the current rate" question routed here
  // often arrives with a days-wide observation window, but weekly/monthly
  // series have no observation inside it — FRED answers 200 with an empty
  // array and the caller concludes "no data" (live case: MORTGAGE15US asked
  // with a 4-day window that started after the last weekly print). Refetch
  // without the window and lead with the latest observations, saying so.
  let obs = data;
  let windowNote: string | undefined;
  let usedWindowRescue = false;
  if (data.observations.length === 0 && (args.observation_start || args.observation_end)) {
    const p2 = new URLSearchParams({
      series_id: seriesId,
      api_key: key,
      file_type: 'json',
      sort_order: 'desc',
      limit: String(Math.min(20, Math.max(1, (args.limit as number) ?? 4))),
    });
    if (args.frequency) {
      const f = normalizeFredFrequency(args.frequency);
      if (f) p2.set('frequency', f);
    }
    if (args.units) p2.set('units', args.units as string);
    if (realtimeStart) p2.set('realtime_start', realtimeStart);
    if (realtimeEnd) p2.set('realtime_end', realtimeEnd);
    const retry = (await fredFetch(`${BASE}/series/observations?${p2}`)) as typeof data;
    if (retry.observations.length > 0) {
      obs = retry;
      usedWindowRescue = true;
      windowNote = `No observations between ${args.observation_start ?? 'series start'} and ${args.observation_end ?? 'today'} — this series publishes ${infoRaw?.frequency ? `${infoRaw.frequency.toLowerCase()}, ` : ''}so narrow recent windows can be empty. Returning the latest observations instead.`;
    }
  }

  // The observations endpoint ECHOES observation_start/observation_end back as
  // it received them, and when the caller sets neither, FRED substitutes its own
  // open bounds: 1600-01-01 and 9999-12-31. Emitting those under names that read
  // as coverage told every caller that US GDP runs from 1600 through 9999
  // (fleet #718). The real range is in the series metadata we already fetch
  // alongside, so publish THAT under these names — matching what
  // fred_series_info and fred_search already mean by them — and surface what the
  // caller asked for separately, only when they actually asked. If the metadata
  // call failed, omit the range rather than fall back to the sentinels.
  const rows = obs.observations.map((o) => ({
    date: o.date,
    value: o.value === '.' ? null : o.value,
  }));
  const returned = rows.length;
  const sortOrder = usedWindowRescue ? 'desc' : ((args.sort_order as string) || 'desc');
  const order = sortOrder === 'asc' ? 'oldest_first' : 'newest_first';
  // `count` is FRED's total for the requested window; `limit` (default 20) caps
  // what comes back. Reporting the total beside a short list with nothing
  // marking the cut is how a caller reads 20 rows as the whole series.
  const truncated = typeof obs.count === 'number' && returned < obs.count;
  const truncationNote = truncated
    ? `Showing ${returned} of ${obs.count} observations (${order.replace('_', ' ')}); raise \`limit\` for more.`
    : undefined;
  const notes = [windowNote, truncationNote].filter(Boolean);

  // Say what the series IS, in words (fleet #2238): a bare id plus numbers
  // reads as nothing to the gateway's entity check, so 62/72 fred_get_series
  // answers scored `unverifiable` even when the caller asked by exact id.
  const newest = order === 'newest_first' ? rows[0] : rows[rows.length - 1];
  const oldest = order === 'newest_first' ? rows[rows.length - 1] : rows[0];
  const statement =
    `FRED ${seriesId}${infoRaw?.title ? ` (${infoRaw.title})` : ''}: ${infoRaw?.units ?? 'units not reported'}, ${infoRaw?.frequency ?? 'native frequency'}, ` +
    `from the Federal Reserve Bank of St. Louis (FRED). ${returned} of ${obs.count} observation(s) returned ${order.replace('_', ' ')}` +
    (oldest && newest ? `, ${oldest.date} to ${newest.date}; latest ${newest.value ?? 'missing'} on ${newest.date}` : '') +
    '.';

  return {
    series_id: seriesId,
    ...(infoRaw?.title ? { series_title: infoRaw.title, series_name: infoRaw.title } : {}),
    source: 'Federal Reserve Bank of St. Louis (FRED)',
    statement,
    ...(infoRaw?.units ? { units: infoRaw.units } : {}),
    ...(infoRaw?.frequency ? { frequency: infoRaw.frequency } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    count: obs.count,
    returned,
    truncated,
    observation_order: order,
    ...(infoRaw?.observation_start ? { observation_start: infoRaw.observation_start } : {}),
    ...(infoRaw?.observation_end ? { observation_end: infoRaw.observation_end } : {}),
    ...(args.observation_start ? { requested_start: args.observation_start as string } : {}),
    ...(args.observation_end ? { requested_end: args.observation_end as string } : {}),
    // Only present when the caller asked for a vintage — absence here (and
    // everywhere above) is what keeps the no-args response byte-for-byte
    // identical to before this field existed.
    ...(realtimeStart || realtimeEnd
      ? {
          vintage: {
            ...(asOf ? { as_of: asOf } : {}),
            ...(realtimeStart ? { realtime_start: realtimeStart } : {}),
            ...(realtimeEnd ? { realtime_end: realtimeEnd } : {}),
          },
        }
      : {}),
    observations: rows,
  };
}

async function searchSeries(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    search_text: args.search_text as string,
    api_key: key,
    file_type: 'json',
  });
  const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 20));
  params.set('limit', String(limit));
  if (args.order_by) params.set('order_by', args.order_by as string);
  if (args.sort_order) params.set('sort_order', args.sort_order as string);

  const data = (await fredFetch(`${BASE}/series/search?${params}`)) as {
    count: number;
    seriess: {
      id: string;
      title: string;
      units: string;
      frequency: string;
      seasonal_adjustment: string;
      observation_start: string;
      observation_end: string;
      popularity: number;
      notes?: string;
    }[];
  };

  const hits = data.seriess ?? [];
  return {
    total_matches: data.count,
    returned: hits.length,
    truncated: typeof data.count === 'number' && hits.length < data.count,
    ...(typeof data.count === 'number' && hits.length < data.count
      ? { note: `Showing ${hits.length} of ${data.count} matching series; raise \`limit\` (max 1000) or narrow search_text.` }
      : {}),
    series: hits.map((s) => ({
      series_id: s.id,
      title: s.title,
      units: s.units,
      frequency: s.frequency,
      seasonal_adjustment: s.seasonal_adjustment,
      observation_start: s.observation_start,
      observation_end: s.observation_end,
      popularity: s.popularity,
      notes: s.notes ?? null,
    })),
  };
}

async function seriesInfo(key: string, seriesId: string) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
  });

  const data = (await fredFetch(`${BASE}/series?${params}`)) as {
    seriess: {
      id: string;
      title: string;
      units: string;
      units_short: string;
      frequency: string;
      frequency_short: string;
      seasonal_adjustment: string;
      seasonal_adjustment_short: string;
      observation_start: string;
      observation_end: string;
      last_updated: string;
      popularity: number;
      notes?: string;
    }[];
  };

  const s = data.seriess[0];
  if (!s) throw new Error(`Series not found: ${seriesId}`);

  return {
    series_id: s.id,
    title: s.title,
    units: s.units,
    units_short: s.units_short,
    frequency: s.frequency,
    frequency_short: s.frequency_short,
    seasonal_adjustment: s.seasonal_adjustment,
    seasonal_adjustment_short: s.seasonal_adjustment_short,
    observation_start: s.observation_start,
    observation_end: s.observation_end,
    last_updated: s.last_updated,
    popularity: s.popularity,
    notes: s.notes ?? null,
  };
}

async function getCategory(key: string, categoryId?: number) {
  const id = categoryId ?? 0;
  const params = new URLSearchParams({
    category_id: String(id),
    api_key: key,
    file_type: 'json',
  });

  const data = (await fredFetch(`${BASE}/category/children?${params}`)) as {
    categories: { id: number; name: string; parent_id: number }[];
  };

  return {
    parent_category_id: id,
    categories: data.categories.map((c) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parent_id,
    })),
  };
}

async function getReleases(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: key,
    file_type: 'json',
  });
  const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 20));
  params.set('limit', String(limit));
  if (args.offset) params.set('offset', String(args.offset as number));

  const data = (await fredFetch(`${BASE}/releases?${params}`)) as {
    count: number;
    releases: {
      id: number;
      name: string;
      press_release: boolean;
      link?: string;
      notes?: string;
    }[];
  };

  const rels = data.releases ?? [];
  return {
    total_releases: data.count,
    returned: rels.length,
    truncated: typeof data.count === 'number' && rels.length < data.count,
    ...(typeof data.count === 'number' && rels.length < data.count
      ? { note: `Showing ${rels.length} of ${data.count} releases; raise \`limit\` (max 1000) or page with \`offset\`.` }
      : {}),
    releases: rels.map((r) => ({
      id: r.id,
      name: r.name,
      press_release: r.press_release,
      link: r.link ?? null,
      notes: r.notes ?? null,
    })),
  };
}

async function getReleaseDates(key: string, args: Record<string, unknown>) {
  const cap = Math.min(1000, Math.max(1, (args.limit as number) ?? 25));
  // Fetch the full schedule (desc + future scheduled dates), then partition by
  // today so the NEXT release is the headline — FRED has no date>=today filter,
  // and a raw asc/desc sort buries the imminent release. 1000 rows comfortably
  // spans the ~1y of future scheduled dates back through recent actuals.
  const params = new URLSearchParams({
    api_key: key,
    file_type: 'json',
    limit: '1000',
    sort_order: 'desc',
  });
  const rid = args.release_id;
  const single = rid != null && Number.isFinite(Number(rid));
  // Future scheduled dates only for a SINGLE release — across ALL releases the
  // far-future flood (300+ releases x ~12 months) overflows any fetch window
  // and makes a cross-release "next" unreliable, so cross-release returns recent actuals.
  if (single) { params.set('release_id', String(Math.floor(Number(rid)))); params.set('include_release_dates_with_no_data', 'true'); }
  const path = single ? 'release/dates' : 'releases/dates';
  const data = (await fredFetch(`${BASE}/${path}?${params}`)) as {
    release_dates?: { release_id?: number; release_name?: string; date?: string }[];
  };
  const all = (data.release_dates ?? []).filter((d) => d.date);
  const today = new Date().toISOString().slice(0, 10);
  const shape = (d: { release_id?: number; release_name?: string; date?: string }) => ({ release_id: d.release_id ?? null, release_name: d.release_name ?? null, date: d.date ?? null });
  const upcoming = all.filter((d) => (d.date as string) >= today).sort((a, b) => (a.date as string).localeCompare(b.date as string));
  const recent = all.filter((d) => (d.date as string) < today).sort((a, b) => (b.date as string).localeCompare(a.date as string));
  return {
    release_id: single ? Math.floor(Number(rid)) : null,
    as_of: today,
    next_release: upcoming[0] ? shape(upcoming[0]) : null,
    note: single ? undefined : 'Cross-release calendar returns RECENT releases. For an upcoming schedule / next release date, pass a release_id (from fred_releases).',
    upcoming: upcoming.slice(0, cap).map(shape),
    recent: recent.slice(0, cap).map(shape),
  };
}

async function getVintageDates(key: string, args: Record<string, unknown>) {
  const seriesId = args.series_id as string;
  const cap = Math.min(10000, Math.max(1, (args.limit as number) ?? 100));
  const sortOrder = (args.sort_order as string) === 'asc' ? 'asc' : 'desc';
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
    sort_order: sortOrder,
    limit: '10000', // FRED's own cap; we slice to the caller's `limit` ourselves so `truncated` is honest
  });

  const data = (await fredFetch(`${BASE}/series/vintagedates?${params}`)) as {
    count: number;
    vintage_dates: string[];
  };

  const all = data.vintage_dates ?? [];
  const returned = all.slice(0, cap);
  const truncated = returned.length < all.length;
  return {
    series_id: seriesId,
    total_vintages: typeof data.count === 'number' ? data.count : all.length,
    returned: returned.length,
    truncated,
    ...(truncated
      ? { note: `Showing ${returned.length} of ${all.length} vintage dates (${sortOrder === 'desc' ? 'newest first' : 'oldest first'}); raise \`limit\` for more.` }
      : {}),
    vintage_dates: returned,
  };
}

// FRED's output_type=2 ("Observations by Vintage Date, All Observations")
// does NOT return one row per vintage — verified against the live response
// (2026-10-07, after shipping a first version that assumed it did and got
// `{}` back for every vintage). It returns ONE ROW for the requested
// observation_date, with the date in `date` and one EXTRA COLUMN PER VINTAGE,
// named `<SERIES_ID>_<YYYYMMDD>` — e.g. `{ date: "2023-07-01",
// GDPC1_20231026: "22490.692", GDPC1_20231129: "22475.212", ... }`. A missing
// vintage column's value is FRED's usual "." null marker, not absence.
const VINTAGE_COLUMN = /^.+_(\d{8})$/;

function parseVintageRow(row: Record<string, string>): { vintage_date: string; value: string | null }[] {
  const out: { vintage_date: string; value: string | null }[] = [];
  for (const [col, raw] of Object.entries(row)) {
    const m = col.match(VINTAGE_COLUMN);
    if (!m) continue; // `date` itself, or any non-vintage field FRED adds
    const ymd = m[1];
    const vintageDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    out.push({ vintage_date: vintageDate, value: raw === '.' ? null : raw });
  }
  out.sort((a, b) => a.vintage_date.localeCompare(b.vintage_date));
  return out;
}

async function getRevisions(key: string, args: Record<string, unknown>) {
  const seriesId = args.series_id as string;
  const observationDate = args.observation_date as string;
  // Pinning observation_start=observation_end=observationDate and spanning the
  // full realtime range (FRED's documented earliest/latest sentinels) returns
  // the whole revision history of one observation in a single call — no need
  // to walk fred_vintage_dates and refetch per date.
  //
  // realtime_end must be FRED's documented max sentinel (9999-12-31), NOT
  // `new Date()`-derived "today" — FRED 400s "Variable realtime_end can not be
  // after today's date … unless it's equal to the real-time max date 9999-12-31"
  // whenever the CALLER's UTC day has already rolled past FRED's Central-time
  // day (reproduced live post-deploy on 2026-10-07: the gateway's UTC day was
  // 10-07 while FRED still considered it 10-06). The sentinel means "no upper
  // bound" to FRED, so it also means we never need to recompute it again.
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
    observation_start: observationDate,
    observation_end: observationDate,
    realtime_start: '1776-07-04', // FRED's documented sentinel for "earliest possible"
    realtime_end: '9999-12-31', // FRED's documented sentinel for "latest possible" — never "today"
    output_type: '2',
  });

  const data = (await fredFetch(`${BASE}/series/observations?${params}`)) as {
    observations: Record<string, string>[];
  };

  const rows = data.observations ?? [];
  const row = rows.find((o) => o.date === observationDate) ?? rows[0];
  const revisions = row ? parseVintageRow(row) : [];

  return {
    series_id: seriesId,
    observation_date: observationDate,
    // The number of ALFRED VINTAGES on record for this observation — NOT how
    // many times the value actually changed. Consecutive vintages can (and
    // often do) repeat the same value; compare first_release.value to
    // latest.value, or scan `revisions`, to see whether it was ever revised.
    revisions_count: revisions.length,
    ...(revisions.length === 0
      ? { note: `No observation found for ${observationDate} on ${seriesId} — confirm the date matches an actual observation (e.g. the first day of the period for quarterly/monthly series), or call fred_get_series first.` }
      : {}),
    first_release: revisions[0] ?? null,
    latest: revisions[revisions.length - 1] ?? null,
    revisions,
  };
}

// ── nyfed_gdp_nowcast / cleveland_fed_inflation_nowcast (fleet #3239) ─────
//
// Neither series exists in FRED's own catalog — confirmed via fred_search
// before building (no GDP-nowcast or inflation-nowcast series on either
// bank). Both regional Feds publish the underlying data files directly on
// their own sites with no API key, so these proxy those files live, per
// request: no data at module scope, no copy kept between calls.

async function fetchExternal(url: string, name: string): Promise<Response> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pipeworx/1.0; +https://pipeworx.io)' } }, name, 8000);
  if (!res.ok) throw await httpError(res, name);
  return res;
}

// RFC4180-ish CSV parser (quoted fields, embedded commas/newlines, "" escape).
// Both NY Fed CSVs below rely on this: the Note column's narrative sentences
// contain literal commas inside quoted fields.
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = ''; records.push(record); record = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

function parseCsvRows(text: string): Record<string, string>[] {
  const records = parseCsvRecords(text);
  if (!records.length) return [];
  const header = records[0].map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec.length === 1 && rec[0].trim() === '') continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (rec[c] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

const NYFED_NOWCAST_BASE = 'https://www.newyorkfed.org/medialibrary/Research/Interactives/Data/NowCast/data';

// "16-Oct" + "2026" -> "2026-10-16". The CSV's Update column has no year of
// its own; Year is a separate column on the same row.
const MONTH_ABBR: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function nyfedUpdateToIso(update: string, year: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(update.trim());
  if (!m || !year) return null;
  const mm = MONTH_ABBR[m[2].toLowerCase()];
  if (!mm) return null;
  return `${year}-${mm}-${m[1].padStart(2, '0')}`;
}

interface NyfedCurrentEstimate {
  quarter: string;
  nowcast_pct: number;
  probability_interval_50_pct?: [number, number];
  probability_interval_80_pct?: [number, number];
}

async function nyfedGdpNowcast(args: Record<string, unknown>) {
  const includeHistory = args.include_history !== false;
  const historyLimit = Math.min(20, Math.max(1, (args.history_quarters as number) ?? 6));

  const metaRes = await fetchExternal(`${NYFED_NOWCAST_BASE}/nowcast-history-meta-data.csv`, 'New York Fed Staff Nowcast');
  const metaRows = parseCsvRows(await metaRes.text());

  // The row the bank itself flags as the quarter its weekly file currently
  // tracks (it also carries the forward quarter's nowcast in its narrative
  // text) — not "today's calendar quarter", which is wrong whenever GDP for
  // the prior quarter hasn't been officially released yet.
  const landing = metaRows.find((r) => r.landingQuarter === '1');
  if (!landing) {
    throw new Error('upstream_shape_changed: New York Fed Staff Nowcast history file has no row with landingQuarter=1 — the publisher may have changed this file\'s structure.');
  }
  const qNum = /Q(\d)/.exec(landing.quarter)?.[1];
  if (!qNum || !landing.year) {
    throw new Error(`upstream_shape_changed: could not parse the landing quarter from "${landing.year} ${landing.quarter}".`);
  }
  const quarterFile = `${landing.year}Q${qNum}.csv`;
  const quarterRes = await fetchExternal(`${NYFED_NOWCAST_BASE}/${quarterFile}`, 'New York Fed Staff Nowcast');
  const rows = parseCsvRows(await quarterRes.text());

  // Narrative summary rows: empty Data Series, non-empty Note. The headline
  // one states "... Nowcast for YYYY:QN is X.X% ...". Scan from the end so a
  // row of blank FUTURE weeks (published in advance with empty cells) never
  // wins over the latest actual update.
  let headline: Record<string, string> | null = null;
  const narrativeLines: string[] = [];
  let headlineUpdate: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r['Data Series'] || !r.Note) continue;
    if (!headlineUpdate) {
      if (!/Nowcast for \d{4}:Q\d is/.test(r.Note)) continue; // keep scanning for the headline row
      headline = r;
      headlineUpdate = r.Update;
    }
    if (r.Update !== headlineUpdate) break; // past the most recent week's narrative block
    narrativeLines.unshift(r.Note);
  }

  if (!headline) {
    return {
      source: 'Federal Reserve Bank of New York, Staff Nowcast',
      found: false,
      note: `No published narrative row found in ${quarterFile} — the file may not have its first weekly update of the quarter yet.`,
      landing_quarter: `${landing.year}:${landing.quarter}`,
    };
  }

  const text = narrativeLines.join(' ');
  const estimates: NyfedCurrentEstimate[] = [];
  const qRe = /Nowcast for (\d{4}:Q\d) is (-?[0-9.]+)%/g;
  let qm: RegExpExecArray | null;
  while ((qm = qRe.exec(text))) {
    estimates.push({ quarter: qm[1], nowcast_pct: Number(qm[2]) });
  }
  const p50 = /50% probability interval at \[(-?[0-9.]+), (-?[0-9.]+)\]/.exec(text);
  const p80 = /80% interval at \[(-?[0-9.]+), (-?[0-9.]+)\]/.exec(text);
  if (estimates.length) {
    if (p50) estimates[0].probability_interval_50_pct = [Number(p50[1]), Number(p50[2])];
    if (p80) estimates[0].probability_interval_80_pct = [Number(p80[1]), Number(p80[2])];
  }

  const asOf = nyfedUpdateToIso(headline.Update, headline.Year);

  const concluded = metaRows
    .filter((r) => r.concluded === '1')
    .sort((a, b) => (b.year + b.quarter).localeCompare(a.year + a.quarter))
    .slice(0, historyLimit)
    .map((r) => ({
      quarter: `${r.year}:${r.quarter}`,
      final_nowcast_pct: r.finalNowcast ? Number(r.finalNowcast) : null,
      final_nowcast_date: r.finalNowcastReleaseDate || null,
      bea_advance_gdp_pct: r.advancedGDP ? Number(r.advancedGDP) : null,
      bea_advance_release_date: r.advancedReleaseDate || null,
      bea_latest_gdp_pct: r.latestGDP ? Number(r.latestGDP) : null,
      bea_latest_release_date: r.latestReleaseDate || null,
    }));

  return {
    source: 'Federal Reserve Bank of New York, Staff Nowcast',
    found: true,
    as_of: asOf,
    current_estimates: estimates.length ? estimates : undefined,
    ...(estimates.length === 0 ? { note: `Could not parse a quarter/percentage out of this week's narrative text; returning it raw. Raw narrative: "${text}"`, parsed: false } : {}),
    narrative: text,
    release_schedule: 'Updated each Friday (except federal holidays) at or shortly after 12:45 p.m. ET, using data available up to 10 a.m.',
    ...(includeHistory ? { concluded_quarters_history: concluded } : {}),
  };
}

const CFED_INFLATION_URL = 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting';

interface CfedTableRow {
  period: string;
  cpi_pct: number | null;
  core_cpi_pct: number | null;
  pce_pct: number | null;
  core_pce_pct: number | null;
  updated: string | null;
}

function parseCfedTable(html: string, caption: string): CfedTableRow[] {
  const capIdx = html.indexOf(`<caption>${caption}</caption>`);
  if (capIdx === -1) return [];
  const tbodyStart = html.indexOf('<tbody>', capIdx);
  const tbodyEnd = html.indexOf('</tbody>', tbodyStart);
  if (tbodyStart === -1 || tbodyEnd === -1) return [];
  const body = html.slice(tbodyStart, tbodyEnd);
  const rows: CfedTableRow[] = [];
  const trRe = /<tr>(.*?)<\/tr>/gs;
  let trm: RegExpExecArray | null;
  while ((trm = trRe.exec(body))) {
    const cells = [...trm[1].matchAll(/<td>(.*?)<\/td>/gs)].map((m) => m[1].trim());
    if (cells.length < 6) continue;
    const num = (s: string) => (s === '' ? null : Number(s));
    rows.push({ period: cells[0], cpi_pct: num(cells[1]), core_cpi_pct: num(cells[2]), pce_pct: num(cells[3]), core_pce_pct: num(cells[4]), updated: cells[5] || null });
  }
  return rows;
}

async function clevelandInflationNowcast() {
  const res = await fetchExternal(CFED_INFLATION_URL, 'Cleveland Fed Inflation Nowcasting');
  const html = await res.text();

  const monthlyMom = parseCfedTable(html, 'Inflation, month-over-month percent change');
  const monthlyYoy = parseCfedTable(html, 'Inflation, year-over-year percent change');
  const quarterly = parseCfedTable(html, 'Quarterly annualized percent change');

  if (!monthlyMom.length && !monthlyYoy.length && !quarterly.length) {
    throw new Error('upstream_shape_changed: Cleveland Fed Inflation Nowcasting page did not contain the expected data tables — the publisher may have changed the page layout.');
  }

  const headlineMonth = monthlyMom[0] ?? null;
  const headlineYoy = monthlyYoy[0] ?? null;
  const headlineQuarter = quarterly[0] ?? null;

  return {
    source: 'Federal Reserve Bank of Cleveland, Inflation Nowcasting',
    found: true,
    current: {
      month: headlineMonth?.period ?? null,
      updated: headlineMonth?.updated ?? null,
      month_over_month_pct: headlineMonth ? { cpi: headlineMonth.cpi_pct, core_cpi: headlineMonth.core_cpi_pct, pce: headlineMonth.pce_pct, core_pce: headlineMonth.core_pce_pct } : null,
      year_over_year_pct: headlineYoy ? { cpi: headlineYoy.cpi_pct, core_cpi: headlineYoy.core_cpi_pct, pce: headlineYoy.pce_pct, core_pce: headlineYoy.core_pce_pct } : null,
      quarter: headlineQuarter?.period ?? null,
      quarterly_annualized_pct: headlineQuarter ? { cpi: headlineQuarter.cpi_pct, core_cpi: headlineQuarter.core_cpi_pct, pce: headlineQuarter.pce_pct, core_pce: headlineQuarter.core_pce_pct } : null,
    },
    methodology_note: 'A blank value for a period/measure means the actual BLS (CPI) or BEA (PCE) release for that period has already been published, so the nowcast model stops estimating it — check the headline series\' source data directly (e.g. fred_get_series) for the released figure.',
    monthly_month_over_month: monthlyMom,
    monthly_year_over_year: monthlyYoy,
    quarterly_annualized: quarterly,
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
