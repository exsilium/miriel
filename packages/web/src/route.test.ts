import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, readerPath, retakePagePath } from "./route.js";

test("parseRoute: reader, queue, batch, page", () => {
  assert.deepEqual(parseRoute("/", "?book=vol1&page=12"), { name: "reader" });
  assert.deepEqual(parseRoute("/retakes", ""), { name: "retakes" });
  assert.deepEqual(parseRoute("/retakes/", ""), { name: "retakes" });
  assert.deepEqual(parseRoute("/retakes/batch", "?book=vol2&batch=abc"), { name: "retake-batch", book: "vol2" });
  assert.deepEqual(parseRoute("/retakes/vol1/289", ""), { name: "retake-page", book: "vol1", page: 289 });
  assert.deepEqual(parseRoute("/retakes/vol1/x", ""), { name: "retakes" });
  assert.deepEqual(parseRoute("/something", ""), { name: "reader" });
  assert.deepEqual(parseRoute("/admin/users", ""), { name: "admin-users" });
  assert.deepEqual(parseRoute("/admin/users/", ""), { name: "admin-users" });
  assert.deepEqual(parseRoute("/admin", ""), { name: "reader" });
  assert.deepEqual(parseRoute("/checklist", "?list=dlc&book=vol3"), { name: "checklist", list: "dlc" });
  assert.deepEqual(parseRoute("/checklist/", ""), { name: "checklist", list: null });
});

test("paths round-trip", () => {
  assert.deepEqual(parseRoute(retakePagePath("vol1", 0), ""), { name: "retake-page", book: "vol1", page: 0 });
  assert.equal(readerPath("vol2", 7), "/?book=vol2&page=7");
});
