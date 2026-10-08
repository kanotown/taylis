"""BlobStore: the only way the app touches object storage (ARCHITECTURE.md §8)."""

import logging
from collections.abc import AsyncIterator
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

    def stream(self, key: str) -> AsyncIterator[bytes]: ...

    async def exists(self, key: str) -> bool: ...

    async def delete(self, key: str) -> None: ...

    async def copy(self, source: str, target: str) -> None:
        """M145 (WIKI.md §22.3): a copy of an object inside the store (S3 CopyObject), for a
        duplicated page's files."""
        ...


class MemoryBlobStore:
    """Tests and development without an object store."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def ensure_bucket(self) -> None:
        return None

    async def put(self, key: str, data: bytes | IO[bytes], content_type: str) -> None:
        self.objects[key] = (data if isinstance(data, bytes) else data.read(), content_type)

    async def stream(self, key: str) -> AsyncIterator[bytes]:
        data, _ = self.objects[key]
        for start in range(0, len(data), CHUNK):
            yield data[start : start + CHUNK]

    async def exists(self, key: str) -> bool:
        return key in self.objects

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def copy(self, source: str, target: str) -> None:
        self.objects[target] = self.objects[source]


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
    ) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.client: Any = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
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

    async def stream(self, key: str) -> AsyncIterator[bytes]:
        response = await run_in_threadpool(
            lambda: self.client.get_object(Bucket=self.bucket, Key=key)
        )
        body = response["Body"]
        try:
            async for chunk in iterate_in_threadpool(body.iter_chunks(CHUNK)):
                yield chunk
        finally:
            body.close()

    async def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        def work() -> bool:
            try:
                self.client.head_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    return False
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


def build_blobstore(settings: Any) -> BlobStore:
    if settings.s3_endpoint:
        return S3BlobStore(
            endpoint=settings.s3_endpoint,
            bucket=settings.s3_bucket,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            region=settings.s3_region,
        )
    log.warning("S3_ENDPOINT is not set: attachments are kept in memory (development only)")
    return MemoryBlobStore()
