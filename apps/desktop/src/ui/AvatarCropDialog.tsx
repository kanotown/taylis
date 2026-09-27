import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AVATAR_OUTPUT, clampCrop, type Crop, cropScale, MAX_ZOOM, type Size, sourceRect, zoomAt } from "./avatarCrop";
import { Button, Modal } from "./primitives";

/** The crop square on screen (CSS px); the stage around it shows the rest of the picture, dimmed. */
const FRAME = 240;

/**
 * Choose the square of a picked photo for the profile picture (M16g): drag to move; pinch, the wheel or the slider
 * to zoom. Hands back a 512 px JPEG, small whatever the photo was (a phone photo is several MB).
 */
export function AvatarCropDialog({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (picture: Blob) => void }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const last = useRef<{ x: number; y: number; distance: number } | null>(null);

  useEffect(() => {
    // `live`: a load that ends after the cleanup (another file, or React's dev double effect revoking its URL)
    // must not report into this dialog.
    let live = true;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (live) setImage(img);
    };
    img.onerror = () => {
      if (live) setFailed(true);
    };
    img.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Browsers orient <img> and drawImage by the photo's EXIF, and so do these sizes.
  const size: Size | null = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;

  /** A pointer's position relative to the frame's centre (the stage's centre). */
  const relative = (event: { clientX: number; clientY: number }) => {
    const box = stage.current!.getBoundingClientRect();
    return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
  };
  /** Midpoint of the pointers down, and the distance between the first two. */
  const measure = () => {
    const points = [...pointers.current.values()];
    if (points.length === 0) return null;
    const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const distance = points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0;
    return { x, y, distance };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!size) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, relative(event));
    last.current = measure();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!size || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, relative(event));
    const before = last.current;
    const now = measure();
    last.current = now;
    if (!before || !now) return;
    setCrop((current) => {
      // Two fingers zoom by their spread around their midpoint; one or two move with the midpoint.
      const zoomed = before.distance > 0 && now.distance > 0 ? zoomAt(current, current.zoom * (now.distance / before.distance), before, size, FRAME) : current;
      return clampCrop({ ...zoomed, x: zoomed.x + now.x - before.x, y: zoomed.y + now.y - before.y }, size, FRAME);
    });
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    last.current = measure();
  };

  // The wheel zooms around the cursor; a non-passive listener keeps it from scrolling the dialog.
  useEffect(() => {
    const el = stage.current;
    if (!el || !size) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = relative(event);
      setCrop((current) => zoomAt(current, current.zoom * Math.exp(-event.deltaY * 0.0015), point, size, FRAME));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

  const save = () => {
    if (!image || !size) return;
    setBusy(true);
    const rect = sourceRect(crop, size, FRAME);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_OUTPUT;
    canvas.height = AVATAR_OUTPUT;
    const context = canvas.getContext("2d");
    if (!context) {
      setBusy(false);
      setFailed(true);
      return;
    }
    // JPEG has no transparency: a transparent logo gets a white background.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_OUTPUT, AVATAR_OUTPUT);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, rect.x, rect.y, rect.side, rect.side, 0, 0, AVATAR_OUTPUT, AVATAR_OUTPUT);
    canvas.toBlob((blob) => {
      setBusy(false);
      if (blob) onDone(blob);
      else setFailed(true);
    }, "image/jpeg", 0.9);
  };

  const scale = size ? cropScale(size, FRAME, crop.zoom) : 1;
  return (
    <Modal onClose={onCancel} title="写真の範囲を選ぶ" description="ドラッグで動かし、ピンチやスライダーで拡大できます" className="w-[420px]">
      {failed ? (
        <p className="mt-4 text-sm text-danger">この画像は読み込めませんでした。PNG・JPEG・GIF・WebP の写真を選んでください。</p>
      ) : (
        <>
          <div
            ref={stage}
            className="relative mt-4 h-[300px] w-full cursor-grab touch-none select-none overflow-hidden rounded-xl bg-black active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            {image && size && (
              <img
                src={image.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
                style={{ width: size.width * scale, height: size.height * scale, transform: `translate(calc(-50% + ${crop.x}px), calc(-50% + ${crop.y}px))` }}
              />
            )}
            {/* The avatar's rounded square; everything outside it is dimmed. */}
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[22%] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] ring-2 ring-white/90"
              style={{ width: FRAME, height: FRAME }}
            />
            {!image && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">読み込み中…</div>}
          </div>
          <div className="mt-4 flex items-center gap-3 text-muted">
            <Minus size={16} />
            <input
              type="range"
              aria-label="拡大"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={crop.zoom}
              disabled={!size}
              onChange={(e) => size && setCrop((current) => zoomAt(current, Number(e.target.value), { x: 0, y: 0 }, size, FRAME))}
              className="flex-1 accent-accent"
            />
            <Plus size={16} />
          </div>
        </>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>キャンセル</Button>
        <Button disabled={!image || failed || busy} onClick={save}>設定する</Button>
      </div>
    </Modal>
  );
}
