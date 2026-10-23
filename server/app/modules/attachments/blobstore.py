"""BlobStore: the only way the app touches object storage (ARCHITECTURE.md §8)."""

import hashlib
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import IO, Any, Protocol

from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

log = logging.getLogger("app.attachments")

CHUNK = 256 * 1024


class BlobStore(Protocol):
    async def ensure_bucket(self) -> None: ...

    async def put(self, key: str, data: bytes | IO[bytes], content_type: str) -> None:
        """Store an object from bytes or from a file positioned at its start (an upload spooled
        to a temporary file is handed over without being read into memory)."""
        ...

    def stream(
        self, key: str, start: int | None = None, end: int | None = None
    ) -> AsyncIterator[bytes]:
        """The object's bytes, or (M160, Range downloads) the bytes start..end, both inclusive
        (end None: to the end)."""
        ...

    async def exists(self, key: str) -> bool: ...

    async def head(self, key: str) -> int | None:
        """M160: the object's size, or None when there is no such object."""
        ...

    async def delete(self, key: str) -> None: ...

    async def copy(self, source: str, target: str) -> None:
        """M145 (WIKI.md §22.3): a copy of an object inside the store (S3 CopyObject), for a
        duplicated page's files."""
        ...

    # M160 (docs/DRIVE.md §6.5): S3 multipart uploads, for the drive's resumable uploads.
    async def create_multipart(self, key: str, content_type: str) -> str:
        """Starts one; returns its upload id."""
        ...

    async def upload_part(
        self, key: str, upload_id: str, number: int, data: IO[bytes], size: int
    ) -> str:
        """Stores (or replaces) part `number` from a file positioned at its start; returns its
        ETag."""
        ...

    async def complete_multipart(
        self, key: str, upload_id: str, parts: list[tuple[int, str]]
    ) -> None:
        """Joins the parts [(number, ETag)] into the object `key`."""
        ...

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        """Drops an upload and its parts; an unknown or finished upload is not an error."""
        ...

    async def list_parts(self, key: str, upload_id: str) -> dict[int, str] | None:
        """REVIEW-v0.1.70 #5: {part number: ETag} of what the store holds for an upload in
        progress (S3 ListParts); None when there is no such upload (finished or aborted)."""
        ...

    def list_multipart_uploads(self, prefix: str) -> AsyncIterator[tuple[str, str, datetime]]:
        """(key, upload id, initiated) of every upload in progress under `prefix`."""
        ...


class MemoryBlobStore:
    """Tests and development without an object store."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        # upload id -> (key, content type, initiated, {part number: (bytes, ETag)})
        self.uploads: dict[str, tuple[str, str, datetime, dict[int, tuple[bytes, str]]]] = {}

    async def ensure_bucket(self) -> None:
        return None

    async def put(self, key: str, data: bytes | IO[bytes], content_type: str) -> None:
        self.objects[key] = (data if isinstance(data, bytes) else data.read(), content_type)

    async def stream(
        self, key: str, start: int | None = None, end: int | None = None
    ) -> AsyncIterator[bytes]:
        data, _ = self.objects[key]
        if start is not None or end is not None:
            data = data[start or 0 : None if end is None else end + 1]
        for offset in range(0, len(data), CHUNK):
            yield data[offset : offset + CHUNK]

    async def exists(self, key: str) -> bool:
        return key in self.objects

    async def head(self, key: str) -> int | None:
        found = self.objects.get(key)
        return None if found is None else len(found[0])

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def copy(self, source: str, target: str) -> None:
        self.objects[target] = self.objects[source]

    async def create_multipart(self, key: str, content_type: str) -> str:
        upload_id = uuid.uuid4().hex
        self.uploads[upload_id] = (key, content_type, datetime.now(UTC), {})
        return upload_id

    async def upload_part(
        self, key: str, upload_id: str, number: int, data: IO[bytes], size: int
    ) -> str:
        found = self.uploads.get(upload_id)
        if found is None or found[0] != key:
            raise KeyError(f"no such upload {upload_id}")
        body = data.read(size)
        etag = hashlib.md5(body, usedforsecurity=False).hexdigest()
        found[3][number] = (body, etag)
        return etag

    async def complete_multipart(
        self, key: str, upload_id: str, parts: list[tuple[int, str]]
    ) -> None:
        found = self.uploads.get(upload_id)
        if found is None or found[0] != key:
            raise KeyError(f"no such upload {upload_id}")
        stored = found[3]
        chunks: list[bytes] = []
        for number, etag in parts:
            body, stored_etag = stored[number]
            if stored_etag != etag:
                raise ValueError(f"part {number} does not match its ETag")
            chunks.append(body)
        self.objects[key] = (b"".join(chunks), found[1])
        del self.uploads[upload_id]

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        self.uploads.pop(upload_id, None)

    async def list_parts(self, key: str, upload_id: str) -> dict[int, str] | None:
        found = self.uploads.get(upload_id)
        if found is None or found[0] != key:
            return None
        return {number: etag for number, (_, etag) in found[3].items()}

    async def list_multipart_uploads(self, prefix: str) -> AsyncIterator[tuple[str, str, datetime]]:
        for upload_id, (key, _, initiated, _) in list(self.uploads.items()):
            if key.startswith(prefix):
                yield key, upload_id, initiated


class S3BlobStore:
    """S3 API (versitygw in compose; any S3-compatible store) through boto3 in a thread pool."""

    def __init__(
        self,
        *,
        endpoint: str,
        bucket: str,
        access_key: str | None,
        secret_key: str | None,
        region: str,
        complete_timeout_seconds: float = 600.0,
    ) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        options: dict[str, Any] = {
            "endpoint_url": endpoint,
            "aws_access_key_id": access_key,
            "aws_secret_access_key": secret_key,
            "region_name": region,
        }
        self.client: Any = boto3.client(
            "s3",
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
            **options,
        )
        # M160 (docs/DRIVE.md §2, §6.5): joining the parts of a multipart upload copies the whole
        # object on versitygw's posix backend (measured with v1.8.0: 5 GiB in about 2 s on a fast
        # SSD, the disk use doubling meanwhile), far longer on a slow or busy disk: boto3's
        # default 60 s read timeout is not enough there. Only CompleteMultipartUpload uses this.
        self.complete_client: Any = boto3.client(
            "s3",
            config=Config(
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3},
                read_timeout=complete_timeout_seconds,
            ),
            **options,
        )

    async def ensure_bucket(self) -> None:
        def work() -> None:
            from botocore.exceptions import ClientError

            try:
                self.client.head_bucket(Bucket=self.bucket)
            except ClientError:
                self.client.create_bucket(Bucket=self.bucket)
                log.info("created bucket %s", self.bucket)

        await run_in_threadpool(work)

    async def put(self, key: str, data: bytes | IO[bytes], content_type: str) -> None:
        # boto3 reads a seekable file object as it sends it (and measures it by seeking).
        await run_in_threadpool(
            lambda: self.client.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
            )
        )

    async def stream(
        self, key: str, start: int | None = None, end: int | None = None
    ) -> AsyncIterator[bytes]:
        extra: dict[str, str] = {}
        if start is not None or end is not None:
            extra["Range"] = f"bytes={start or 0}-{'' if end is None else end}"
        response = await run_in_threadpool(
            lambda: self.client.get_object(Bucket=self.bucket, Key=key, **extra)
        )
        body = response["Body"]
        try:
            async for chunk in iterate_in_threadpool(body.iter_chunks(CHUNK)):
                yield chunk
        finally:
            body.close()

    async def exists(self, key: str) -> bool:
        return await self.head(key) is not None

    async def head(self, key: str) -> int | None:
        from botocore.exceptions import ClientError

        def work() -> int | None:
            try:
                return int(self.client.head_object(Bucket=self.bucket, Key=key)["ContentLength"])
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    return None
                raise

        return await run_in_threadpool(work)

    async def delete(self, key: str) -> None:
        await run_in_threadpool(lambda: self.client.delete_object(Bucket=self.bucket, Key=key))

    async def copy(self, source: str, target: str) -> None:
        # Server side: the bytes never come through the app (boto3's managed copy also splits an
        # object over 5 GB into parts; an upload is far smaller, it is still the safe call).
        await run_in_threadpool(
            lambda: self.client.copy({"Bucket": self.bucket, "Key": source}, self.bucket, target)
        )

    async def create_multipart(self, key: str, content_type: str) -> str:
        response = await run_in_threadpool(
            lambda: self.client.create_multipart_upload(
                Bucket=self.bucket, Key=key, ContentType=content_type
            )
        )
        return str(response["UploadId"])

    async def upload_part(
        self, key: str, upload_id: str, number: int, data: IO[bytes], size: int
    ) -> str:
        response = await run_in_threadpool(
            lambda: self.client.upload_part(
                Bucket=self.bucket,
                Key=key,
                UploadId=upload_id,
                PartNumber=number,
                Body=data,
                ContentLength=size,
            )
        )
        return str(response["ETag"])

    async def complete_multipart(
        self, key: str, upload_id: str, parts: list[tuple[int, str]]
    ) -> None:
        listed = [{"PartNumber": number, "ETag": etag} for number, etag in parts]
        await run_in_threadpool(
            lambda: self.complete_client.complete_multipart_upload(
                Bucket=self.bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={"Parts": listed},
            )
        )

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        from botocore.exceptions import ClientError

        def work() -> None:
            try:
                self.client.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") not in ("NoSuchUpload", "404"):
                    raise

        await run_in_threadpool(work)

    async def list_parts(self, key: str, upload_id: str) -> dict[int, str] | None:
        from botocore.exceptions import ClientError

        def work() -> dict[int, str] | None:
            parts: dict[int, str] = {}
            marker: dict[str, int] = {}
            while True:
                try:
                    page = self.client.list_parts(
                        Bucket=self.bucket, Key=key, UploadId=upload_id, **marker
                    )
                except ClientError as exc:
                    if exc.response.get("Error", {}).get("Code") in ("NoSuchUpload", "404"):
                        return None
                    raise
                for part in page.get("Parts", []):
                    parts[int(part["PartNumber"])] = str(part["ETag"])
                if not page.get("IsTruncated"):
                    return parts
                marker = {"PartNumberMarker": int(page["NextPartNumberMarker"])}

        return await run_in_threadpool(work)

    async def list_multipart_uploads(self, prefix: str) -> AsyncIterator[tuple[str, str, datetime]]:
        markers: dict[str, str] = {}
        while True:
            page = await run_in_threadpool(
                self.client.list_multipart_uploads, Bucket=self.bucket, Prefix=prefix, **markers
            )
            for upload in page.get("Uploads", []):
                yield str(upload["Key"]), str(upload["UploadId"]), upload["Initiated"]
            if not page.get("IsTruncated"):
                return
            markers = {
                "KeyMarker": page.get("NextKeyMarker", ""),
                "UploadIdMarker": page.get("NextUploadIdMarker", ""),
            }


def build_blobstore(settings: Any) -> BlobStore:
    if settings.s3_endpoint:
        return S3BlobStore(
            endpoint=settings.s3_endpoint,
            bucket=settings.s3_bucket,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            region=settings.s3_region,
            complete_timeout_seconds=settings.drive_complete_timeout_seconds,
        )
    log.warning("S3_ENDPOINT is not set: attachments are kept in memory (development only)")
    return MemoryBlobStore()
