import os
import re
import sys
import json
import time
import uuid
import wave
import shutil
import socket
import struct
import hashlib
import urllib.parse
import urllib.request
import threading
import subprocess
from io import BytesIO
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, send_file, Response
import numpy as np
import qrcode
from yt_dlp import YoutubeDL

# Base directories
BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "ddj_flx4_web"
MEDIA_DIR = BASE_DIR / "ddj_flx4_media"
TRACKS_DIR = MEDIA_DIR / "tracks"
YT_DIR = MEDIA_DIR / "youtube"
TRANSCODE_DIR = MEDIA_DIR / "transcoded"
DB_PATH = MEDIA_DIR / "library.json"

for d in (WEB_DIR, MEDIA_DIR, TRACKS_DIR, YT_DIR, TRANSCODE_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# Global state for jobs and Cloudflare tunnel
EXTRACTION_JOBS = {}
JOBS_LOCK = threading.Lock()
LIBRARY_LOCK = threading.Lock()
TUNNEL_STATE = {
    "running": False,
    "url": None,
    "proc": None,
    "error": None,
}
PORT = int(os.environ.get("PORT", 8090))


def get_ffmpeg_path() -> str | None:
    """システムまたは imageio-ffmpeg から ffmpeg 実行ファイルのパスを取得する"""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    sys_ffmpeg = shutil.which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg
    return None


def get_local_ip() -> str:
    """LAN内のローカルIPアドレスを取得する"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def make_qr_base64(url: str) -> str:
    """URLからBase64エンコードされたPNG QRコードを生成する"""
    import base64
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def sanitize_filename(name: str) -> str:
    if not name:
        return "track"
    cleaned = re.sub(r'[\\/:*?"<>|#%&+\r\n\t]+', "_", name).strip()
    cleaned = cleaned.rstrip(". ")
    return cleaned[:120] if cleaned else "track"


def build_media_url(rel_path: str) -> str:
    """# や ? やスペースや絵文字を含むファイル名でも確実に取得できるようURLエンコードする"""
    parts = [urllib.parse.quote(p, safe="") for p in (rel_path or "").replace("\\", "/").split("/") if p]
    return "/media/" + "/".join(parts)


def clamp_natural_bpm(bpm: float) -> float:
    """原曲本来のテンポ(68〜176 BPM)を無理に128BPMへ歪めずそのまま保持する"""
    b = float(bpm or 120.0)
    if b <= 0:
        return 120.0
    while b < 68.0:
        b *= 2.0
    while b > 176.0:
        b *= 0.5
    return round(b * 2.0) / 2.0


def load_library() -> list[dict]:
    with LIBRARY_LOCK:
        if not DB_PATH.exists():
            return []
        try:
            with open(DB_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Filter out tracks whose files were deleted & ensure URL-encoded media URLs
                valid = []
                for item in data:
                    rel_p = item.get("rel_path", "")
                    fpath = MEDIA_DIR / rel_p
                    if fpath.exists() and fpath.is_file():
                        item["bpm"] = clamp_natural_bpm(item.get("bpm", 120.0))
                        item["url"] = build_media_url(rel_p)
                        valid.append(item)
                return valid
        except Exception:
            return []


def save_library(items: list[dict]):
    with LIBRARY_LOCK:
        with open(DB_PATH, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)


def add_to_library(track_info: dict):
    items = load_library()
    items = [x for x in items if x.get("id") != track_info.get("id")]
    items.insert(0, track_info)
    save_library(items)


def analyze_audio_with_ffmpeg(file_path: Path) -> dict:
    """FFmpegとNumPyを使用して曲の長さ(duration)と推定BPMを計算する"""
    ffmpeg_exe = get_ffmpeg_path()
    result = {"duration": 0.0, "bpm": 128.0}
    if not ffmpeg_exe or not file_path.exists():
        return result

    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        # Probe duration
        proc = subprocess.run(
            [ffmpeg_exe, "-i", str(file_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            timeout=15,
        )
        stderr_text = proc.stderr.decode("utf-8", errors="ignore")
        match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_text)
        if match:
            h, m, s = int(match.group(1)), int(match.group(2)), float(match.group(3))
            result["duration"] = round(h * 3600 + m * 60 + s, 2)

        # Extract mono low-res PCM (e.g. 4000 Hz, up to 60s from 15s offset) for fast BPM estimation
        start_sec = 10 if result["duration"] > 45 else 0
        proc_pcm = subprocess.run(
            [
                ffmpeg_exe,
                "-ss", str(start_sec),
                "-t", "45",
                "-i", str(file_path),
                "-vn",
                "-ac", "1",
                "-ar", "4000",
                "-f", "s16le",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
            timeout=20,
        )
        raw = proc_pcm.stdout
        if len(raw) > 8000:
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
            # Compute onset envelope in ~10ms hop (40 samples @ 4000Hz -> 100Hz envelope rate)
            hop = 40
            n_frames = len(samples) // hop
            if n_frames > 200:
                frames = samples[: n_frames * hop].reshape(n_frames, hop)
                energy = np.sqrt(np.mean(frames ** 2, axis=1))
                onset = np.maximum(0, np.diff(energy))
                onset = onset - np.mean(onset)
                if np.std(onset) > 1e-5:
                    # Autocorrelation for BPM between 75 and 165 BPM
                    # At 100 Hz envelope rate: lag = 60 * 100 / BPM
                    ac = np.correlate(onset, onset, mode="full")[len(onset) - 1 :]
                    min_lag = int(60 * 100 / 165)  # ~36
                    max_lag = min(int(60 * 100 / 75), len(ac) - 1)  # ~80
                    if max_lag > min_lag:
                        window = ac[min_lag : max_lag + 1]
                        best_lag = min_lag + int(np.argmax(window))
                        bpm = 60.0 * 100.0 / best_lag
                        result["bpm"] = clamp_natural_bpm(bpm)
    except Exception:
        pass
    return result


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Range"
    response.headers["Access-Control-Expose-Headers"] = "Content-Range, Content-Length, Accept-Ranges"
    if not request.path.startswith("/media/") and not request.path.startswith("/api/music-app/stream/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.route("/")
def index():
    return send_file(str(WEB_DIR / "index.html"), conditional=False, etag=False, max_age=0)


@app.route("/api/library", methods=["GET"])
def api_get_library():
    items = load_library()
    return jsonify({"tracks": items})


@app.route("/api/library", methods=["DELETE"])
def api_clear_library():
    items = load_library()
    for target in items:
        fpath = MEDIA_DIR / target.get("rel_path", "")
        try:
            if fpath.exists():
                fpath.unlink()
        except Exception:
            pass
    save_library([])
    return jsonify({"ok": True})


@app.route("/api/library/<track_id>", methods=["DELETE"])
def api_delete_track(track_id):
    items = load_library()
    target = next((x for x in items if x.get("id") == track_id), None)
    if target:
        fpath = MEDIA_DIR / target.get("rel_path", "")
        try:
            if fpath.exists():
                fpath.unlink()
        except Exception:
            pass
    items = [x for x in items if x.get("id") != track_id]
    save_library(items)
    return jsonify({"ok": True})


@app.route("/api/upload", methods=["POST"])
def api_upload_file():
    if "file" not in request.files:
        return jsonify({"error": "ファイルが選択されていません"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "ファイル名が空です"}), 400

    orig_name = Path(f.filename).stem
    ext = Path(f.filename).suffix.lower() or ".mp3"
    track_id = "upl_" + uuid.uuid4().hex[:10]
    safe_stem = sanitize_filename(orig_name)
    out_filename = f"{safe_stem}_{track_id[:6]}{ext}"
    out_path = TRACKS_DIR / out_filename
    f.save(str(out_path))

    # If video file or uncommon audio container, convert to MP3 via ffmpeg for Web Audio compatibility
    ffmpeg_exe = get_ffmpeg_path()
    if ext not in (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac") and ffmpeg_exe:
        mp3_filename = f"{safe_stem}_{track_id[:6]}.mp3"
        mp3_path = TRACKS_DIR / mp3_filename
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        subprocess.run(
            [ffmpeg_exe, "-y", "-i", str(out_path), "-vn", "-acodec", "libmp3lame", "-q:a", "2", str(mp3_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        if mp3_path.exists():
            try:
                out_path.unlink()
            except Exception:
                pass
            out_path = mp3_path
            out_filename = mp3_filename

    meta = analyze_audio_with_ffmpeg(out_path)
    rel_path = f"tracks/{out_filename}"
    track_info = {
        "id": track_id,
        "title": orig_name,
        "artist": "Local Upload",
        "source": "upload",
        "bpm": meta["bpm"],
        "duration": meta["duration"],
        "rel_path": rel_path,
        "url": build_media_url(rel_path),
        "created_at": int(time.time()),
    }
    add_to_library(track_info)
    return jsonify({"ok": True, "track": track_info})


def maybe_slice_large_audio_for_web(src_path: Path, max_sec: int) -> Path:
    """ブラウザ(PC/iPhone)のWeb Audio decodeAudioData上限対策: 1時間〜3時間半等の超長尺音源(>16MB)を高速ストリームコピーで安全長に切り出す"""
    try:
        if max_sec <= 0 or not src_path.exists() or not src_path.is_file() or src_path.stat().st_size <= 16 * 1024 * 1024:
            return src_path
        ffmpeg_exe = get_ffmpeg_path()
        if not ffmpeg_exe:
            return src_path
        ext = src_path.suffix.lower() or ".mp3"
        key = hashlib.sha1(f"{src_path}:{src_path.stat().st_mtime_ns}:{max_sec}".encode("utf-8")).hexdigest()[:14]
        out_ext = ext if ext in (".mp3", ".m4a", ".aac", ".ogg") else ".mp3"
        sliced_path = TRANSCODE_DIR / f"web_{key}_{max_sec}s{out_ext}"
        if not sliced_path.exists():
            creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            if ext in (".mp3", ".m4a", ".aac", ".ogg"):
                cmd = [ffmpeg_exe, "-y", "-t", str(max_sec), "-i", str(src_path), "-vn", "-c", "copy", str(sliced_path)]
            else:
                cmd = [ffmpeg_exe, "-y", "-t", str(max_sec), "-i", str(src_path), "-vn", "-acodec", "libmp3lame", "-ab", "192k", "-ar", "44100", str(sliced_path)]
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags, timeout=25)
        if sliced_path.exists() and sliced_path.stat().st_size > 1024:
            return sliced_path
    except Exception:
        pass
    return src_path


@app.route("/media/<path:subpath>")
def serve_media(subpath):
    """Rangeリクエスト＆PC/iOS超長尺デコード保護対応のメディア配信エンドポイント"""
    full_path = (MEDIA_DIR / subpath).resolve()
    if not str(full_path).startswith(str(MEDIA_DIR.resolve())) or not full_path.exists() or not full_path.is_file():
        return jsonify({"error": "Not found"}), 404
    ua = request.headers.get("User-Agent") or ""
    is_ios_ua = any(tok in ua for tok in ("iPhone", "iPad", "iPod"))
    req_max_sec = request.args.get("max_sec", type=int) or 0
    effective_max_sec = req_max_sec if req_max_sec > 0 else (600 if is_ios_ua else 900)
    full_path = maybe_slice_large_audio_for_web(full_path, effective_max_sec)
    return send_file(str(full_path), conditional=True)


def normalize_youtube_url(raw_url: str) -> str:
    u = raw_url.strip()
    if "music.youtube.com/" in u:
        u = u.replace("music.youtube.com/", "www.youtube.com/")
    return u


def resolve_youtube_target(raw_input: str) -> str:
    """URL・ドメイン省略URL・11文字動画ID・検索キーワード('tm network'等)をすべて正しく判定する"""
    s = (raw_input or "").strip()
    if not s:
        return ""
    if s.startswith("ytsearch"):
        return s
    if s.startswith("http://") or s.startswith("https://"):
        return normalize_youtube_url(s)
    if s.startswith(("www.youtube.com/", "youtube.com/", "music.youtube.com/", "m.youtube.com/", "youtu.be/")):
        return normalize_youtube_url("https://" + s)
    # Valid 11-character YouTube video ID (no spaces, slashes, or non-ASCII chars)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return f"https://www.youtube.com/watch?v={s}"
    # Otherwise treat as a search keyword and extract the #1 matching track!
    return f"ytsearch1:{s}"


@app.route("/api/youtube/search", methods=["GET"])
def api_youtube_search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "検索キーワードを入力してください"}), 400

    # If query is already a URL, extract info directly
    is_url = query.startswith("http://") or query.startswith("https://")
    if is_url:
        query = normalize_youtube_url(query)
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist" if not is_url else False,
        "skip_download": True,
    }
    search_target = query if is_url else f"ytsearch10:{query}"
    results = []
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_target, download=False)
            entries = info.get("entries", [info]) if isinstance(info, dict) else []
            for entry in entries:
                if not entry:
                    continue
                vid = entry.get("id") or ""
                title = entry.get("title") or "Unknown Title"
                uploader = entry.get("uploader") or entry.get("channel") or "YouTube"
                duration = entry.get("duration") or 0
                webpage_url = entry.get("url") or entry.get("webpage_url") or (f"https://www.youtube.com/watch?v={vid}" if vid else "")
                if vid and not webpage_url.startswith("http"):
                    webpage_url = f"https://www.youtube.com/watch?v={vid}"
                thumbs = entry.get("thumbnails") or []
                thumb_url = entry.get("thumbnail") or (thumbs[-1].get("url") if thumbs else f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg")
                results.append({
                    "id": vid,
                    "title": title,
                    "artist": uploader,
                    "duration": duration,
                    "url": webpage_url,
                    "thumbnail": thumb_url,
                })
        return jsonify({"ok": True, "results": results})
    except Exception as e:
        return jsonify({"error": f"YouTube検索エラー: {str(e)}"}), 500


def parse_time_str(s: str) -> float | None:
    if not s or not str(s).strip():
        return None
    s = str(s).strip()
    parts = s.split(":")
    try:
        if len(parts) == 1:
            return max(0.0, float(parts[0]))
        elif len(parts) == 2:
            return max(0.0, int(parts[0]) * 60 + float(parts[1]))
        elif len(parts) == 3:
            return max(0.0, int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2]))
    except Exception:
        pass
    return None


def run_youtube_extraction_job(
    job_id: str,
    url: str,
    start_sec: float | None,
    end_sec: float | None,
    override_meta: dict | None = None,
):
    if not url.startswith("ytsearch"):
        url = normalize_youtube_url(url)
    ffmpeg_exe = get_ffmpeg_path()
    with JOBS_LOCK:
        EXTRACTION_JOBS[job_id]["status"] = "downloading"
        EXTRACTION_JOBS[job_id]["message"] = "高音質オーディオデータを取得中..."

    temp_id = uuid.uuid4().hex[:8]
    raw_template = str(YT_DIR / f"raw_{temp_id}.%(ext)s")

    def progress_hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            pct = int(downloaded * 100 / total) if total > 0 else 30
            with JOBS_LOCK:
                EXTRACTION_JOBS[job_id]["progress"] = min(75, max(5, int(pct * 0.75)))
                EXTRACTION_JOBS[job_id]["message"] = f"ダウンロード中... ({pct}%)"
        elif d.get("status") == "finished":
            with JOBS_LOCK:
                EXTRACTION_JOBS[job_id]["progress"] = 78
                EXTRACTION_JOBS[job_id]["message"] = "DJ用高音質オーディオに変換・原曲BPM解析中..."

    ydl_opts = {
        "format": "bestaudio[abr<=192]/bestaudio/best",
        "outtmpl": raw_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [progress_hook],
    }
    if ffmpeg_exe:
        ydl_opts["ffmpeg_location"] = ffmpeg_exe

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if "entries" in info and info["entries"]:
                info = info["entries"][0]
            downloaded_path = Path(ydl.prepare_filename(info))
            if not downloaded_path.exists():
                candidates = list(YT_DIR.glob(f"raw_{temp_id}.*"))
                if candidates:
                    downloaded_path = candidates[0]

        ov = override_meta or {}
        title = ov.get("title") or info.get("title") or "Audio Track"
        uploader = ov.get("artist") or info.get("uploader") or info.get("channel") or "Music"
        vid = info.get("id") or temp_id
        thumb = ov.get("thumbnail") or info.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        src_type = ov.get("source") or "youtube"

        safe_title = sanitize_filename(title)
        out_filename = f"{safe_title}_{temp_id}.mp3"
        out_path = YT_DIR / out_filename

        if ffmpeg_exe and downloaded_path.exists():
            cmd = [ffmpeg_exe, "-y"]
            if start_sec is not None and start_sec > 0:
                cmd += ["-ss", str(start_sec)]
            if end_sec is not None and end_sec > 0:
                if start_sec is not None and end_sec > start_sec:
                    cmd += ["-t", str(min(900.0, end_sec - start_sec))]
                elif start_sec is None:
                    cmd += ["-to", str(min(900.0, end_sec))]
            else:
                # Cap multi-hour BGM/live videos to 15 min (900s) so ffmpeg finishes in ~2s & Web Audio decodes cleanly!
                cmd += ["-t", "900"]
            cmd += [
                "-i", str(downloaded_path),
                "-vn",
                "-acodec", "libmp3lame",
                "-ab", "192k",
                "-ar", "44100",
                str(out_path),
            ]
            creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags, check=True)
            try:
                downloaded_path.unlink()
            except Exception:
                pass
        else:
            # Fallback if ffmpeg unavailable
            out_filename = downloaded_path.name
            out_path = downloaded_path

        meta = analyze_audio_with_ffmpeg(out_path)
        rel_path = f"youtube/{out_filename}"
        track_info = {
            "id": f"yt_{temp_id}",
            "title": title,
            "artist": uploader,
            "source": src_type,
            "youtube_id": vid,
            "thumbnail": thumb,
            "bpm": meta["bpm"],
            "duration": meta["duration"],
            "rel_path": rel_path,
            "url": build_media_url(rel_path),
            "created_at": int(time.time()),
        }
        add_to_library(track_info)

        with JOBS_LOCK:
            EXTRACTION_JOBS[job_id]["status"] = "completed"
            EXTRACTION_JOBS[job_id]["progress"] = 100
            EXTRACTION_JOBS[job_id]["message"] = "準備完了！"
            EXTRACTION_JOBS[job_id]["track"] = track_info
    except Exception as e:
        with JOBS_LOCK:
            EXTRACTION_JOBS[job_id]["status"] = "error"
            EXTRACTION_JOBS[job_id]["message"] = f"エラー: {str(e)}"


@app.route("/api/youtube/extract", methods=["POST"])
def api_youtube_extract():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    search_query = (data.get("search_query") or "").strip()
    if search_query and not url:
        url = f"ytsearch1:{search_query}"
    if not url:
        return jsonify({"error": "URLまたは検索クエリを指定してください"}), 400
    url = resolve_youtube_target(url)

    override_meta = None
    if data.get("title") or data.get("artist") or data.get("source"):
        override_meta = {
            "title": (data.get("title") or "").strip() or None,
            "artist": (data.get("artist") or "").strip() or None,
            "thumbnail": (data.get("thumbnail") or "").strip() or None,
            "source": (data.get("source") or "youtube").strip(),
        }

    start_sec = parse_time_str(data.get("start_time"))
    end_sec = parse_time_str(data.get("end_time"))

    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        EXTRACTION_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 5,
            "message": "キューに登録しました...",
            "track": None,
        }

    t = threading.Thread(
        target=run_youtube_extraction_job,
        args=(job_id, url, start_sec, end_sec, override_meta),
        daemon=True,
    )
    t.start()
    return jsonify({"ok": True, "job_id": job_id})


@app.route("/api/youtube/jobs/<job_id>", methods=["GET"])
def api_youtube_job_status(job_id):
    with JOBS_LOCK:
        job = EXTRACTION_JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        return jsonify(dict(job))


# ==================== iPhone MUSIC / iTUNES / APPLE MUSIC INTEGRATION ====================
MUSIC_LIB_LOCK = threading.Lock()
MUSIC_LIB_CACHE = {
    "scanned": False,
    "tracks": [],       # list of dicts
    "by_id": {},        # id -> dict (with full_path)
    "artists": [],      # [{"name": str, "count": int}]
}
SUPPORTED_MUSIC_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".aiff", ".aif", ".ogg"}


def _norm_match_key(s: str) -> str:
    return re.sub(r"[\s\-_・()（）\[\]【】'\".,!?:;/\\]+", "", (s or "").lower())


def ensure_music_library_index(force_refresh: bool = False):
    with MUSIC_LIB_LOCK:
        if MUSIC_LIB_CACHE["scanned"] and not force_refresh:
            return
        music_root = Path.home() / "Music"
        tracks = []
        by_id = {}
        artist_counts = {}

        if music_root.exists():
            # Prioritize iTunes Media/Music and Apple Music folders if present, plus all ~/Music
            for root_str, _, files in os.walk(str(music_root)):
                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in SUPPORTED_MUSIC_EXTS:
                        continue
                    full_path = os.path.join(root_str, fname)
                    rel_to_music = os.path.relpath(full_path, str(music_root))
                    parts = Path(rel_to_music).parts

                    # Parse Artist / Album from standard iTunes directory hierarchy:
                    # e.g. iTunes/iTunes Media/Music/<Artist>/<Album>/<01 Song.m4a>
                    album = parts[-2] if len(parts) >= 2 else ""
                    artist = parts[-3] if len(parts) >= 3 else (parts[-2] if len(parts) == 2 else "Music Library")
                    if artist.lower() in ("music", "itunes media", "itunes", "apple music", "unknown artist"):
                        artist = album if album and album.lower() not in ("music", "unknown album") else "Music Library"

                    stem = os.path.splitext(fname)[0]
                    clean_title = re.sub(r"^(?:\d+-\d+|\d{1,3})(?:\s*[-.]\s*|\s+)", "", stem).strip() or stem

                    tid = "mus_" + hashlib.sha1(full_path.encode("utf-8", errors="ignore")).hexdigest()[:12]
                    entry = {
                        "id": tid,
                        "title": clean_title,
                        "artist": artist,
                        "album": album,
                        "ext": ext,
                        "source": "iphone_music",
                        "url": f"/api/music-app/stream/{tid}",
                        "transcode_url": f"/api/music-app/stream/{tid}?transcode=mp3",
                        "full_path": full_path,
                        "search_blob": f"{clean_title} {artist} {album} {stem}".lower(),
                        "norm_title": _norm_match_key(clean_title),
                        "norm_artist": _norm_match_key(artist),
                    }
                    tracks.append(entry)
                    by_id[tid] = entry
                    artist_counts[artist] = artist_counts.get(artist, 0) + 1

        tracks.sort(key=lambda x: (x["artist"].lower(), x["album"].lower(), x["title"].lower()))
        artists_sorted = sorted(
            [{"name": k, "count": v} for k, v in artist_counts.items()],
            key=lambda a: (-a["count"], a["name"].lower()),
        )
        MUSIC_LIB_CACHE["tracks"] = tracks
        MUSIC_LIB_CACHE["by_id"] = by_id
        MUSIC_LIB_CACHE["artists"] = artists_sorted
        MUSIC_LIB_CACHE["scanned"] = True


def public_music_track_dict(entry: dict) -> dict:
    return {
        "id": entry["id"],
        "title": entry["title"],
        "artist": entry["artist"],
        "album": entry["album"],
        "source": "iphone_music",
        "url": entry["url"],
        "transcode_url": entry["transcode_url"],
    }


def find_matching_local_music_track(title: str, artist: str = "") -> dict | None:
    ensure_music_library_index(False)
    nt = _norm_match_key(title)
    na = _norm_match_key(artist)
    if not nt:
        return None
    best = None
    for entry in MUSIC_LIB_CACHE["tracks"]:
        et = entry["norm_title"]
        ea = entry["norm_artist"]
        if et == nt and (not na or na in ea or ea in na):
            return public_music_track_dict(entry)
        if best is None and (nt in et or et in nt) and na and (na in ea or ea in na):
            best = entry
    return public_music_track_dict(best) if best else None


@app.route("/api/music-app/local", methods=["GET"])
def api_music_app_local():
    refresh = request.args.get("refresh") == "1"
    ensure_music_library_index(refresh)
    q = (request.args.get("q") or "").strip().lower()
    artist_filter = (request.args.get("artist") or "").strip()
    offset = max(0, int(request.args.get("offset") or 0))
    limit = max(1, min(200, int(request.args.get("limit") or 80)))

    all_items = MUSIC_LIB_CACHE["tracks"]
    filtered = all_items
    if artist_filter:
        filtered = [t for t in filtered if t["artist"] == artist_filter]
    if q:
        terms = [tok for tok in q.split() if tok]
        filtered = [t for t in filtered if all(tok in t["search_blob"] for tok in terms)]

    sliced = [public_music_track_dict(t) for t in filtered[offset : offset + limit]]
    return jsonify({
        "ok": True,
        "total_library_count": len(all_items),
        "matched_count": len(filtered),
        "artists": MUSIC_LIB_CACHE["artists"][:300],
        "tracks": sliced,
    })


@app.route("/api/music-app/stream/<track_id>", methods=["GET"])
def api_music_app_stream(track_id: str):
    ensure_music_library_index(False)
    entry = MUSIC_LIB_CACHE["by_id"].get(track_id)
    if not entry:
        return jsonify({"error": "Track not found"}), 404
    fpath = Path(entry["full_path"])
    if not fpath.exists():
        return jsonify({"error": "Audio file missing"}), 404

    want_transcode = request.args.get("transcode") == "mp3" or entry["ext"] in (".aiff", ".aif")
    if want_transcode:
        ffmpeg_exe = get_ffmpeg_path()
        if ffmpeg_exe:
            cached_mp3 = TRANSCODE_DIR / f"{track_id}.mp3"
            if not cached_mp3.exists():
                creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                subprocess.run(
                    [ffmpeg_exe, "-y", "-i", str(fpath), "-vn", "-acodec", "libmp3lame", "-ab", "192k", "-ar", "44100", str(cached_mp3)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags,
                    timeout=30,
                )
            if cached_mp3.exists():
                return send_file(str(cached_mp3), mimetype="audio/mpeg", conditional=True)

    mime_map = {
        ".m4a": "audio/mp4",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
    }
    ua = request.headers.get("User-Agent") or ""
    is_ios_ua = any(tok in ua for tok in ("iPhone", "iPad", "iPod"))
    req_max_sec = request.args.get("max_sec", type=int) or 0
    effective_max_sec = req_max_sec if req_max_sec > 0 else (600 if is_ios_ua else 900)
    fpath = maybe_slice_large_audio_for_web(fpath, effective_max_sec)
    return send_file(str(fpath), mimetype=mime_map.get(fpath.suffix.lower(), "audio/mp4"), conditional=True)


@app.route("/api/music-app/apple-search", methods=["GET"])
def api_apple_music_search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "曲名やアーティスト名を入力してください"}), 400
    try:
        api_url = (
            "https://itunes.apple.com/search?"
            + urllib.parse.urlencode({
                "term": q,
                "country": "JP",
                "media": "music",
                "entity": "song",
                "limit": 18,
            })
        )
        req = urllib.request.Request(api_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))

        results = []
        for item in payload.get("results", []):
            title = item.get("trackName") or ""
            artist = item.get("artistName") or ""
            if not title:
                continue
            local_match = find_matching_local_music_track(title, artist)
            results.append({
                "apple_id": str(item.get("trackId") or ""),
                "title": title,
                "artist": artist,
                "album": item.get("collectionName") or "",
                "duration": round((item.get("trackTimeMillis") or 0) / 1000.0, 1),
                "thumbnail": (item.get("artworkUrl100") or "").replace("100x100bb", "300x300bb"),
                "preview_url": item.get("previewUrl") or "",
                "apple_url": item.get("trackViewUrl") or "",
                "local_track": local_match,
            })
        return jsonify({"ok": True, "results": results})
    except Exception as e:
        return jsonify({"error": f"Apple Music検索エラー: {str(e)}"}), 500


@app.route("/api/music-app/resolve-apple-url", methods=["POST"])
def api_resolve_apple_music_url():
    """iPhoneの『ミュージック』アプリの共有リンク(単曲/アルバム/プレイリスト)やショートカットからの曲リストを解決する"""
    data = request.get_json(silent=True) or {}
    raw_text = (data.get("text") or data.get("url") or "").strip()
    if not raw_text:
        return jsonify({"error": "Musicアプリの共有URLまたは曲名を入力してください"}), 400

    resolved_items = []

    # Case 1: Contains an Apple Music / iTunes URL (https://music.apple.com/...)
    url_match = re.search(r"https?://(?:music|itunes)\.apple\.com/[^\s\"<>]+", raw_text)
    if url_match:
        apple_url = url_match.group(0)
        parsed = urllib.parse.urlparse(apple_url)
        qs = urllib.parse.parse_qs(parsed.query)
        song_id = (qs.get("i") or [None])[0]

        # Extract trailing numeric ID if present (e.g. /album/.../1440857781 or /song/.../1440857781)
        path_id_match = re.search(r"/(\d{6,15})(?:$|\?)", parsed.path)
        lookup_id = song_id or (path_id_match.group(1) if path_id_match else None)

        if lookup_id:
            try:
                lk_url = f"https://itunes.apple.com/lookup?id={lookup_id}&entity=song&country=JP"
                req = urllib.request.Request(lk_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    lk_data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                for item in lk_data.get("results", []):
                    if item.get("wrapperType") == "track" and item.get("trackName"):
                        if song_id and str(item.get("trackId")) != str(song_id):
                            continue
                        t_name = item.get("trackName")
                        a_name = item.get("artistName") or ""
                        resolved_items.append({
                            "title": t_name,
                            "artist": a_name,
                            "thumbnail": (item.get("artworkUrl100") or "").replace("100x100bb", "300x300bb"),
                            "duration": round((item.get("trackTimeMillis") or 0) / 1000.0, 1),
                            "local_track": find_matching_local_music_track(t_name, a_name),
                        })
            except Exception:
                pass

        # Fallback / Playlist HTML scraping (e.g. https://music.apple.com/jp/playlist/...)
        if not resolved_items:
            try:
                req = urllib.request.Request(
                    apple_url,
                    headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    html_text = resp.read().decode("utf-8", errors="ignore")

                # Parse JSON-LD schema if present
                for ld_match in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html_text, re.S):
                    try:
                        ld_obj = json.loads(ld_match.group(1))
                        ld_list = ld_obj if isinstance(ld_obj, list) else [ld_obj]
                        for node in ld_list:
                            tracks_arr = node.get("track") or node.get("tracks") or []
                            if isinstance(tracks_arr, dict):
                                tracks_arr = [tracks_arr]
                            for tr in tracks_arr:
                                t_name = tr.get("name")
                                by_artist = tr.get("byArtist")
                                a_name = by_artist.get("name") if isinstance(by_artist, dict) else ""
                                if t_name:
                                    resolved_items.append({
                                        "title": t_name,
                                        "artist": a_name,
                                        "thumbnail": "",
                                        "duration": 0,
                                        "local_track": find_matching_local_music_track(t_name, a_name),
                                    })
                    except Exception:
                        pass

                # Fallback to og:title (e.g. "曲名 - アーティスト - Apple Music")
                if not resolved_items:
                    og_m = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html_text)
                    if og_m:
                        og_title = re.sub(r"\s*[-|]\s*Apple\s*Music.*$", "", og_m.group(1)).strip()
                        # Pattern: 「Artistの「Song」」 in Japanese Apple Music og:title
                        jp_m = re.match(r"^(.+?)の「(.+?)」", og_title)
                        if jp_m:
                            a_name, t_name = jp_m.group(1).strip(), jp_m.group(2).strip()
                        else:
                            t_name, a_name = og_title, ""
                        resolved_items.append({
                            "title": t_name,
                            "artist": a_name,
                            "thumbnail": "",
                            "duration": 0,
                            "local_track": find_matching_local_music_track(t_name, a_name),
                        })
            except Exception as e:
                return jsonify({"error": f"Apple Musicリンクの解析に失敗しました: {str(e)}"}), 500
    else:
        # Case 2: Plain song lines (e.g. sent from iPhone Shortcut "Select Music" -> "Title - Artist" per line)
        lines = [ln.strip() for ln in re.split(r"[\r\n;|]+", raw_text) if ln.strip()]
        for ln in lines[:40]:
            if " - " in ln:
                parts = ln.split(" - ", 1)
                t_name, a_name = parts[0].strip(), parts[1].strip()
            elif " / " in ln:
                parts = ln.split(" / ", 1)
                t_name, a_name = parts[0].strip(), parts[1].strip()
            else:
                t_name, a_name = ln, ""
            resolved_items.append({
                "title": t_name,
                "artist": a_name,
                "thumbnail": "",
                "duration": 0,
                "local_track": find_matching_local_music_track(t_name, a_name),
            })

    if not resolved_items:
        return jsonify({"error": "曲情報を取得できませんでした。別のURLまたは曲名でお試しください。"}), 404

    return jsonify({"ok": True, "tracks": resolved_items})


@app.route("/api/network-info", methods=["GET"])
def api_network_info():
    local_ip = get_local_ip()
    lan_url = f"http://{local_ip}:{PORT}"
    lan_qr = make_qr_base64(lan_url)
    tunnel_url = TUNNEL_STATE.get("url")
    tunnel_qr = make_qr_base64(tunnel_url) if tunnel_url else None
    return jsonify({
        "lan_url": lan_url,
        "lan_qr": lan_qr,
        "tunnel_running": TUNNEL_STATE["running"],
        "tunnel_url": tunnel_url,
        "tunnel_qr": tunnel_qr,
        "tunnel_error": TUNNEL_STATE["error"],
    })


@app.route("/api/tunnel/start", methods=["POST"])
def api_start_tunnel():
    if TUNNEL_STATE["running"] and TUNNEL_STATE["url"]:
        return jsonify({
            "ok": True,
            "tunnel_url": TUNNEL_STATE["url"],
            "tunnel_qr": make_qr_base64(TUNNEL_STATE["url"]),
        })

    cf_exe = BASE_DIR / "cloudflared.exe"
    if not cf_exe.exists():
        cf_which = shutil.which("cloudflared")
        if cf_which:
            cf_exe = Path(cf_which)
        else:
            TUNNEL_STATE["error"] = "cloudflared.exe が見つかりません。同じWi-Fi内のLAN URLをご利用ください。"
            return jsonify({"error": TUNNEL_STATE["error"]}), 404

    def tunnel_worker():
        cmd = [str(cf_exe), "tunnel", "--url", f"http://127.0.0.1:{PORT}"]
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
            TUNNEL_STATE["proc"] = proc
            TUNNEL_STATE["running"] = True
            TUNNEL_STATE["error"] = None
            url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
            for line in iter(proc.stdout.readline, ""):
                m = url_pattern.search(line)
                if m:
                    TUNNEL_STATE["url"] = m.group(0)
                    break
        except Exception as e:
            TUNNEL_STATE["error"] = str(e)
            TUNNEL_STATE["running"] = False

    threading.Thread(target=tunnel_worker, daemon=True).start()
    # Wait up to 8 seconds for URL
    for _ in range(32):
        if TUNNEL_STATE.get("url"):
            break
        time.sleep(0.25)

    if TUNNEL_STATE.get("url"):
        return jsonify({
            "ok": True,
            "tunnel_url": TUNNEL_STATE["url"],
            "tunnel_qr": make_qr_base64(TUNNEL_STATE["url"]),
        })
    return jsonify({
        "ok": True,
        "pending": True,
        "message": "Cloudflareトンネルを起動中です（数秒後に再取得してください）",
    })


def free_port_if_in_use(port: int):
    """既に同じポートで古いサーバープロセスが動いている場合は自動終了させて起動エラーを防ぐ"""
    if sys.platform != "win32":
        return
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"],
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        my_pid = os.getpid()
        for line in out.splitlines():
            if f":{port} " in line and "LISTENING" in line:
                parts = line.split()
                pid = int(parts[-1])
                if pid != my_pid and pid > 0:
                    subprocess.run(
                        ["taskkill", "/F", "/PID", str(pid)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    time.sleep(0.4)
    except Exception:
        pass


if __name__ == "__main__":
    free_port_if_in_use(PORT)
    local_ip = get_local_ip()
    print("=" * 65)
    print("  PIONEER DJ DDJ-FLX4 WEB DJ APPLICATION SERVER")
    print("=" * 65)
    print(f"  [PC Browser]          http://127.0.0.1:{PORT}")
    print(f"  [iPad / Smartphone]   http://{local_ip}:{PORT} (同じWi-Fi内)")
    print("=" * 65)
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
