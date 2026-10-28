// Copies Excalidraw's fonts into public/ so the app works offline instead of
// loading them from a CDN. index.html sets window.EXCALIDRAW_ASSET_PATH = "/".
import { cpSync, existsSync } from "node:fs";

const source = new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts/", import.meta.url);
const target = new URL("../public/fonts/", import.meta.url);

if (!existsSync(target)) {
  cpSync(source, target, { recursive: true });
  console.log("Copied Excalidraw fonts to public/fonts");
}
