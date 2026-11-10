# File: server.py (Python + FastAPI + yt-dlp)
# Install: pip install fastapi uvicorn yt-dlp
import os
import tempfile
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import yt_dlp

app = FastAPI()

# Allow CORS so your Render React frontend can fetch videos directly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/download")
def download_youtube_video(url: str):
    try:
        temp_dir = tempfile.mkdtemp()
        output_template = os.path.join(temp_dir, "video.%(ext)s")

        # Android/Web client spoofing to bypass YouTube bot restrictions
        ydl_opts = {
            "format": "best[ext=mp4]/best",
            "outtmpl": output_template,
            "quiet": True,
            "noplaylist": True,
            "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            downloaded_file = ydl.prepare_filename(info)

        return FileResponse(
            downloaded_file,
            media_type="video/mp4",
            filename="youtube_stream.mp4"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
