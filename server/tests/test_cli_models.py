"""The CLI runs in a fresh process with only the modules a command imports. Every table's model
must be registered there, or SQLAlchemy cannot resolve foreign keys between modules
(probe-videos failed in production: attachments.canvas_id → canvases)."""

import subprocess
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]


def test_cli_registers_every_model() -> None:
    code = (
        "import sys\n"
        "from unittest import mock\n"
        "import app.cli as cli\n"
        "from sqlalchemy.orm import configure_mappers\n"
        "def fake(args):\n"
        "    import app.modules.attachments.video_backfill\n"
        "    import app.modules.importer.slack_import\n"
        "    import app.modules.importer.mattermost_import\n"
        "    configure_mappers()\n"
        "    from app.core.base import Base\n"
        "    for table in Base.metadata.sorted_tables:\n"
        "        for fk in table.foreign_keys:\n"
        "            fk.column\n"
        "    return 0\n"
        "with mock.patch.object(cli, 'cmd_verify_attachments', fake):\n"
        "    sys.exit(cli.main(['verify-attachments']))\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], cwd=SERVER, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
