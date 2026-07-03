import http.server
import threading
import urllib.error
import urllib.request

from flowstate_analyzer.cli import make_db_only_handler


def _start_server(handler):
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_serves_only_the_db_file_and_404s_everything_else(tmp_path):
    db_path = tmp_path / "vibes.db"
    content = b"sqlite-bytes-not-really-but-good-enough-12345"
    db_path.write_bytes(content)
    # Simulates the real /data layout: sibling file with sensitive session cookies.
    (tmp_path / "browser.json").write_bytes(b"top-secret-cookies")

    handler = make_db_only_handler(db_path)
    server, thread = _start_server(handler)
    try:
        host, port = server.server_address
        base = f"http://{host}:{port}"

        resp = urllib.request.urlopen(f"{base}/vibes.db")
        assert resp.status == 200
        assert resp.read() == content

        try:
            urllib.request.urlopen(f"{base}/browser.json")
            assert False, "expected HTTPError 404 for browser.json"
        except urllib.error.HTTPError as e:
            assert e.code == 404

        try:
            urllib.request.urlopen(f"{base}/")
            assert False, "expected HTTPError 404 for /"
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        server.shutdown()
        thread.join()
