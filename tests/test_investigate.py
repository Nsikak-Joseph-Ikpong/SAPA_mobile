import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node.js for the web investigator")
def test_variance_investigator():
    root = Path(__file__).resolve().parent.parent
    r = subprocess.run(["node", "tests/investigate.test.js"], cwd=root, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
