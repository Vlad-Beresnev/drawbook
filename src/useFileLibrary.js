import { useEffect, useMemo, useRef } from "react";
import { serializeLibraryAsJSON, useHandleLibrary } from "@excalidraw/excalidraw";
import { api } from "./api";

// Keeps Excalidraw's shape library in ~/Drawings/library.excalidrawlib.
//
// useHandleLibrary installs libraries from "Add to Excalidraw" links
// (#addLibrary=..., excalidraw.com URLs only) and saves changes through the
// adapter. Before each save it calls load() and applies only this window's
// added/removed items, so two windows never delete each other's items.
//
// It does not show items that another window added (for example the Chrome tab
// that libraries.excalidraw.com returns to). So when this window becomes active
// again, we re-read the file and replace the library if the file changed.
export function useFileLibrary(excalidrawAPI) {
  const lastKnownText = useRef(null);

  const adapter = useMemo(
    () => ({
      async load() {
        const text = await api.readLibrary();
        lastKnownText.current = text;
        return { libraryItems: JSON.parse(text).libraryItems };
      },
      async save({ libraryItems }) {
        const text = serializeLibraryAsJSON(libraryItems);
        await api.saveLibrary(text);
        lastKnownText.current = text;
      },
    }),
    [],
  );

  useHandleLibrary({ excalidrawAPI, adapter });

  useEffect(() => {
    if (!excalidrawAPI) return;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const text = await api.readLibrary();
        if (text === lastKnownText.current) return;
        lastKnownText.current = text;
        await excalidrawAPI.updateLibrary({ libraryItems: JSON.parse(text).libraryItems, merge: false });
      } catch (err) {
        console.error("Could not reload the library:", err);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [excalidrawAPI]);
}
