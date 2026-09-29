import json
import os
import queue
import re
import tempfile
import threading
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKDIR = tempfile.mkdtemp(prefix="uvd-")
PORT = int(os.environ.get("PORT", "8321"))
HOST = os.environ.get("HOST", "0.0.0.0")

PUBLIC_DOMAINS = (
    "youtube.com",
    "youtu.be",
    "vimeo.com",
    "tiktok.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "facebook.com",
    "fb.watch",
    "fb.com",
    "dailymotion.com",
)

PLATFORM_LABELS = {
    "Youtube": "YouTube",
    "Vimeo": "Vimeo",
    "TikTok": "TikTok",
    "Instagram": "Instagram",
    "Twitter": "X / Twitter",
    "Facebook": "Facebook",
    "Dailymotion": "Dailymotion",
}

ALLOWED_STATICS = (".html", ".css", ".js", ".svg", ".png", ".ico", ".woff2", ".webmanifest")
QUALITIES = ("360", "480", "720", "1080", "1440", "2160")
FORMATS = ("mp4", "webm", "mp3")

sessions = {}
sessions_lock = threading.Lock()


def resolve_ffmpeg():
    from shutil import which
    found = which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    return None


FFMPEG = resolve_ffmpeg()


class Session:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.url = ""
        self.quality = "1080"
        self.format = "mp4"
        self.q = queue.Queue()
        self.path = None
        self.filename = None
        self.finished = False


def host_allowed(host):
    host = (host or "").lower().strip(".")
    return any(host == d or host.endswith("." + d) for d in PUBLIC_DOMAINS)


def normalize_url(raw):
    url = (raw or "").strip()
    if not url:
        raise ValueError("URL is required.")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    host = urllib.parse.urlparse(url).netloc.lower()
    if not host or not host_allowed(host):
        raise ValueError("Unsupported platform. Only public links from the listed platforms are supported.")
    return url


def friendly_error(message):
    text = re.sub(r"\x1b\[[0-9;]*m", "", str(message)).strip()
    lowered = text.lower()
    if "ffmpeg" in lowered and ("not installed" in lowered or "not found" in lowered):
        return "Server video tools are missing (ffmpeg). Merging is unavailable."
    if "requested format is not available" in lowered:
        return "No compatible format is available for this video."
    if "private" in lowered or "restricted" in lowered:
        return "This video is private or restricted. Only public videos are supported."
    if "login" in lowered or "cookies" in lowered:
        return "This video requires login. Login and session use is not supported."
    if "geo" in lowered or "region" in lowered:
        return "This video is not available in your region."
    if "unavailable" in lowered or "removed" in lowered:
        return "This video is unavailable. It may be private, removed, or region-locked."
    if "404" in lowered or "not found" in lowered:
        return "Video not found. Check the URL."
    return text[:300]


def format_spec(quality, fmt):
    if fmt == "mp3":
        return "bestaudio/best"
    h = quality
    if fmt == "webm":
        return (
            "bv*[height<=%s][ext=webm]+ba/b[height<=%s][ext=webm]/"
            "bv*[height<=%s]+ba/b[height<=%s]/bv*+ba/b" % (h, h, h, h)
        )
    return "bv*[height<=%s]+ba/b[height<=%s]/bv*+ba/b" % (h, h)


def analyze(url):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "retries": 2,
        "socket_timeout": 20,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        info = entries[0] if entries else {}
    formats = info.get("formats") or []
    heights = sorted({f["height"] for f in formats if f.get("height")}, reverse=True)
    extractor = info.get("extractor_key") or "Unknown"
    return {
        "title": info.get("title") or "Untitled video",
        "duration": int(info.get("duration") or 0),
        "platform": PLATFORM_LABELS.get(extractor, extractor),
        "heights": heights[:12],
    }


def run_job(sess):
    def hook(d):
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            percent = round(100.0 * done / total, 1) if total else 0.0
            sess.q.put(
                {
                    "type": "progress",
                    "percent": percent,
                    "done": done,
                    "total": total,
                    "speed": d.get("speed"),
                }
            )
        elif status == "finished":
            sess.q.put(
                {
                    "type": "progress",
                    "percent": 100.0,
                    "done": d.get("downloaded_bytes") or 0,
                    "total": d.get("total_bytes"),
                    "speed": None,
                }
            )

    outtmpl = os.path.join(WORKDIR, sess.id + ".%(ext)s")
    is_audio = sess.format == "mp3"
    opts = {
        "format": format_spec(sess.quality, sess.format),
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "retries": 3,
        "socket_timeout": 30,
        "postprocessors": (
            [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}]
            if is_audio
            else []
        ),
        "merge_output_format": None if is_audio else ("webm" if sess.format == "webm" else "mp4"),
    }
    if FFMPEG:
        opts["ffmpeg_location"] = FFMPEG
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(sess.url, download=True)
        ext = info.get("ext") or "mp4"
        path = outtmpl.replace("%(ext)s", ext)
        if not os.path.isfile(path):
            candidates = [
                f for f in os.listdir(WORKDIR) if f.startswith(sess.id + ".") and not f.endswith((".part", ".ytdl"))
            ]
            if not candidates:
                raise RuntimeError("Download did not produce a file.")
            path = os.path.join(WORKDIR, candidates[0])
            ext = os.path.splitext(path)[1].lstrip(".") or ext
        sess.path = path
        title = (info.get("title") or "video").replace(os.sep, "_")
        sess.filename = "%s.%s" % (title, ext)
        height = info.get("height")
        if not height:
            chosen = info.get("format_id")
            for f in info.get("formats") or []:
                if f.get("format_id") == chosen and f.get("height"):
                    height = f["height"]
                    break
        sess.finished = True
        sess.q.put({"type": "done", "filename": sess.filename, "height": height, "ext": ext})
    except Exception as exc:
        for f in os.listdir(WORKDIR):
            if f.startswith(sess.id + "."):
                try:
                    os.remove(os.path.join(WORKDIR, f))
                except OSError:
                    pass
        sess.finished = True
        sess.q.put({"type": "failed", "message": friendly_error(exc)})


class Handler(BaseHTTPRequestHandler):
    server_version = "UVD/0.1"

    def log_message(self, *args):
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/events":
            return self.handle_events(parsed)
        if path == "/api/file":
            return self.handle_file(parsed)
        return self.handle_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/analyze":
            return self.handle_analyze()
        if parsed.path == "/api/download":
            return self.handle_download()
        self._json(404, {"error": "Not found."})

    def handle_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.realpath(os.path.join(ROOT, rel))
        if not full.startswith(os.path.realpath(ROOT) + os.sep) and full != os.path.realpath(ROOT):
            self.send_error(403)
            return
        if not os.path.isfile(full) or not full.lower().endswith(ALLOWED_STATICS):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
        }.get(ext, "application/octet-stream")
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_analyze(self):
        data = self._read_json()
        try:
            url = normalize_url(data.get("url"))
            result = analyze(url)
            self._json(200, result)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:
            self._json(502, {"error": friendly_error(exc)})

    def handle_download(self):
        data = self._read_json()
        try:
            url = normalize_url(data.get("url"))
            quality = str(data.get("quality") or "1080")
            fmt = str(data.get("format") or "mp4")
            if quality not in QUALITIES:
                raise ValueError("Unsupported quality.")
            if fmt not in FORMATS:
                raise ValueError("Unsupported format.")
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        with sessions_lock:
            sess = Session()
            sess.url = url
            sess.quality = quality
            sess.format = fmt
            sessions[sess.id] = sess
        threading.Thread(target=run_job, args=(sess,), daemon=True).start()
        self._json(200, {"session": sess.id})

    def handle_events(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        sid = (qs.get("session") or [""])[0]
        with sessions_lock:
            sess = sessions.get(sid)
        if not sess:
            self._json(404, {"error": "Unknown session."})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"retry: 3000\n\n")
        self.wfile.flush()
        while True:
            try:
                event = sess.q.get(timeout=15)
            except queue.Empty:
                try:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                continue
            try:
                payload = "event: %s\ndata: %s\n\n" % (event["type"], json.dumps(event))
                self.wfile.write(payload.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            if event["type"] in ("done", "failed"):
                return

    def handle_file(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        sid = (qs.get("session") or [""])[0]
        with sessions_lock:
            sess = sessions.get(sid)
        if not sess or not sess.path or not os.path.isfile(sess.path):
            self._json(404, {"error": "File not ready."})
            return
        filename = sess.filename or "video"
        ascii_name = re.sub(r"[^ -~]", "_", filename).replace('"', "")
        size = os.path.getsize(sess.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header(
            "Content-Disposition",
            "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, urllib.parse.quote(filename, safe="")),
        )
        self.end_headers()
        try:
            with open(sess.path, "rb") as fh:
                while True:
                    chunk = fh.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                os.remove(sess.path)
            except OSError:
                pass
            with sessions_lock:
                sessions.pop(sid, None)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print("Universal Video Downloader backend")
    print("Frontend: http://%s:%d" % (HOST, PORT))
    print("Uses yt-dlp %s | workdir %s" % (yt_dlp.version.__version__, WORKDIR))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
