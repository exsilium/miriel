/**
 * Human-readable message for any thrown value. Node reports a refused
 * connection to several addresses as an AggregateError with an empty
 * message, so unwrap nested errors and surface their codes.
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map(describeError).filter(Boolean);
    const head = err.message || "multiple errors";
    return parts.length ? head + ": " + [...new Set(parts)].join("; ") : head;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = err.message || err.name;
    const withCode = code && !msg.includes(code) ? msg + " (" + code + ")" : msg;
    const cause = (err as { cause?: unknown }).cause;
    return cause ? withCode + " <- " + describeError(cause) : withCode;
  }
  return String(err);
}
