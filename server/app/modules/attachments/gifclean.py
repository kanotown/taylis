"""A GIF without its metadata, the same length as the original (REVIEW-v0.1.82 #4).

A share link that hands out no originals (docs/ALBUMS.md §7) shows an animated GIF (which has no
display-size WebP) as the GIF itself. A GIF holds no EXIF, but its comment, plain-text and
application extensions may carry anything (an XMP packet, a location, a note). `scrub` streams the
file block by block and keeps what draws the picture: the header and the screen descriptor, the
colour tables, every image (descriptor and LZW data), the graphic control extensions (frame delays,
transparency) and the NETSCAPE2.0 / ANIMEXTS1.0 application extension (the loop count). Every other
extension becomes a comment of the same length filled with zero bytes, in sub-blocks whose lengths
depend only on the extension's length (an XMP packet's "magic trailer" makes its bytes read as
sub-block lengths, so those are not kept either). Anything after the trailer is zeroed.

The output has exactly the input's length, so a Content-Length and a ZIP planned from the stored
size still hold. A file that does not parse as a GIF (wrong signature, an unknown block, cut short)
is zeroed from the first byte that does not fit: what was shown so far is the picture's own data,
never metadata. Pure Python, no decoding: the pixels are passed through as they are.
"""

from collections.abc import AsyncIterator

_FLUSH = 64 * 1024
_KEPT_APPLICATIONS = (b"NETSCAPE2.0", b"ANIMEXTS1.0")
_ZEROS = bytes(255)


class _Broken(Exception):
    """The file stops being a GIF here."""


class _Reader:
    def __init__(self, chunks: AsyncIterator[bytes]) -> None:
        self._chunks = chunks
        self._buffer = bytearray()
        self._done = False
        self.consumed = 0

    async def exact(self, size: int) -> bytes:
        while len(self._buffer) < size and not self._done:
            try:
                self._buffer += await anext(self._chunks)
            except StopAsyncIteration:
                self._done = True
        taken = bytes(self._buffer[:size])
        del self._buffer[:size]
        self.consumed += len(taken)
        if len(taken) < size:
            raise _Broken
        return taken

    async def rest(self) -> AsyncIterator[int]:
        """The lengths of what is left (its bytes are never looked at)."""
        if self._buffer:
            self.consumed += len(self._buffer)
            yield len(self._buffer)
            self._buffer.clear()
        if self._done:
            return
        async for chunk in self._chunks:
            self.consumed += len(chunk)
            yield len(chunk)


def _tail(pending: int) -> bytes:
    """`pending` bytes (0, or 2 to 257) as zero-filled sub-blocks."""
    if pending == 0:
        return b""
    if pending == 257:
        return bytes([127]) + bytes(127) + bytes([128]) + bytes(128)
    return bytes([pending - 1]) + bytes(pending - 1)


async def scrub(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """The GIF's bytes without its metadata (see the module's note), as chunks."""
    reader = _Reader(chunks)
    out = bytearray()
    emitted = 0

    def take() -> bytes:
        nonlocal emitted
        data = bytes(out)
        emitted += len(data)
        out.clear()
        return data

    async def copy_sub_blocks() -> AsyncIterator[bytes]:
        while True:
            size = (await reader.exact(1))[0]
            out.append(size)
            if size == 0:
                return
            out.extend(await reader.exact(size))
            if len(out) >= _FLUSH:
                yield take()

    async def blank_sub_blocks(pending: int) -> AsyncIterator[bytes]:
        """Reads the rest of an extension's sub-blocks; writes them (and `pending` bytes already
        read) as zeros, then the terminator."""
        while True:
            size = (await reader.exact(1))[0]
            if size == 0:
                break
            await reader.exact(size)
            pending += 1 + size
            while pending >= 258:
                out.append(255)
                out.extend(_ZEROS)
                pending -= 256
            if len(out) >= _FLUSH:
                yield take()
        out.extend(_tail(pending))
        out.append(0)

    try:
        head = await reader.exact(13)
        if head[:6] not in (b"GIF87a", b"GIF89a"):
            raise _Broken
        out.extend(head)
        if head[10] & 0x80:
            out.extend(await reader.exact(3 << ((head[10] & 0x07) + 1)))
        while True:
            if len(out) >= _FLUSH:
                yield take()
            introducer = (await reader.exact(1))[0]
            if introducer == 0x3B:  # the trailer
                out.append(introducer)
                break
            if introducer == 0x2C:  # an image
                descriptor = await reader.exact(9)
                out.append(introducer)
                out.extend(descriptor)
                if descriptor[8] & 0x80:
                    out.extend(await reader.exact(3 << ((descriptor[8] & 0x07) + 1)))
                out.extend(await reader.exact(1))  # the LZW minimum code size
                async for chunk in copy_sub_blocks():
                    yield chunk
                continue
            if introducer != 0x21:
                raise _Broken
            label = (await reader.exact(1))[0]
            if label == 0xF9:  # graphic control: the frame's delay and transparency
                out.extend((introducer, label))
                async for chunk in copy_sub_blocks():
                    yield chunk
                continue
            pending = 0
            if label == 0xFF:  # an application extension: its identifier first
                size = (await reader.exact(1))[0]
                identifier = await reader.exact(size) if size else b""
                if size == 11 and identifier in _KEPT_APPLICATIONS:
                    out.extend((introducer, label, size))
                    out.extend(identifier)
                    async for chunk in copy_sub_blocks():
                        yield chunk
                    continue
                if size == 0:  # nothing but the terminator
                    out.extend((introducer, 0xFE, 0))
                    continue
                pending = 1 + size
            # A comment, plain text, another application or an unknown extension: a blank comment.
            out.extend((introducer, 0xFE))
            async for chunk in blank_sub_blocks(pending):
                yield chunk
    except _Broken:
        pass
    if out:
        yield take()
    # Whatever was read but not written (a block cut short or not understood) and everything
    # after the trailer: zeros, so the length stays the original's.
    missing = reader.consumed - emitted
    async for size in reader.rest():
        missing += size
    while missing > 0:
        step = min(missing, _FLUSH)
        missing -= step
        emitted += step
        yield bytes(step)
