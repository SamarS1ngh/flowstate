from pathlib import Path

from flowstate_analyzer.fetch import ydl_opts


def test_ydl_opts():
    opts = ydl_opts(Path("/tmp/x"))
    assert opts["outtmpl"] == "/tmp/x/%(id)s.%(ext)s"
    assert "bestaudio" in opts["format"]
    assert opts["quiet"] is True
