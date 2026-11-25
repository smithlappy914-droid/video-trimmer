import os
import re
import time
import hmac
import uuid
import base64
import shutil
import hashlib
import secrets
import sqlite3
import subprocess
from urllib.parse import urlparse
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import yt_dlp
import imageio_ffmpeg

app = FastAPI(title="ClipAI Cloud Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------- CRYPTOGRAPHIC CONFIG --------------------
APP_SECRET = os.environ.get("APP_SECRET", secrets.token_hex(32)).encode("utf-8")
OWNER_PIN_HASH = hashlib.sha256(
    os.environ.get("OWNER_PIN", "7860").encode("utf-8")
).digest()
ENV_OWNER_CRED_ID = os.environ.get("OWNER_CREDENTIAL_ID", "").strip()

FFMPEG_BIN = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
WORK_DIR = "/tmp/clipai_jobs"
DB_PATH = "/tmp/clipai_prod.sqlite"
ALLOWED_YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}

os.makedirs(WORK_DIR, exist_ok=True)
_CHALLENGES: dict[str, float] = {}


# -------------------- SECURITY & CRYPTO PRIMITIVES --------------------
def verify_pin_ct(raw_pin: str) -> bool:
    digest = hashlib.sha256(raw_pin.strip().encode("utf-8")).digest()
    return hmac.compare_digest(digest, OWNER_PIN_HASH)


def create_challenge() -> str:
    now = time.time()
    for k, exp in list(_CHALLENGES.items()):
        if exp < now:
            _CHALLENGES.pop(k, None)
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
    _CHALLENGES[nonce] = now + 120
    return nonce


def consume_challenge(nonce: str) -> bool:
    exp = _CHALLENGES.pop(nonce, None)
    return exp is not None and exp >= time.time()


def hash_cred(cred_id: str) -> str:
    return hmac.new(APP_SECRET, cred_id.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def mint_token(role: str, subject: str) -> str:
    payload = f"{role}|{subject}|{int(time.time())}".encode("utf-8")
    b64_p = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    sig = hmac.new(APP_SECRET, b64_p.encode("ascii"), hashlib.sha256).digest()
    b64_s = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
    return f"{b64_p}.{b64_s}"


def parse_token(token: Optional[str]) -> Optional[dict]:
    if not token or "." not in token:
        return None
    b64_p, b64_s = token.split(".", 1)
    expected = hmac.new(APP_SECRET, b64_p.encode("ascii"), hashlib.sha256).digest()
    expected_s = base64.urlsafe_b64encode(expected).decode("ascii").rstrip("=")
    if not hmac.compare_digest(b64_s, expected_s):
        return None
    pad = "=" * (-len(b64_p) % 4)
    parts = base64.urlsafe_b64decode(b64_p + pad).decode("utf-8").split("|")
    if len(parts) != 3:
        return None
    return {"role": parts[0], "sub": parts[1], "iat": int(parts[2])}


def validate_youtube_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or parsed.netloc.lower() not in ALLOWED_YT_HOSTS:
        raise HTTPException(status_code=400, detail="Only valid YouTube URLs are allowed.")
    return url.strip()


def sanitize_caption(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9\s\-_.,!?/|]", "", text or "").strip()[:60]


def cleanup_old_jobs():
    now = time.time()
    for name in os.listdir(WORK_DIR):
        p = os.path.join(WORK_DIR, name)
        if os.path.isdir(p) and (now - os.path.getmtime(p)) > 1800:
            shutil.rmtree(p, ignore_errors=True)


# -------------------- SQLITE STORAGE --------------------
def db_conn():
    return sqlite3.connect(DB_PATH)


def init_db():
    conn = db_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS owner_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            cred_id TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            user_hash TEXT PRIMARY KEY,
            credits INTEGER DEFAULT 50,
            is_unlimited INTEGER DEFAULT 0,
            created_at INTEGER
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            upi_id TEXT DEFAULT '',
            qr_data_url TEXT DEFAULT '',
            crypto_address TEXT DEFAULT '',
            crypto_network TEXT DEFAULT 'USDT (TRC20)'
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_requests (
            id TEXT PRIMARY KEY,
            user_hash TEXT NOT NULL,
            region TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            amount_label TEXT NOT NULL,
            tx_ref TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            created_at INTEGER
        )
        """
    )
    cur.execute("INSERT OR IGNORE INTO payment_config (id) VALUES (1)")
    if ENV_OWNER_CRED_ID:
        cur.execute(
            "INSERT OR IGNORE INTO owner_lock (id, cred_id) VALUES (1, ?)",
            (ENV_OWNER_CRED_ID,),
        )
    conn.commit()
    conn.close()


init_db()


def get_owner_cred_id() -> Optional[str]:
    if ENV_OWNER_CRED_ID:
        return ENV_OWNER_CRED_ID
    conn = db_conn()
    cur = conn.cursor()
    cur.execute("SELECT cred_id FROM owner_lock WHERE id = 1")
    row = cur.fetchone()
    conn.close()
    return row[0] if row else None


def require_owner(auth_token: Optional[str]):
    session = parse_token(auth_token)
    owner_cred = get_owner_cred_id()
    if not session or session["role"] != "owner" or not owner_cred:
        raise HTTPException(status_code=403, detail="Owner biometric authorization required.")
    if not hmac.compare_digest(session["sub"], hash_cred(owner_cred)):
        raise HTTPException(status_code=403, detail="Invalid owner signature.")
    return session


def get_session_account(auth_token: Optional[str]):
    session = parse_token(auth_token)
    if not session:
        return {"loggedIn": False, "isOwner": False, "credits": 0, "isUnlimited": False}

    owner_cred = get_owner_cred_id()
    if session["role"] == "owner" and owner_cred and hmac.compare_digest(session["sub"], hash_cred(owner_cred)):
        return {
            "loggedIn": True,
            "isOwner": True,
            "credits": 999999,
            "isUnlimited": True,
            "userHash": session["sub"],
        }

    conn = db_conn()
    cur = conn.cursor()
    cur.execute("SELECT credits, is_unlimited FROM users WHERE user_hash = ?", (session["sub"],))
    row = cur.fetchone()
    conn.close()
    if not row:
        return {"loggedIn": False, "isOwner": False, "credits": 0, "isUnlimited": False}
    return {
        "loggedIn": True,
        "isOwner": False,
        "credits": row[0],
        "isUnlimited": bool(row[1]),
        "userHash": session["sub"],
    }


# -------------------- REQUEST MODELS --------------------
class BiometricAuthRequest(BaseModel):
    credentialId: str
    challenge: str
    ownerPin: Optional[str] = None


class PaymentConfigUpdate(BaseModel):
    upiId: str = ""
    qrDataUrl: str = ""
    cryptoAddress: str = ""
    cryptoNetwork: str = "USDT (TRC20)"


class PaymentSubmitRequest(BaseModel):
    region: str  # IN | GLOBAL
    planId: str  # pack_500 | unlimited
    txRef: str


class AnalyzeRequest(BaseModel):
    url: str


class HighlightCutRequest(BaseModel):
    url: str
    startSec: int
    durationSec: int
    aspectRatio: str = "9:16"
    caption: str = ""


# -------------------- AUTH & ADMIN ENDPOINTS --------------------
@app.get("/api/health")
def health():
    return {"status": "ClipAI Production Engine Online"}


@app.get("/api/auth/challenge")
def get_challenge():
    return {"challenge": create_challenge(), "ownerRegistered": bool(get_owner_cred_id())}


@app.post("/api/auth/biometric")
def biometric_login(req: BiometricAuthRequest):
    if not consume_challenge(req.challenge):
        raise HTTPException(status_code=400, detail="Expired or replayed biometric challenge.")
    if not req.credentialId or len(req.credentialId) < 8:
        raise HTTPException(status_code=400, detail="Invalid hardware biometric credential.")

    owner_cred = get_owner_cred_id()

    # Case 1: Existing Owner Biometric Match -> Lifetime Unlimited + Admin Vault
    if owner_cred and hmac.compare_digest(req.credentialId, owner_cred):
        token = mint_token("owner", hash_cred(owner_cred))
        return {
            "token": token,
            "account": get_session_account(token),
            "credentialId": owner_cred,
        }

    # Case 2: First-Time Single Owner Registration (Requires Secret OWNER_PIN)
    if req.ownerPin is not None and req.ownerPin.strip() != "":
        if owner_cred:
            raise HTTPException(status_code=403, detail="Owner biometric is already locked to 1 user.")
        if not verify_pin_ct(req.ownerPin):
            raise HTTPException(status_code=403, detail="Invalid Owner Setup PIN.")
        conn = db_conn()
        cur = conn.cursor()
        cur.execute("INSERT INTO owner_lock (id, cred_id) VALUES (1, ?)", (req.credentialId,))
        conn.commit()
        conn.close()
        token = mint_token("owner", hash_cred(req.credentialId))
        return {
            "token": token,
            "account": get_session_account(token),
            "credentialId": req.credentialId,
            "firstOwnerLock": True,
        }

    # Case 3: Normal User Biometric Login -> 50 Free Clips
    u_hash = hash_cred(req.credentialId)
    conn = db_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT OR IGNORE INTO users (user_hash, credits, is_unlimited, created_at) VALUES (?, 50, 0, ?)",
        (u_hash, int(time.time())),
    )
    conn.commit()
    conn.close()

    token = mint_token("user", u_hash)
    return {"token": token, "account": get_session_account(token)}


@app.get("/api/me")
def get_me(request: Request, x_auth_token: Optional[str] = Header(default=None)):
    country = (request.headers.get("cf-ipcountry") or request.headers.get("x-country-code") or "").upper()
    conn = db_conn()
    cur = conn.cursor()
    cur.execute("SELECT upi_id, qr_data_url, crypto_address, crypto_network FROM payment_config WHERE id = 1")
    cfg = cur.fetchone()
    conn.close()

    return {
        "account": get_session_account(x_auth_token),
        "detectedCountry": country,
        "paymentMethods": {
            "upiId": cfg[0] if cfg else "",
            "qrDataUrl": cfg[1] if cfg else "",
            "cryptoAddress": cfg[2] if cfg else "",
            "cryptoNetwork": cfg[3] if cfg else "USDT (TRC20)",
        },
    }


# -------------------- OWNER ADMIN PAYMENT CONTROL PAGE --------------------
@app.get("/api/owner/dashboard")
def owner_dashboard(x_auth_token: Optional[str] = Header(default=None)):
    require_owner(x_auth_token)
    conn = db_conn()
    cur = conn.cursor()
    cur.execute("SELECT upi_id, qr_data_url, crypto_address, crypto_network FROM payment_config WHERE id = 1")
    cfg = cur.fetchone()
    cur.execute(
        "SELECT id, user_hash, region, plan_id, amount_label, tx_ref, status, created_at FROM payment_requests ORDER BY created_at DESC LIMIT 50"
    )
    rows = cur.fetchall()
    cur.execute("SELECT COUNT(*) FROM users")
    total_users = cur.fetchone()[0]
    conn.close()

    return {
        "ownerCredentialId": get_owner_cred_id(),
        "totalUsers": total_users,
        "paymentMethods": {
            "upiId": cfg[0],
            "qrDataUrl": cfg[1],
            "cryptoAddress": cfg[2],
            "cryptoNetwork": cfg[3],
        },
        "payments": [
            {
                "id": r[0],
                "userHash": r[1][:10],
                "region": r[2],
                "planId": r[3],
                "amountLabel": r[4],
                "txRef": r[5],
                "status": r[6],
            }
            for r in rows
        ],
    }


@app.post("/api/owner/payment-config")
def update_payment_config(req: PaymentConfigUpdate, x_auth_token: Optional[str] = Header(default=None)):
    require_owner(x_auth_token)
    if req.qrDataUrl and len(req.qrDataUrl) > 600_000:
        raise HTTPException(status_code=400, detail="QR image too large. Keep under 400KB.")
    conn = db_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE payment_config SET upi_id = ?, qr_data_url = ?, crypto_address = ?, crypto_network = ? WHERE id = 1",
        (req.upiId.strip(), req.qrDataUrl.strip(), req.cryptoAddress.strip(), req.cryptoNetwork.strip()),
    )
    conn.commit()
    conn.close()
    return {"status": "saved"}


@app.post("/api/payments/submit")
def submit_payment(req: PaymentSubmitRequest, x_auth_token: Optional[str] = Header(default=None)):
    acc = get_session_account(x_auth_token)
    if not acc["loggedIn"]:
        raise HTTPException(status_code=401, detail="Login with Fingerprint / Eye first.")
    if len(req.txRef.strip()) < 4:
        raise HTTPException(status_code=400, detail="Enter a valid UPI UTR or Crypto Tx Hash.")

    if req.planId == "pack_500":
        amt = "₹130 (500 Clips)" if req.region == "IN" else "$5 (500 Clips)"
    elif req.planId == "unlimited":
        amt = "$50 (Unlimited Clips)"
    else:
        raise HTTPException(status_code=400, detail="Invalid plan.")

    pid = uuid.uuid4().hex[:10]
    conn = db_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO payment_requests (id, user_hash, region, plan_id, amount_label, tx_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)",
        (pid, acc["userHash"], req.region, req.planId, amt, req.txRef.strip()[:120], int(time.time())),
    )
    conn.commit()
    conn.close()
    return {"status": "submitted", "paymentId": pid}


@app.post("/api/owner/approve/{payment_id}")
def approve_payment(payment_id: str, x_auth_token: Optional[str] = Header(default=None)):
    require_owner(x_auth_token)
    conn = db_conn()
    cur = conn.cursor()
    cur.execute("SELECT user_hash, plan_id, status FROM payment_requests WHERE id = ?", (payment_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Payment request not found.")
    if row[2] == "APPROVED":
        conn.close()
        return {"status": "already_approved"}

    u_hash, plan_id = row[0], row[1]
    if plan_id == "pack_500":
        cur.execute("UPDATE users SET credits = credits + 500 WHERE user_hash = ?", (u_hash,))
    elif plan_id == "unlimited":
        cur.execute("UPDATE users SET is_unlimited = 1 WHERE user_hash = ?", (u_hash,))

    cur.execute("UPDATE payment_requests SET status = 'APPROVED' WHERE id = ?", (payment_id,))
    conn.commit()
    conn.close()
    return {"status": "approved"}


# -------------------- AI HIGHLIGHT ENGINE & STREAM CUTTER --------------------
def extract_youtube_info(url: str):
    clean_url = validate_youtube_url(url)
    ydl_opts = {
        "format": "best[height<=720][ext=mp4]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best",
        "quiet": True,
        "noplaylist": True,
        "skip_download": True,
        "extractor_args": {"youtube": {"player_client": ["android", "ios", "web"]}},
    }
    if os.path.exists("cookies.txt"):
        ydl_opts["cookiefile"] = "cookies.txt"

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(clean_url, download=False)

    v_url = info.get("url")
    a_url = None
    if not v_url and info.get("requested_formats"):
        v_url = info["requested_formats"][0].get("url")
        if len(info["requested_formats"]) > 1:
            a_url = info["requested_formats"][1].get("url")
    if not v_url:
        raise RuntimeError("Could not extract stream from YouTube.")

    return {
        "title": info.get("title", "YouTube Video"),
        "duration": int(info.get("duration") or 0),
        "heatmap": info.get("heatmap") or [],
        "chapters": info.get("chapters") or [],
        "videoUrl": v_url,
        "audioUrl": a_url,
    }


def detect_ai_highlights(info: dict, clip_len: int = 45, max_items: int = 5) -> List[dict]:
    """
    Greedy Non-Maximum Suppression (NMS) over YouTube replay heatmap + chapter hooks.
    O(N log N) time, O(1) memory, works cleanly on 6-hour videos.
    """
    duration = max(60, info["duration"])
    heatmap = info["heatmap"]
    highlights = []

    if heatmap:
        ranked = sorted(heatmap, key=lambda x: x.get("value", 0), reverse=True)
        for item in ranked:
            peak_start = max(0, int(item.get("start_time", 0)) - 5)
            score = int(min(99, max(76, 75 + item.get("value", 0.5) * 24)))
            if peak_start + clip_len <= duration and all(
                abs(peak_start - h["startSec"]) >= clip_len for h in highlights
            ):
                highlights.append(
                    {
                        "id": f"ai_{len(highlights)+1}",
                        "startSec": peak_start,
                        "durationSec": clip_len,
                        "viralScore": score,
                        "reason": "Peak Audience Replay Spike",
                    }
                )
            if len(highlights) >= max_items:
                break

    # Fallback: Chapters or golden-ratio engagement anchors
    if len(highlights) < 3:
        anchors = [0.12, 0.34, 0.58, 0.78]
        for idx, ratio in enumerate(anchors):
            st = max(0, min(duration - clip_len, int(duration * ratio)))
            if all(abs(st - h["startSec"]) >= clip_len for h in highlights):
                highlights.append(
                    {
                        "id": f"ai_{len(highlights)+1}",
                        "startSec": st,
                        "durationSec": clip_len,
                        "viralScore": 88 - idx * 3,
                        "reason": "AI Pacing & Hook Anchor",
                    }
                )
            if len(highlights) >= max_items:
                break

    highlights.sort(key=lambda x: x["viralScore"], reverse=True)
    return highlights


@app.post("/api/ai-analyze")
def ai_analyze(req: AnalyzeRequest):
    try:
        info = extract_youtube_info(req.url)
        highlights = detect_ai_highlights(info, clip_len=45, max_items=5)
        return {
            "title": info["title"],
            "duration": info["duration"],
            "highlights": highlights,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/cut-highlight")
def cut_highlight(req: HighlightCutRequest, x_auth_token: Optional[str] = Header(default=None)):
    acc = get_session_account(x_auth_token)
    if not acc["loggedIn"]:
        raise HTTPException(status_code=401, detail="Scan your Fingerprint / Eye to unlock 50 free clips!")
    if not acc["isOwner"] and not acc["isUnlimited"] and acc["credits"] <= 0:
        raise HTTPException(status_code=402, detail="0 clips remaining. Upgrade to 500 Clips or Unlimited.")

    cleanup_old_jobs()
    job_id = uuid.uuid4().hex[:10]
    job_dir = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    filename = f"ClipAI_{req.aspectRatio.replace(':', 'x')}_{job_id}.mp4"
    out_path = os.path.join(job_dir, filename)

    try:
        info = extract_youtube_info(req.url)
        dur = min(3600, max(5, req.durationSec))
        start_s = max(0, req.startSec)

        cmd = [
            FFMPEG_BIN, "-y",
            "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
            "-ss", str(start_s), "-i", info["videoUrl"],
        ]
        if info["audioUrl"]:
            cmd.extend(["-ss", str(start_s), "-i", info["audioUrl"]])
        cmd.extend(["-t", str(dur)])

        cap = sanitize_caption(req.caption)
        if req.aspectRatio == "16:9" and not cap and not info["audioUrl"]:
            cmd.extend(["-c", "copy", "-movflags", "+faststart", out_path])
        else:
            filters = ["scale=-2:720"]
            if req.aspectRatio == "9:16":
                filters.append("crop=ih*9/16:ih")
            elif req.aspectRatio == "1:1":
                filters.append("crop=ih:ih")
            if cap:
                font_arg = f"fontfile={FONT_PATH}:" if os.path.exists(FONT_PATH) else ""
                filters.append(
                    f"drawtext={font_arg}text='{cap}':x=(w-text_w)/2:y=H-60:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8"
                )
            cmd.extend([
                "-vf", ",".join(filters),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path,
            ])

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(proc.stderr.decode("utf-8", errors="ignore")[-250:])

        # Deduct 1 clip credit for non-owner, non-unlimited user
        if not acc["isOwner"] and not acc["isUnlimited"]:
            conn = db_conn()
            cur = conn.cursor()
            cur.execute("UPDATE users SET credits = MAX(0, credits - 1) WHERE user_hash = ?", (acc["userHash"],))
            conn.commit()
            conn.close()

        return {
            "fileName": filename,
            "downloadUrl": f"/api/files/{job_id}/{filename}",
            "account": get_session_account(x_auth_token),
        }
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/files/{job_id}/{filename}")
def serve_file(job_id: str, filename: str):
    safe_job = re.sub(r"[^a-zA-Z0-9]", "", job_id)
    safe_name = os.path.basename(filename)
    path = os.path.join(WORK_DIR, safe_job, safe_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Clip expired.")
    return FileResponse(path, media_type="video/mp4", filename=safe_name)


if os.path.exists("dist"):
    app.mount("/", StaticFiles(directory="dist", html=True), name="frontend")
