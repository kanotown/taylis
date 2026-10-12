/**
 * Files dropped where nothing takes them (outside the conversation, the thread pane and the canvas) would make the
 * webview open the file in place of the app. The app's window leaves drag and drop to the page (`dragDropEnabled: false`
 * in tauri.conf.json, which HTML5 drag and drop needs on Windows), so the page turns such drops away itself; a browser
 * tab gets the same. Registered on the window, it runs after the drop zones (ui/FileDropZone.tsx), which cancel the
 * events they handle.
 */
export function guardFileDrops(target: Pick<Window, "addEventListener"> = window): void {
  watchInternalDrags(target);
  target.addEventListener("dragover", (event) => {
    if (event.defaultPrevented || !isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
  target.addEventListener("drop", (event) => {
    if (event.defaultPrevented || !isFileDrag(event)) return;
    event.preventDefault();
  });
}

/**
 * A drag that started in this page (a picture, a link, selected text, a row being reordered). Chromium and WebKit can
 * list "Files" for a picture dragged out of the page too, so "Files" alone does not tell a file from the desktop.
 */
let internalDrag = false;
const watched = new WeakSet<object>();

/** Follows drags that start in this page (dragstart fires only for those). Idempotent per target. */
export function watchInternalDrags(target: Pick<Window, "addEventListener"> = window): void {
  if (watched.has(target)) return;
  watched.add(target);
  target.addEventListener("dragstart", () => { internalDrag = true; }, true);
  const end = () => { internalDrag = false; };
  target.addEventListener("dragend", end, true);
  target.addEventListener("drop", end);
}

export function isInternalDrag(): boolean {
  return internalDrag;
}

/** The drag carries files from outside the page (the desktop, Finder, Explorer, another app). */
export function isFileDrag(event: Pick<DragEvent, "dataTransfer">): boolean {
  if (internalDrag || !event.dataTransfer) return false;
  return [...(event.dataTransfer.types ?? [])].includes("Files");
}
