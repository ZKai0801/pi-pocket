/**
 * The one place that decides what a failed credential operation may print.
 *
 * `store.save()` seals through the native vault and `store.forgetSecrets()`
 * forgets through it; either can reject with a message that carries the secret
 * the user just typed. A log line is not a diagnostic event with a schema — it
 * is free text — so the secret hygiene has to live at the call site. This
 * helper is that call site's single gate: callers log `redactForLog(error)`,
 * never the error, and never the message on its own.
 *
 * Over-redaction is preferred to a leak: a long alphanumeric path segment can
 * be redacted as if it were key material.
 *
 * An unquoted multi-word value keeps its tail (only the first token is removed);
 * the caller never logs a value, only messages.
 */

/** A PEM private-key block, from its BEGIN line through its END line. */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g;

/**
 * The shortest run treated as key/sealed material. 32 is long enough to catch
 * a raw 128-bit value or a truncated key, short enough that ordinary error
 * words survive. Hex is a subset of the base64 alphabet, so one rule covers
 * both.
 */
const MATERIAL_RUN_MIN = 32;
const BASE64_OR_HEX_RUN = new RegExp(`[A-Za-z0-9+/]{${MATERIAL_RUN_MIN},}={0,2}`, 'g');

/**
 * A `passphrase` / `password` / `secret` assignment, quoted key or not. The
 * value is quote-aware so a quoted secret containing spaces is consumed whole
 * (including its closing quote) and escape-aware so an escaped quote does not
 * end it early; an unquoted value stops at whitespace or a list separator. The
 * key and its separator are kept; only the value becomes `<redacted>`.
 */
const SECRET_ASSIGNMENT = /(\b["']?(?:passphrase|password|secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;

/**
 * `String` can throw (`Object.create(null)`, a `toString` that throws). Logging
 * must not rethrow from inside a `catch`, so the conversion is total.
 */
function toText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unrepresentable>';
  }
}

function redactText(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, '<redacted-private-key>')
    .replace(SECRET_ASSIGNMENT, '$1<redacted>')
    .replace(BASE64_OR_HEX_RUN, '<redacted-secret>');
}

/**
 * `<ErrorName>: <redacted message>` — the only text a failure may log.
 *
 * The name is kept because it is the one part that says which class failed
 * without carrying user material. Anything passphrase-shaped, PEM-shaped, or
 * long enough to be key/sealed material is replaced before the text leaves.
 */
export function redactForLog(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'UnknownError';
  const message =
    error instanceof Error
      ? error.message == null
        ? ''
        : toText(error.message)
      : toText(error);
  return `${name}: ${redactText(message)}`;
}
