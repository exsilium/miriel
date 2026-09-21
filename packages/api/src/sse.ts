/**
 * Minimal server-sent events writer over Fastify's raw response.
 *
 * Client disconnects are detected through the *response*: on current Node an
 * http.IncomingMessage emits "close" as soon as its body has been consumed,
 * which for a POST happens before we start streaming, so listening on the
 * request would mark every stream as closed immediately.
 */
import type { ServerResponse } from "node:http";

export interface SseWriter {
  /** False once the client has gone away (or the stream was closed). */
  readonly open: boolean;
  send(event: string, data: unknown): void;
  close(): void;
}

export function encodeSse(event: string, data: unknown): string {
  // JSON never contains raw newlines, so one data: line is enough.
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

export function openSse(res: ServerResponse, heartbeatMs = 15_000): SseWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  let open = true;
  const heartbeat = setInterval(() => {
    if (open) res.write(": ping\n\n");
  }, heartbeatMs);
  const markClosed = (): void => {
    open = false;
    clearInterval(heartbeat);
  };
  // "close" on the response fires when the connection drops mid-stream, or
  // after our own end(); "error" covers EPIPE-style write failures.
  res.on("close", markClosed);
  res.on("error", markClosed);

  return {
    get open() {
      return open && !res.destroyed && !res.writableEnded;
    },
    send(event, data) {
      if (!this.open) return;
      res.write(encodeSse(event, data));
    },
    close() {
      if (!open) return;
      markClosed();
      if (!res.writableEnded) res.end();
    },
  };
}
