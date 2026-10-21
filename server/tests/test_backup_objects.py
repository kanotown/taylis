"""The object step of infra/backup.sh (M164, docs/DRIVE.md §16.2), run on this machine through
``backup.sh --objects-step``: unchanged files are hard links that keep the previous SHA-256, only
new and changed ones are copied and hashed, and the result is what restore.sh checks."""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

BACKUP_SH = Path(__file__).resolve().parents[2] / "infra" / "backup.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


def step(data: Path, backup: Path, prev: Path | None = None, **env: str) -> str:
    args = ["bash", str(BACKUP_SH), "--objects-step", str(data), str(backup)]
    if prev is not None:
        args.append(str(prev))
    done = subprocess.run(
        args, capture_output=True, text=True, env={**os.environ, **env}, check=False
    )
    assert done.returncode == 0, done.stderr
    return done.stdout + done.stderr


def failing(data: Path, backup: Path, prev: Path, **env: str) -> str:
    args = ["bash", str(BACKUP_SH), "--objects-step", str(data), str(backup), str(prev)]
    done = subprocess.run(
        args, capture_output=True, text=True, env={**os.environ, **env}, check=False
    )
    assert done.returncode != 0
    return done.stderr


def put(root: Path, path: str, data: bytes) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def checksums(backup: Path) -> dict[str, str]:
    out = {}
    for line in (backup / "objects.sha256").read_text().splitlines():
        digest, path = line[:64], line[66:]
        out[path] = digest
    return out


def actual(backup: Path) -> dict[str, str]:
    root = backup / "objects"
    return {
        "./" + str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file()
    }


def dirs(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*") if p.is_dir()}


def inode(path: Path) -> int:
    return path.stat().st_ino


@pytest.fixture
def data(tmp_path: Path) -> Path:
    root = tmp_path / "data"
    put(root, "chikuwa/attachments/0001", b"a" * 1000)
    put(root, "chikuwa/attachments/0002.thumb.jpg", b"thumb")
    put(root, "chikuwa/attachments/0003", os.urandom(5000))
    put(root, "chikuwa/ドライブ/名前 に 空白.txt", b"space")
    (root / "chikuwa" / ".sgwtmp" / "multipart").mkdir(parents=True)
    (root / ".vgwlocks").mkdir()
    return root


def test_a_first_backup_copies_and_hashes_everything(data: Path, tmp_path: Path) -> None:
    first = tmp_path / "b1"
    out = step(data, first)
    assert "4 file(s), 0 linked to the previous backup, 4 copied" in out
    assert checksums(first) == actual(first)
    assert len(checksums(first)) == 4
    assert dirs(first / "objects") == dirs(data)  # empty folders too
    listed = (first / "objects.list").read_text().splitlines()
    assert len(listed) == 4 and all(len(line.split(" ", 3)) == 4 for line in listed)
    assert not (first / ".objects-work").exists()
    # What restore.sh runs: sha256sum -c from the objects folder.
    tool = ["sha256sum"] if shutil.which("sha256sum") else ["shasum", "-a", "256"]
    check = subprocess.run(
        [*tool, "-c", "../objects.sha256"], cwd=first / "objects", capture_output=True, check=False
    )
    assert check.returncode == 0, check.stdout


def test_an_unchanged_night_links_everything_and_reuses_the_checksums(
    data: Path, tmp_path: Path
) -> None:
    first, second = tmp_path / "b1", tmp_path / "b2"
    step(data, first)
    # A recorded checksum that is not the file's own: reused as it is, so nothing was read.
    lines = (first / "objects.sha256").read_text().splitlines()
    marked = ["f" * 64 + line[64:] if "0003" in line else line for line in lines]
    (first / "objects.sha256").write_text("\n".join(marked) + "\n")
    out = step(data, second, first)
    assert "4 file(s), 4 linked to the previous backup, 0 copied" in out
    assert checksums(second)["./chikuwa/attachments/0003"] == "f" * 64
    for path in actual(first):
        assert inode(second / "objects" / path) == inode(first / "objects" / path)
    assert dirs(second / "objects") == dirs(data)
    # BACKUP_VERIFY=1 reads everything again and finds the difference.
    message = failing(data, tmp_path / "b3", first, BACKUP_VERIFY="1")
    assert "1 linked file(s) differ" in message and "0003" in message


def test_new_changed_and_removed_files(data: Path, tmp_path: Path) -> None:
    first, second = tmp_path / "b1", tmp_path / "b2"
    step(data, first)
    # Replaced the way versitygw does (a new file renamed over), same size, same second.
    stat = (data / "chikuwa/attachments/0001").stat()
    put(data, "chikuwa/tmp-new", b"b" * 1000)
    os.utime(data / "chikuwa/tmp-new", ns=(stat.st_atime_ns, stat.st_mtime_ns))
    os.replace(data / "chikuwa/tmp-new", data / "chikuwa/attachments/0001")
    put(data, "chikuwa/attachments/0004", b"new")
    (data / "chikuwa/attachments/0002.thumb.jpg").unlink()
    shutil.rmtree(data / "chikuwa" / "ドライブ")
    out = step(data, second, first)
    assert "3 file(s), 1 linked to the previous backup, 2 copied" in out
    assert checksums(second) == actual(second)
    assert set(actual(second)) == {
        "./chikuwa/attachments/0001",
        "./chikuwa/attachments/0003",
        "./chikuwa/attachments/0004",
    }
    assert (second / "objects/chikuwa/attachments/0001").read_bytes() == b"b" * 1000
    assert (first / "objects/chikuwa/attachments/0001").read_bytes() == b"a" * 1000
    assert dirs(second / "objects") == dirs(data)  # ドライブ is gone


def test_a_backup_made_before_the_list_and_a_damaged_one(data: Path, tmp_path: Path) -> None:
    first, second, third = tmp_path / "b1", tmp_path / "b2", tmp_path / "b3"
    step(data, first)
    (first / "objects.list").unlink()  # as backups before M164 were
    out = step(data, second, first)
    assert "4 linked to the previous backup, 0 copied" in out
    assert (second / "objects.list").exists()
    # A file gone from the previous backup is copied again instead of linked.
    (second / "objects/chikuwa/attachments/0003").unlink()
    out = step(data, third, second)
    assert "file(s) missing from" in out and "3 linked to the previous backup, 1 copied" in out
    assert checksums(third) == actual(third)
    # Not a complete backup: everything is copied.
    incomplete = tmp_path / "incomplete"
    (incomplete / "objects").mkdir(parents=True)
    out = step(data, tmp_path / "b4", incomplete)
    assert "not a complete backup" in out and "0 linked" in out


def test_an_empty_store_and_a_used_target(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    out = step(empty, tmp_path / "b1")
    assert "0 file(s), 0 linked to the previous backup, 0 copied" in out
    assert (tmp_path / "b1" / "objects.sha256").read_text() == ""
    out = step(empty, tmp_path / "b2", tmp_path / "b1")
    assert "0 file(s)" in out
    put(tmp_path / "used" / "objects", "left-over", b"x")
    message = failing(empty, tmp_path / "used", tmp_path / "b2")
    assert "is not empty" in message
