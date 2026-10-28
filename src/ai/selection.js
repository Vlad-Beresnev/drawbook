import { exportToBlob } from "@excalidraw/excalidraw";

const round = (n) => Math.round(n);

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// A short form of one shape: enough for the model to understand the diagram,
// without Excalidraw's ~25 internal fields (seed, version, roundness, ...).
function shortShape(element, labels) {
  const shape = {
    id: element.id,
    type: element.type,
    x: round(element.x),
    y: round(element.y),
    width: round(element.width),
    height: round(element.height),
  };
  const text = element.type === "text" ? element.text : labels.get(element.id);
  if (text) shape.text = text;
  if (element.startBinding?.elementId) shape.from = element.startBinding.elementId;
  if (element.endBinding?.elementId) shape.to = element.endBinding.elementId;
  if (element.type === "frame" && element.name) shape.text = element.name;
  return shape;
}

export function selectedElements(api) {
  const selectedIds = api.getAppState().selectedElementIds;
  return api.getSceneElements().filter((e) => selectedIds[e.id]);
}

// The selection as the AI Drawer sends it: short JSON for meaning, and a PNG
// for layout ("which box is left of which"). Returns null when nothing is selected.
export async function describeSelection(api) {
  const all = api.getSceneElements();
  const selected = selectedElements(api);
  if (selected.length === 0) return null;

  // A box's label is a separate text element bound to it. Include labels of
  // selected boxes even when only the box itself was selected.
  const selectedIds = new Set(selected.map((e) => e.id));
  const boundLabels = all.filter((e) => e.type === "text" && e.containerId && selectedIds.has(e.containerId) && !selectedIds.has(e.id));
  const elements = [...selected, ...boundLabels];
  const labels = new Map(elements.filter((e) => e.type === "text" && e.containerId).map((e) => [e.containerId, e.text]));

  const shapes = elements.filter((e) => !(e.type === "text" && e.containerId)).map((e) => shortShape(e, labels));

  const blob = await exportToBlob({
    elements,
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: 16,
    maxWidthOrHeight: 1600,
  });
  return { shapes, image: await blobToDataUrl(blob) };
}

export function readFileAsAttachment(file) {
  return blobToDataUrl(file).then((dataUrl) => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    type: file.type,
    size: file.size,
    dataUrl,
  }));
}
