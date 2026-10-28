import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChanges, planChanges } from "../src/ai/changes.js";

// A tiny scene: a box "Login" with its label, a free text list, and a box that
// was not selected.
const scene = [
  { id: "box", type: "rectangle", boundElements: [{ id: "label", type: "text" }] },
  { id: "label", type: "text", text: "Login", containerId: "box" },
  { id: "list", type: "text", text: "1. Upload\n2. Review" },
  { id: "other", type: "rectangle", boundElements: null },
  { id: "gone", type: "rectangle", isDeleted: true },
];
const plan = (orders, allowedIds = ["box", "list"]) => planChanges(orders, { elements: scene, allowedIds });

test("the orders block is cut out of the answer", () => {
  const answer = 'Marked all items as done.\n\n```drawbook-changes\n[{"op":"setText","id":"list","text":"1. Upload ✅"}]\n```\n';
  assert.deepEqual(extractChanges(answer), {
    text: "Marked all items as done.",
    orders: [{ op: "setText", id: "list", text: "1. Upload ✅" }],
    error: null,
  });
});

test("an answer without a block is plain text", () => {
  assert.deepEqual(extractChanges("Just an answer"), { text: "Just an answer", orders: null, error: null });
});

test("broken JSON is reported, not applied", () => {
  const { text, orders, error } = extractChanges("Done.\n```drawbook-changes\n[{oops}]\n```");
  assert.equal(text, "Done.");
  assert.equal(orders, null);
  assert.match(error, /not valid JSON/);
});

test("setText on a selected text shape changes that text", () => {
  const result = plan([{ op: "setText", id: "list", text: "1. Upload ✅\n2. Review ✅" }]);
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].id, "list");
});

test("setText on a selected box changes its label", () => {
  const result = plan([{ op: "setText", id: "box", text: "Auth" }]);
  assert.equal(result.ok, true);
  assert.deepEqual([result.steps[0].op, result.steps[0].id], ["setText", "label"]);
});

test("a shape that was not selected is never changed", () => {
  const result = plan([{ op: "delete", id: "other" }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /was not selected/);
});

test("an id that does not exist is refused", () => {
  for (const id of ["b9", "gone", 42]) {
    const result = plan([{ op: "setText", id, text: "x" }]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /does not exist/);
  }
});

test("all or nothing: one bad order rejects the whole block", () => {
  const result = plan([
    { op: "setText", id: "list", text: "ok" },
    { op: "delete", id: "other" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.steps, undefined);
});

test("deleting a box also deletes its label", () => {
  assert.deepEqual(plan([{ op: "delete", id: "box" }]).steps[0].ids, ["box", "label"]);
});

test("colours must be hex", () => {
  assert.equal(plan([{ op: "setColor", id: "box", background: "#a5d8ff" }]).ok, true);
  assert.equal(plan([{ op: "setColor", id: "box", background: "transparent" }]).ok, true);
  assert.equal(plan([{ op: "setColor", id: "box", stroke: "red" }]).ok, false);
  assert.equal(plan([{ op: "setColor", id: "box" }]).ok, false);
});

test("new shapes need no selection, only a valid shape", () => {
  const result = plan(
    [
      { op: "add", shape: { type: "rectangle", id: "n1", x: 0, y: 0, text: "Cache", extra: "dropped" } },
      { op: "add", shape: { type: "ellipse", id: "n2", x: 300, y: 0 } },
      { op: "add", shape: { type: "arrow", from: "n1", to: "n2" } },
    ],
    [],
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps[0].shape, { type: "rectangle", id: "n1", x: 0, y: 0, text: "Cache" });
});

test("an arrow may connect only new shapes added before it", () => {
  const toExisting = plan([{ op: "add", shape: { type: "arrow", from: "box", to: "list" } }]);
  assert.equal(toExisting.ok, false);
  assert.equal(plan([{ op: "add", shape: { type: "frame", x: 0, y: 0 } }]).ok, false);
  assert.equal(plan([{ op: "add", shape: { type: "rectangle", x: "0", y: 0 } }]).ok, false);
});

test("unknown orders and empty lists are refused", () => {
  assert.equal(plan([{ op: "moveEverything" }]).ok, false);
  assert.equal(plan([]).ok, false);
  assert.equal(planChanges("nope", { elements: scene, allowedIds: [] }).ok, false);
});
