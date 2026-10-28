import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith, restoreElements } from "@excalidraw/excalidraw";

const DEFAULT_SIZE = { rectangle: [180, 80], ellipse: [180, 90], diamond: [200, 110] };
const ARROW_GAP = 8;
const FONT_SIZE = 20;

// convertToExcalidrawElements binds an arrow to its shapes but does not route
// it: the points come only from the arrow's own x/y/width/height. So draw it
// from the edge of one shape to the facing edge of the other.
function arrowBetween(from, to) {
  const center = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const [fx, fy] = center(from);
  const [tx, ty] = center(to);
  const dx = tx - fx;
  const dy = ty - fy;
  let start;
  let end;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = Math.sign(dx) || 1;
    start = [fx + sign * (from.width / 2 + ARROW_GAP), fy];
    end = [tx - sign * (to.width / 2 + ARROW_GAP), ty];
  } else {
    const sign = Math.sign(dy) || 1;
    start = [fx, fy + sign * (from.height / 2 + ARROW_GAP)];
    end = [tx, ty - sign * (to.height / 2 + ARROW_GAP)];
  }
  const [width, height] = [end[0] - start[0], end[1] - start[1]];
  // Explicit points: a width of 0 (a straight vertical arrow) would otherwise
  // be replaced by Excalidraw's default width.
  return { x: start[0], y: start[1], width, height, points: [[0, 0], [width, height]] };
}

// A rough size for a new text, only used to aim arrows at it.
function textBox(shape) {
  const lines = shape.text.split("\n");
  return { x: shape.x, y: shape.y, width: Math.max(...lines.map((l) => l.length)) * FONT_SIZE * 0.55, height: lines.length * FONT_SIZE * 1.25 };
}

// New shapes from the AI -> Excalidraw "skeletons" (the documented input of
// convertToExcalidrawElements).
function toSkeletons(shapes) {
  const placed = new Map();
  return shapes.map((shape) => {
    const colors = {};
    if (shape.stroke) colors.strokeColor = shape.stroke;
    if (shape.background) Object.assign(colors, { backgroundColor: shape.background, fillStyle: "solid" });

    if (shape.type === "text") {
      const skeleton = { type: "text", id: shape.id, x: shape.x, y: shape.y, text: shape.text, ...colors };
      placed.set(shape.id, textBox(shape));
      return skeleton;
    }
    if (shape.type === "arrow") {
      const label = shape.text ? { label: { text: shape.text } } : {};
      if (shape.from) {
        const route = arrowBetween(placed.get(shape.from), placed.get(shape.to));
        return { type: "arrow", id: shape.id, ...route, start: { id: shape.from }, end: { id: shape.to }, ...label, ...colors };
      }
      return { type: "arrow", id: shape.id, x: shape.x, y: shape.y, width: shape.width ?? 200, height: shape.height ?? 0, ...label, ...colors };
    }
    const [width, height] = DEFAULT_SIZE[shape.type];
    const skeleton = { type: shape.type, id: shape.id, x: shape.x, y: shape.y, width: shape.width ?? width, height: shape.height ?? height, ...colors };
    if (shape.text) skeleton.label = { text: shape.text };
    placed.set(shape.id, skeleton);
    return skeleton;
  });
}

// Applies checked steps (from planChanges) as ONE undo step: Cmd+Z reverts
// the whole AI change at once.
export function applyChanges(api, steps) {
  const elements = api.getSceneElementsIncludingDeleted();
  const byId = new Map(elements.map((e) => [e.id, e]));
  const changed = new Map();
  const current = (id) => changed.get(id) ?? byId.get(id);
  const retexted = new Set();

  for (const step of steps) {
    if (step.op === "setText") {
      changed.set(step.id, newElementWith(current(step.id), { text: step.text, originalText: step.text }));
      retexted.add(step.id);
    } else if (step.op === "setColor") {
      const updates = {};
      if (step.stroke) updates.strokeColor = step.stroke;
      if (step.background) updates.backgroundColor = step.background;
      changed.set(step.id, newElementWith(current(step.id), updates));
    } else if (step.op === "delete") {
      for (const id of step.ids) changed.set(id, newElementWith(current(id), { isDeleted: true }));
    }
  }

  // New text has a new size, and a label wraps inside its box. Excalidraw
  // measures text when it restores elements, so restore just the text (and
  // its box) and keep the measured size.
  for (const id of retexted) {
    const text = changed.get(id);
    const container = text.containerId ? current(text.containerId) : null;
    const measured = restoreElements(container ? [text, container] : [text], null, { refreshDimensions: true, repairBindings: true }).find((e) => e.id === id);
    changed.set(id, { ...text, text: measured.text, width: measured.width, height: measured.height, x: measured.x, y: measured.y });
  }

  const shapes = steps.filter((s) => s.op === "add").map((s) => s.shape);
  const created = shapes.length > 0 ? convertToExcalidrawElements(toSkeletons(shapes)) : [];

  api.updateScene({
    elements: [...elements.map((e) => changed.get(e.id) ?? e), ...created],
    // Select what the AI added, so the user sees it and can move it at once.
    appState: created.length > 0 ? { selectedElementIds: Object.fromEntries(created.filter((e) => !e.containerId).map((e) => [e.id, true])) } : undefined,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  // New shapes may be outside the visible part of the canvas: show them.
  if (created.length > 0) api.scrollToContent(created, { animate: true });
}
