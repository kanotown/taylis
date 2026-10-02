"""Video shape, length and poster frame (M79, SECURITY.md §4 「動画」).

ffprobe reads the size, rotation and duration; ffmpeg decodes one frame, which Pillow re-encodes
as the same kind of JPEG an image's thumbnail is (and so drops whatever metadata ffmpeg wrote).
Both run as subprocesses: argv only (no shell), no stdin, a timeout (killed past it), a bare
environment (no secrets of the app), the input restricted to the local file protocol and to the
container formats a phone or camera writes (a playlist or concat file cannot make them open other
files or URLs). Any failure means "no shape, no poster": the upload never fails because of it.
"""

import asyncio
import json
import logging
import math
import os
import shutil
import weakref
from dataclasses import dataclass
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.modules.attachments.images import make_thumbnail

log = logging.getLogger("app.attachments.videos")

# Demuxer names (ffmpeg -formats) of what `filetype` sniffs as video/*: MP4 / MOV / 3GP, Matroska /
# WebM, AVI, ASF (WMV), MPEG-PS / TS, FLV. Nothing that refers to other files (hls, concat, ...).
FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,mpeg,mpegts,flv"
INPUT_OPTIONS = ("-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST)
# Beyond these the probe's answer is treated as nonsense.
MAX_DIMENSION = 16_384
MAX_DURATION_MS = 2**31 - 1
# ffprobe's JSON is a few hundred bytes; the poster is scaled to the thumbnail size by ffmpeg.
MAX_PROBE_OUTPUT = 64 * 1024
MAX_POSTER_OUTPUT = 16 * 1024 * 1024
# The poster is the frame at 1 s (a clip often opens on a black or blurred frame), or the first
# frame of a clip shorter than 2 s (or when nothing came at 1 s).
POSTER_AT_SECONDS = 1.0
POSTER_MIN_DURATION_MS = 2000


def is_video(content_type: str) -> bool:
    return content_type.lower().startswith("video/")


@dataclass(frozen=True)
class VideoInfo:
    """Upright display size (rotation and pixel aspect applied), length, poster JPEG bytes."""

    width: int | None
    height: int | None
    duration_ms: int | None
    poster: bytes | None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _rotation(stream: dict[str, Any]) -> int:
    for item in stream.get("side_data_list") or []:
        if isinstance(item, dict) and (degrees := _number(item.get("rotation"))) is not None:
            return round(degrees)
    tags = stream.get("tags")
    if isinstance(tags, dict) and (degrees := _number(tags.get("rotate"))) is not None:
        return round(degrees)  # older muxers: the "rotate" tag instead of a display matrix
    return 0


def parse_probe(raw: bytes) -> tuple[int | None, int | None, int | None]:
    """(width, height, duration_ms) from `ffprobe -of json`, each None when absent or absurd."""
    try:
        data = json.loads(raw)
    except ValueError:
        return None, None, None
    if not isinstance(data, dict):
        return None, None, None
    streams = data.get("streams")
    stream = streams[0] if isinstance(streams, list) and streams else {}
    stream = stream if isinstance(stream, dict) else {}
    width, height = _number(stream.get("width")), _number(stream.get("height"))
    shape: tuple[int, int] | None = None
    if width and height and 0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION:
        w, h = float(width), float(height)
        sar = str(stream.get("sample_aspect_ratio") or "")
        num, _, den = sar.partition(":")
        sar_num, sar_den = _number(num), _number(den)
        if sar_num and sar_den and sar_num > 0 and sar_den > 0 and sar_num != sar_den:
            w = w * sar_num / sar_den  # anamorphic: stored pixels are not square
        if _rotation(stream) % 180 == 90:
            w, h = h, w
        shape = (max(1, min(MAX_DIMENSION, round(w))), max(1, min(MAX_DIMENSION, round(h))))
    fmt = data.get("format")
    seconds = _number(fmt.get("duration")) if isinstance(fmt, dict) else None
    if seconds is None:
        seconds = _number(stream.get("duration"))
    duration_ms = None
    if seconds is not None and seconds >= 0:
        duration_ms = min(MAX_DURATION_MS, round(seconds * 1000))
    return (shape[0] if shape else None), (shape[1] if shape else None), duration_ms


_semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)
_warned_missing = False


def _semaphore(limit: int) -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _semaphores.get(loop)
    if semaphore is None:
        semaphore = _semaphores[loop] = asyncio.Semaphore(max(1, limit))
    return semaphore


def tools(settings: Settings) -> tuple[str, str] | None:
    """(ffprobe, ffmpeg) paths, or None when probing is off or a tool is not installed."""
    global _warned_missing
    if not settings.video_probe_enabled:
        return None
    ffprobe, ffmpeg = shutil.which(settings.ffprobe_path), shutil.which(settings.ffmpeg_path)
    if ffprobe is None or ffmpeg is None:
        if not _warned_missing:
            log.warning("ffprobe / ffmpeg not found: videos get no shape or poster")
            _warned_missing = True
        return None
    return ffprobe, ffmpeg


async def _run(argv: list[str], seconds: float, max_output: int) -> bytes | None:
    """stdout of the command, or None (logged) when it fails, times out or says too much."""
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"},
        )
    except OSError as exc:
        log.warning("%s could not start: %s", argv[0], exc)
        return None
    try:
        out, err = await asyncio.wait_for(process.communicate(), seconds)
    except TimeoutError:
        log.warning("%s timed out after %ss", os.path.basename(argv[0]), seconds)
        return None
    finally:
        if process.returncode is None:  # timed out or cancelled: never leave it running
            process.kill()
            await process.wait()
    if process.returncode != 0:
        log.info(
            "%s failed (%s): %s",
            os.path.basename(argv[0]),
            process.returncode,
            err[-300:].decode(errors="replace").strip(),
        )
        return None
    if len(out) > max_output:
        log.warning("%s wrote %d bytes, more than expected", os.path.basename(argv[0]), len(out))
        return None
    return out


async def _probe(
    ffprobe: str, path: str, seconds: float
) -> tuple[int | None, int | None, int | None]:
    out = await _run(
        [
            ffprobe,
            "-v",
            "error",
            *INPUT_OPTIONS,
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio,duration:stream_side_data=rotation"
            ":stream_tags=rotate:format=duration",
            "-of",
            "json",
            f"file:{path}",
        ],
        seconds,
        MAX_PROBE_OUTPUT,
    )
    return parse_probe(out) if out is not None else (None, None, None)


async def _frame(ffmpeg: str, path: str, at: float, max_px: int, seconds: float) -> bytes | None:
    """One upright frame (ffmpeg applies the rotation) as PNG, no larger than max_px."""
    scale = (
        "scale=trunc(iw*sar):ih,setsar=1,"
        f"scale=w='min({max_px},iw)':h='min({max_px},ih)':force_original_aspect_ratio=decrease"
    )
    out = await _run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            *INPUT_OPTIONS,
            "-ss",
            f"{at:.3f}",
            "-i",
            f"file:{path}",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            scale,
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "pipe:1",
        ],
        seconds,
        MAX_POSTER_OUTPUT,
    )
    return out or None


async def probe_video(path: str, settings: Settings) -> VideoInfo | None:
    """The video at `path` (a local file), or None when the tools are off or missing (nothing
    was tried). A VideoInfo with Nones: tried, and the file did not say."""
    found = tools(settings)
    if found is None:
        return None
    ffprobe, ffmpeg = found
    timeout = settings.video_probe_timeout_seconds
    max_px = settings.attachment_thumbnail_px
    async with _semaphore(settings.video_probe_max_concurrent):
        width, height, duration_ms = await _probe(ffprobe, path, timeout)
        poster: bytes | None = None
        if width is not None:
            start = POSTER_AT_SECONDS
            if duration_ms is not None and duration_ms < POSTER_MIN_DURATION_MS:
                start = 0.0
            frame = await _frame(ffmpeg, path, start, max_px, timeout)
            if frame is None and start > 0:
                frame = await _frame(ffmpeg, path, 0.0, max_px, timeout)
            if frame is not None:
                try:
                    poster, _, _ = await run_in_threadpool(make_thumbnail, frame, max_px)
                except Exception as exc:  # not the PNG we asked for: no poster
                    log.info("poster frame unreadable: %s", exc)
    return VideoInfo(width=width, height=height, duration_ms=duration_ms, poster=poster)
