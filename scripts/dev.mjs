#!/usr/bin/env node
/**
 * `npm run dev`: api (tsx watch) and web (vite) with hot reload against the
 * compose database. Zero dependencies; prefixes each line with its source.
 */
import { spawn } from "node:child_process";

const procs = [
  { name: "api", cmd: "npm", args: ["run", "dev", "-w", "@miriel/api"] },
  { name: "web", cmd: "npm", args: ["run", "dev", "-w", "@miriel/web"] },
];

const children = procs.map(({ name, cmd, args }) => {
  const child = spawn(cmd, args, { shell: process.platform === "win32", env: process.env });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) out.write("[" + name + "] " + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write("[" + name + "] exited with " + code + "\n");
    stopAll();
    process.exitCode = code ?? 1;
  });
  return child;
});

function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill();
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});
