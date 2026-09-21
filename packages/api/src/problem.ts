/**
 * RFC 9457 problem details for every error response.
 */
import type { FastifyReply } from "fastify";

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = "HttpProblem";
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export function sendProblem(reply: FastifyReply, p: HttpProblem, instance?: string): FastifyReply {
  const body: ProblemDetails = { type: "about:blank", title: p.title, status: p.status, ...p.extra };
  if (p.detail) body.detail = p.detail;
  if (instance) body.instance = instance;
  return reply.status(p.status).type("application/problem+json").send(body);
}
