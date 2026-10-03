/**
 * Files from an `<input type="file">`, read into memory before the input is cleared.
 *
 * In the macOS app (WKWebView) a File picked through an input could no longer be read once the input's value was
 * reset: the upload body broke off part way, the server answered 400 (multipart could not be parsed) and WebKit
 * reported a network error (「サーバーに接続できません」, the workspace icon on 2026-10-04). Profile pictures were
 * fine because the crop dialog turns them into a new Blob first. Call this synchronously in the change handler,
 * before `input.value = ""`: the reads start at once, and the copies stay readable after the reset.
 */
export function readPickedFiles(list: FileList | null | undefined): Promise<File[]> {
  const files = list ? Array.from(list) : [];
  return Promise.all(
    files.map(async (file) => {
      const bytes = await file.arrayBuffer();
      return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
    }),
  );
}
