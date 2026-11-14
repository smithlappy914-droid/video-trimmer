import os
import uuid
import shutil
import subprocess
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import yt_dlp
import imageio_ffmpeg

app = FastAPI()

# Allow React Frontend on Render to talk to this Python Server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Get built-in FFmpeg binary path on Render Server (Zero laptop load!)
FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()
WORK_DIR = "/tmp/video_jobs"
os.makedirs(WORK_DIR, exist_ok=True)


class CutItem(BaseModel):
    startTime: str
    endTime: str
    aspectRatio: str = "9:16"
    overlayText: str = ""


class YouTubeProcessRequest(BaseModel):
    url: str
    cuts: List[CutItem]


def time_to_seconds(t_str: str) -> int:
    if not t_str or ":" not in t_str:
        return 0
    parts = [int(p) for p in t_str.split(":") if p.isdigit()]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0


def sanitize_text(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("'", "")
        .replace(":", " -")
        .replace('"', "")
    )


def run_server_ffmpeg_cuts(input_path: str, job_id: str, cuts: List[dict]):
    job_folder = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_folder, exist_ok=True)
    results = []

    for idx, cut in enumerate(cuts):
        part_num = idx + 1
        start_sec = time_to_seconds(cut["startTime"])
        end_sec = time_to_seconds(cut["endTime"])
        duration = max(1, end_sec - start_sec)
        ratio = cut.get("aspectRatio", "9:16")
        caption = (cut.get("overlayText") or "").strip()

        out_filename = f"Part_{part_num}_{job_id[:6]}.mp4"
        out_path = os.path.join(job_folder, out_filename)

        is_original = ratio in ["16:9", "original", ""]
        has_text = len(caption) > 0

        if is_original and not has_text:
            # Instant Cloud Stream Copy (Takes < 1 second on Render Server)
            cmd = [
                FFMPEG_BIN,
                "-y",
                "-ss",
                str(start_sec),
                "-i",
                input_path,
                "-t",
                str(duration),
                "-c",
                "copy",
                out_path,
            ]
        else:
            # Cloud Crop + Auto-Caption Burn
            filters = ["scale=-2:720"]
            if ratio == "9:16":
                filters.append("crop=ih*9/16:ih")
            elif ratio == "1:1":
                filters.append("crop=ih:ih")
            elif ratio == "4:5":
                filters.append("crop=ih*4/5:ih")

            if has_text:
                safe_cap = sanitize_text(caption)
                filters.append(
                    f"drawtext=text='{safe_cap}':x=(w-text_w)/2:y=H-55:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8"
                )

            cmd = [
                FFMPEG_BIN,
                "-y",
                "-ss",
                str(start_sec),
                "-i",
                input_path,
                "-t",
                str(duration),
                "-vf",
                ",".join(filters),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "26",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                out_path,
            ]

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(
                f"FFmpeg error on Part {part_num}: {proc.stderr.decode('utf-8', errors='ignore')[-300:]}"
            )

        results.append(
            {
                "partLabel": f"Part {part_num}",
                "fileName": out_filename,
                "downloadPath": f"/files/{job_id}/{out_filename}",
                "startTime": cut["startTime"],
                "endTime": cut["endTime"],
                "aspectRatio": ratio,
            }
        )

    return results


@app.get("/")
def root():
    return {"status": "100% Cloud Video Trimmer Server Running (Zero Laptop Load)"}


@app.post("/process-youtube")
def process_youtube_cuts(req: YouTubeProcessRequest):
    job_id = str(uuid.uuid4())
    job_folder = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_folder, exist_ok=True)
    raw_video_path = os.path.join(job_folder, "source.mp4")

    try:
        ydl_opts = {
            "format": "best[height<=720][ext=mp4]/best[ext=mp4]/best",
            "outtmpl": raw_video_path,
            "quiet": True,
            "noplaylist": True,
            "extractor_args": {
                "youtube": {"player_client": ["android", "ios", "web"]}
            },
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([req.url])

        if not os.path.exists(raw_video_path):
            raise HTTPException(
                status_code=400, detail="Could not download YouTube stream."
            )

        cuts_dict = [c.dict() for c in req.cuts]
        parts = run_server_ffmpeg_cuts(raw_video_path, job_id, cuts_dict)

        # Delete source video to save cloud disk space
        if os.path.exists(raw_video_path):
            os.remove(raw_video_path)

        return {"jobId": job_id, "parts": parts}
    except Exception as e:
        shutil.rmtree(job_folder, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/process-upload")
async def process_uploaded_video(
    file: UploadFile = File(...), cuts_json: str = Form(...)
):
    import json

    job_id = str(uuid.uuid4())
    job_folder = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_folder, exist_ok=True)
    raw_video_path = os.path.join(job_folder, file.filename or "upload.mp4")

    try:
        with open(raw_video_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        cuts_list = json.loads(cuts_json)
        parts = run_server_ffmpeg_cuts(raw_video_path, job_id, cuts_list)

        if os.path.exists(raw_video_path):
            os.remove(raw_video_path)

        return {"jobId": job_id, "parts": parts}
    except Exception as e:
        shutil.rmtree(job_folder, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/files/{job_id}/{filename}")
def serve_cut_file(job_id: str, filename: str):
    file_path = os.path.join(WORK_DIR, job_id, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File expired or not found.")
    return FileResponse(file_path, media_type="video/mp4", filename=filename)
