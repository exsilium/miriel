/**
 * Minimal server-sent events writer over Fastify's raw response.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface SseWriter {
  /** False once the client has gone away. */
  readonly open: boolean;
  send(event: string, data: unknown): void;
  close(): void;
}

export function encodeSse(event: string, data: unknown): string {
  // JSON never contains raw newlines, so one data: line is enough.
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

export function openSse(res: ServerResponse, req: IncomingMessage, heartbeatMs = 15_000): SseWriter {
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
  const onClose = (): void => {
    open = false;
    clearInterval(heartbeat);
  };
  req.on("close", onClose);
  res.on("close", onClose);

  return {
    get open() {
      return open;
    },
    send(event, data) {
      if (open) res.write(encodeSse(event, data));
    },
    close() {
      if (!open) return;
      onClose();
      res.end();
    },
  };
}
