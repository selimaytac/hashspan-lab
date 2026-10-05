/** A setup problem whose message is safe to print: it never contains a key or an RPC URL. */
export class LabSetupError extends Error {
  override name = 'LabSetupError';
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
// A private key, or anything as long as one: 32 bytes of hex, with or without 0x. Transaction hashes are the same
// length; a safe message never needs one, the run summary carries them.
const KEY_PATTERN = /(0x)?[0-9a-f]{64}/gi;

/** Removes URLs and key-sized hex strings from a message. */
export function scrub(message: string): string {
  return message.replace(URL_PATTERN, '<url>').replace(KEY_PATTERN, '<hex>');
}

/**
 * A message for `error` that is safe to print. A `LabSetupError` keeps its message; anything else is reduced to its
 * short message (viem's full messages include the RPC URL, which may carry an API key) or its name, and scrubbed. A
 * failed HTTP request adds its method, status and details (`httpRequestDetails`) in parentheses. Every part of a
 * configured URL that could be a credential (`configuredUrlParts` of `env`) is removed from the result, since a
 * provider may echo it in an error body.
 */
export function safeErrorMessage(
  error: unknown,
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): string {
  if (error instanceof LabSetupError) return error.message;
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    const message = scrub(typeof short === 'string' && short ? short : error.name);
    const parts = configuredUrlParts(env);
    const http = httpRequestDetails(error, parts);
    return redactParts(http ? `${message} (${http})` : message, parts);
  }
  return 'Unknown error';
}

/** Shorter parts are left alone: path words such as `rpc` or `v2` are not credentials and are common in messages. */
const SECRET_PART_MIN = 8;

/**
 * The parts of the URLs configured in `env` (every variable whose name ends in `_URL`) that can carry a credential:
 * path segments, query values, user name and password, decoded, at least 8 characters long. A keyed RPC or bundler
 * URL puts its key in one of these.
 */
export function configuredUrlParts(env: Record<string, string | undefined>): string[] {
  const parts = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith('_URL') || !value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const candidates = [
      ...url.pathname.split('/'),
      ...[...url.searchParams.values()],
      url.username,
      url.password,
    ];
    for (const candidate of candidates) {
      let decoded = candidate;
      try {
        decoded = decodeURIComponent(candidate);
      } catch {}
      for (const part of new Set([candidate, decoded])) {
        if (part.length >= SECRET_PART_MIN) parts.add(part);
      }
    }
  }
  return [...parts];
}

/** `text` with every occurrence of each of `parts` replaced by `<redacted>`, longest first. */
export function redactParts(text: string, parts: readonly string[]): string {
  return [...parts]
    .sort((a, b) => b.length - a.length)
    .reduce((result, part) => result.split(part).join('<redacted>'), text);
}

/** A run of 24 or more letters, digits, `_` or `-`: the shape of an API key or token, never of a readable message. */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{24,}/g;

const RPC_METHOD = /^[A-Za-z0-9]+_[A-Za-z0-9]+$/;

/**
 * What tells one failed HTTP request from another without the URL or the request's parameters: the JSON-RPC method,
 * the HTTP status and the first line of viem's details (the response text or the fetch error), scrubbed, with
 * `secretParts` and token-shaped runs replaced before it is cut to 100 characters, so no cut leaves part of one. Taken from the first viem `HttpRequestError` in the error's cause chain; empty when there is none.
 */
export function httpRequestDetails(error: unknown, secretParts: readonly string[] = []): string {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
    if (current.name === 'HttpRequestError') {
      const { body, status, details } = current as {
        body?: unknown;
        status?: unknown;
        details?: unknown;
      };
      const first = Array.isArray(body) ? body[0] : body;
      const method = (first as { method?: unknown } | undefined)?.method;
      const parts = [
        typeof method === 'string' && RPC_METHOD.test(method)
          ? Array.isArray(body) && body.length > 1
            ? `${method} and ${body.length - 1} more`
            : method
          : null,
        typeof status === 'number' ? `status ${status}` : null,
        typeof details === 'string' && details.trim()
          ? redactParts(scrub(details.trim().split('\n')[0] as string), secretParts)
              .replace(TOKEN_PATTERN, '<token>')
              .slice(0, 100)
          : null,
      ].filter((part): part is string => part !== null);
      return parts.join(', ');
    }
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

/** Whether a run stopped on a setup problem (no key, too little balance, another chain) or on anything else. */
export type ErrorKind = 'setup' | 'unexpected';

/** `setup` for a `LabSetupError`, `unexpected` for anything else. */
export function errorKind(error: unknown): ErrorKind {
  return error instanceof LabSetupError ? 'setup' : 'unexpected';
}
