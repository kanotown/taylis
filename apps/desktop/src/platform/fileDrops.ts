/**
 * Files dropped where nothing takes them (outside the composer and the canvas) would make the webview open the file in
 * place of the app. The app's window leaves drag and drop to the page (`dragDropEnabled: false` in tauri.conf.json, which
 * HTML5 drag and drop needs on Windows), so the page turns such drops away itself; a browser tab gets the same.
 * Registered on the window, it runs after the drop zones, which cancel the events they handle.
 */
export function guardFileDrops(target: Pick<Window, "addEventListener"> = window): void {
  const hasFiles = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
  target.addEventListener("dragover", (event) => {
    if (event.defaultPrevented || !hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
  target.addEventListener("drop", (event) => {
    if (event.defaultPrevented || !hasFiles(event)) return;
    event.preventDefault();
  });
}
