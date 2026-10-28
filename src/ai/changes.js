// Canvas changes proposed by the AI. The AI never sends Excalidraw elements: it
// sends short orders, and this module checks every order against the scene
// before anything is touched. Pure functions, no Excalidraw import, so the
// rules are unit-tested in Node.
//
// Rules:
// - setText / setColor / delete may target only shapes that were selected
//   when the question was sent (plus the labels inside those shapes).
// - add creates new shapes; it touches no existing shape.
// - All or nothing: one bad order rejects the whole block.

export const CHANGES_FENCE = "drawbook-changes";
export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow"];
const MAX_ORDERS = 100;
const MAX_TEXT = 5_000;
const MAX_COORD = 1_000_000;
const HEX = /^#[0-9a-f]{6}$/i;
const BLOCK = new RegExp("```" + CHANGES_FENCE + "[ \\t]*\\n([\\s\\S]*?)\\n```[ \\t]*", "g");

// Splits an AI answer into the text shown to the user and the orders block.
// The last block wins; earlier ones are removed from the text too.
export function extractChanges(answer) {
  const blocks = [...answer.matchAll(BLOCK)];
  if (blocks.length === 0) return { text: answer, orders: null, error: null };
  const text = answer.replace(BLOCK, "").trim();
  try {
    const orders = JSON.parse(blocks.at(-1)[1]);
    if (!Array.isArray(orders)) return { text, orders: null, error: "The changes are not a list" };
    return { text, orders, error: null };
  } catch {
    return { text, orders: null, error: "The changes are not valid JSON" };
  }
}

const isNumber = (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;
const isText = (t) => typeof t === "string" && t.length <= MAX_TEXT;
const firstLine = (text) => text.split("\n")[0].slice(0, 40);

function labelOf(element, byId) {
  const bound = element.boundElements?.find((b) => b.type === "text");
  const label = bound && byId.get(bound.id);
  return label && !label.isDeleted ? label : null;
}

function nameOf(element, byId) {
  const text = element.type === "text" ? element.text : labelOf(element, byId)?.text;
  return text ? `${element.type} “${firstLine(text)}”` : element.type;
}

// Checks the orders against the current scene.
// Returns { ok: true, steps } or { ok: false, errors }. Steps carry resolved
// ids: setText on a box points at the box's label.
export function planChanges(orders, { elements, allowedIds }) {
  if (!Array.isArray(orders) || orders.length === 0) return { ok: false, errors: ["There are no changes"] };
  if (orders.length > MAX_ORDERS) return { ok: false, errors: [`At most ${MAX_ORDERS} changes at once`] };

  const errors = [];
  const steps = [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const allowed = new Set(allowedIds);
  const newIds = new Set();

  // A shape may be changed only if it was selected. A label counts as
  // selected when its box was.
  function existingTarget(id, index) {
    const element = typeof id === "string" ? byId.get(id) : null;
    if (!element || element.isDeleted) {
      errors.push(`Change ${index + 1}: shape ${JSON.stringify(id)} does not exist`);
      return null;
    }
    if (!allowed.has(id) && !(element.containerId && allowed.has(element.containerId))) {
      errors.push(`Change ${index + 1}: ${nameOf(element, byId)} was not selected`);
      return null;
    }
    return element;
  }

  orders.forEach((order, i) => {
    const fail = (why) => {
      errors.push(`Change ${i + 1}: ${why}`);
      return null;
    };
    switch (order?.op) {
      case "setText": {
        const element = existingTarget(order.id, i);
        if (!element) return;
        if (!isText(order.text)) return fail("the text is missing or too long");
        const target = element.type === "text" ? element : labelOf(element, byId);
        if (!target) return fail(`${nameOf(element, byId)} has no text`);
        return steps.push({ op: "setText", id: target.id, text: order.text, label: `Change the text of ${nameOf(element, byId)}` });
      }
      case "setColor": {
        const element = existingTarget(order.id, i);
        if (!element) return;
        const { stroke, background } = order;
        if (stroke === undefined && background === undefined) return fail("no colour given");
        if (stroke !== undefined && !HEX.test(stroke)) return fail(`${JSON.stringify(stroke)} is not a colour like #1e1e1e`);
        if (background !== undefined && background !== "transparent" && !HEX.test(background)) {
          return fail(`${JSON.stringify(background)} is not a colour like #a5d8ff`);
        }
        return steps.push({ op: "setColor", id: element.id, stroke, background, label: `Recolour ${nameOf(element, byId)}` });
      }
      case "delete": {
        const element = existingTarget(order.id, i);
        if (!element) return;
        // Deleting a box also deletes its label.
        const label = labelOf(element, byId);
        return steps.push({ op: "delete", ids: label ? [element.id, label.id] : [element.id], label: `Delete ${nameOf(element, byId)}` });
      }
      case "add": {
        const shape = checkNewShape(order.shape, newIds, fail);
        if (!shape) return;
        return steps.push({ op: "add", shape, label: `Add ${shape.text ? `${shape.type} “${firstLine(shape.text)}”` : shape.type}` });
      }
      default:
        fail(`unknown change ${JSON.stringify(order?.op)}`);
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, steps };
}

function checkNewShape(shape, newIds, fail) {
  if (!shape || !SHAPE_TYPES.includes(shape.type)) return fail(`a new shape must be one of ${SHAPE_TYPES.join(", ")}`);
  if (shape.text !== undefined && !isText(shape.text)) return fail("the text is too long");
  if (shape.type === "text" && !shape.text) return fail("a new text needs text");
  if (shape.stroke !== undefined && !HEX.test(shape.stroke)) return fail(`${JSON.stringify(shape.stroke)} is not a colour`);
  if (shape.background !== undefined && shape.background !== "transparent" && !HEX.test(shape.background)) {
    return fail(`${JSON.stringify(shape.background)} is not a colour`);
  }

  const clean = { type: shape.type };
  if (shape.id !== undefined) {
    if (typeof shape.id !== "string" || !/^[\w-]{1,40}$/.test(shape.id) || newIds.has(shape.id)) return fail("a new shape needs a short, unique id");
    newIds.add(shape.id);
    clean.id = shape.id;
  }
  for (const key of ["text", "stroke", "background"]) if (shape[key] !== undefined) clean[key] = shape[key];

  if (shape.type === "arrow" && (shape.from !== undefined || shape.to !== undefined)) {
    // In this version arrows connect only shapes added earlier in the same block.
    for (const end of [shape.from, shape.to]) {
      if (!newIds.has(end) || end === clean.id) return fail(`an arrow can connect only new shapes added before it (${JSON.stringify(end)})`);
    }
    return { ...clean, from: shape.from, to: shape.to };
  }

  if (!isNumber(shape.x) || !isNumber(shape.y)) return fail("a new shape needs numbers x and y");
  clean.x = shape.x;
  clean.y = shape.y;
  for (const key of ["width", "height"]) {
    if (shape[key] === undefined) continue;
    if (!isNumber(shape[key]) || (shape.type !== "arrow" && shape[key] <= 0)) return fail(`${key} must be a positive number`);
    clean[key] = shape[key];
  }
  return clean;
}
