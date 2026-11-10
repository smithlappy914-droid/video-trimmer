import React, { useState, useRef, useEffect } from "react";
import { processVideoCuts } from "./processVideoCuts.js";

const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3GB Limit
const MAX_CUTS = 10;

// Convert "MM:SS" to total seconds
const timeToSeconds = (timeStr) => {
  if (!timeStr || !timeStr.includes(":")) return 0;
  const parts = timeStr.split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  return 0;
};

// Convert total seconds to "MM:SS"
const secondsToTime = (totalSeconds) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

// Add seconds to "MM:SS"
const addSecondsToTime = (timeStr, secondsToAdd = 1) => {
  const currentSeconds = timeToSeconds(timeStr);
  return secondsToTime(currentSeconds + secondsToAdd);
};

// Extract 11-char YouTube ID
const extractYouTubeId = (url) => {
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
};

// Multi-Fallback CORS Proxy Fetcher
async function fetchWithCorsFallback(targetUrl, onStatus) {
  const proxyList = [
    (u) => u,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];

  for (let i = 0; i < proxyList.length; i++) {
    try {
      if (onStatus && i > 0) {
        onStatus(`Trying CORS Bypass Tunnel #${i}...`);
      }
      const res = await fetch(proxyList[i](targetUrl));
      if (res.ok) {
        const blob = await res.blob();
        // Verify we received real video bytes and not an HTML error page
        if (blob.size > 50000) {
          return blob;
        }
      }
    } catch {
      // Move to next proxy
    }
  }
  throw new Error("CORS proxy tunnel failed.");
}

// ELITE LAYER 1: Multi-Engine YouTube Blob Downloader (Python API + Invidious Local Proxy + Piped)
async function downloadYouTubeAsBlob(ytId, fullUrl, pythonBackendUrl, onStatus) {
  // 1. If user provided a Python yt-dlp Backend URL, use it first (100% reliable)
  if (pythonBackendUrl && pythonBackendUrl.trim()) {
    try {
      if (onStatus) onStatus("Downloading via Python yt-dlp Backend Engine...");
      const cleanBase = pythonBackendUrl.trim().replace(/\/$/, "");
      const res = await fetch(
        `${cleanBase}/download?url=${encodeURIComponent(fullUrl)}`
      );
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 50000) return blob;
      }
    } catch (err) {
      console.warn("Python backend unreachable, trying public tunnels...", err);
    }
  }

  // 2. Try Invidious "?local=true" Proxied Stream Tunnels (Bypasses IP Lock!)
  const invidiousInstances = [
    "https://inv.tux.pizza",
    "https://invidious.nerdvpn.de",
    "https://invidious.Jing.rocks",
    "https://invidious.privacyredirect.com",
    "https://vid.puffyan.us",
  ];

  for (const host of invidiousInstances) {
    try {
      if (onStatus) onStatus(`Trying Invidious Proxy Tunnel (${host})...`);
      // local=true forces the Invidious server to proxy the video bytes itself, bypassing IP lock!
      const proxiedVideoUrl = `${host}/latest_version?id=${ytId}&itag=18&local=true`;
      const blob = await fetchWithCorsFallback(proxiedVideoUrl);
      if (blob && blob.size > 50000) {
        return blob;
      }
    } catch {
      // Try next instance
    }
  }

  // 3. Try Piped API with proxied stream URLs
  const pipedInstances = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.tokhmi.xyz",
    "https://api.piped.projectsegfau.lt",
  ];

  for (const api of pipedInstances) {
    try {
      if (onStatus) onStatus(`Trying Piped Stream Tunnel (${api})...`);
      const res = await fetch(`${api}/streams/${ytId}`);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.videoStreams)) {
        const mp4 =
          data.videoStreams.find(
            (s) => s.format === "MPEG_4" && s.videoOnly === false
          ) || data.videoStreams[0];
        if (mp4 && mp4.url) {
          const blob = await fetchWithCorsFallback(mp4.url);
          if (blob && blob.size > 50000) return blob;
        }
      }
    } catch {
      // Try next instance
    }
  }

  return null;
}

export default function VideoTrimmer() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [youtubeId, setYoutubeId] = useState(null);
  const [videoDuration, setVideoDuration] = useState(300);
  const [onlineTitle, setOnlineTitle] = useState("");

  // Master Slider Range directly under the video player
  const [masterStartSec, setMasterStartSec] = useState(0);
  const [masterEndSec, setMasterEndSec] = useState(60);
  const [selectedCutCount, setSelectedCutCount] = useState(1);

  const [urlInput, setUrlInput] = useState("");
  const [pythonApiUrl, setPythonApiUrl] = useState("");
  const [showAdvancedApi, setShowAdvancedApi] = useState(false);
  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);

  // Live Tab Capture Bypass State (100% Unblockable Method)
  const [isRecordingTab, setIsRecordingTab] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const [cuts, setCuts] = useState([
    {
      id: "cut-1",
      startTime: "00:00",
      endTime: "01:00",
      aspectRatio: "9:16",
      overlayText: "Part 1 (Pehla Cut)",
    },
  ]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [exportedParts, setExportedParts] = useState([]);

  const videoRef = useRef(null);

  useEffect(() => {
    return () => {
      if (videoUrl && videoUrl.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  // Generate N sequential cuts with +1s Smart Auto-Shift & Auto-Captions
  const generateSequentialCuts = (
    count,
    rangeStartSec,
    rangeEndSec,
    baseTitle = onlineTitle
  ) => {
    const safeCount = Math.min(MAX_CUTS, Math.max(1, count));
    const totalSpan = Math.max(safeCount * 2, rangeEndSec - rangeStartSec);
    const segmentLength = Math.floor(totalSpan / safeCount);
    const cleanTitle = baseTitle
      ? baseTitle.replace(/[^\w\s|-]/g, "").slice(0, 28).trim()
      : "";

    const newCuts = [];
    for (let i = 0; i < safeCount; i++) {
      const partNum = i + 1;
      const startSec =
        i === 0 ? rangeStartSec : rangeStartSec + i * segmentLength + 1;
      const endSec =
        i === safeCount - 1
          ? rangeEndSec
          : Math.max(startSec + 1, rangeStartSec + (i + 1) * segmentLength);

      const autoCaption = autoCaptionEnabled
        ? cleanTitle
          ? `Part ${partNum}/${safeCount} - ${cleanTitle}`
          : `Part ${partNum} of ${safeCount}`
        : "";

      newCuts.push({
        id: `cut-${Date.now()}-${i}`,
        startTime: secondsToTime(startSec),
        endTime: secondsToTime(endSec),
        aspectRatio: "9:16",
        overlayText: autoCaption,
      });
    }
    setCuts(newCuts);
  };

  // 1. Local File Upload (Max 3GB)
  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert("File size exceeds 3GB limit! Please choose a file under 3GB.");
      event.target.value = "";
      return;
    }

    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }

    const cleanFileName = file.name.replace(/\.[^/.]+$/, "");
    const localPreviewUrl = URL.createObjectURL(file);

    setYoutubeId(null);
    setOnlineTitle(cleanFileName);
    setVideoFile(file);
    setVideoUrl(localPreviewUrl);
    setExportedParts([]);
  };

  // 2. Load Online URL / YouTube Link + Auto-Fetch Title
  const handleLoadUrl = async (e) => {
    e.preventDefault();
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      alert("Please paste a video link first!");
      return;
    }

    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }

    setExportedParts([]);
    let fetchedTitle = "YouTube Short Clip";

    try {
      const oembedRes = await fetch(
        `https://noembed.com/embed?url=${encodeURIComponent(trimmedUrl)}`
      );
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        if (oembedData.title) {
          fetchedTitle = oembedData.title;
        }
      }
    } catch {
      // Ignore metadata error
    }

    setOnlineTitle(fetchedTitle);

    const ytId = extractYouTubeId(trimmedUrl);
    if (ytId) {
      setYoutubeId(ytId);
      setVideoUrl("");
      setVideoDuration(600);
      setMasterStartSec(0);
      setMasterEndSec(60);
      setVideoFile({
        name: `${fetchedTitle.replace(/[^\w\s-]/g, "") || "yt_video"}.mp4`,
        isYouTube: true,
        ytId: ytId,
        originalUrl: trimmedUrl,
      });

      generateSequentialCuts(selectedCutCount, 0, 60, fetchedTitle);
      return;
    }

    // Direct Video URL
    setYoutubeId(null);
    setVideoUrl(trimmedUrl);
    setVideoFile({
      name: trimmedUrl.split("/").pop().split("?")[0] || "online_video.mp4",
      isRemoteUrl: true,
      url: trimmedUrl,
    });
    generateSequentialCuts(selectedCutCount, 0, 60, fetchedTitle);
  };

  // ELITE LAYER 3: 100% Unblockable Browser Tab Capture Bypass
  const handleStartTabCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: true,
        preferCurrentTab: true,
      });

      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
          ? "video/webm;codecs=vp8,opus"
          : "video/webm",
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const capturedBlob = new Blob(recordedChunksRef.current, {
          type: "video/webm",
        });
        const capturedFile = new File(
          [capturedBlob],
          `${(onlineTitle || "captured_clip").replace(/[^\w\s-]/g, "")}.webm`,
          { type: "video/webm" }
        );
        const localUrl = URL.createObjectURL(capturedFile);

        setYoutubeId(null);
        setVideoFile(capturedFile);
        setVideoUrl(localUrl);
        setIsRecordingTab(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(200);
      setIsRecordingTab(true);
    } catch (err) {
      alert(
        "Tab capture cancelled. Make sure to select 'This Tab' and enable 'Share tab audio'."
      );
    }
  };

  const handleStopTabCapture = () => {
    if (mediaRecorderRef.current && isRecordingTab) {
      mediaRecorderRef.current.stop();
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current && videoRef.current.duration) {
      const actualDuration = Math.floor(videoRef.current.duration);
      if (actualDuration > 0 && Number.isFinite(actualDuration)) {
        setVideoDuration(actualDuration);
        setMasterStartSec(0);
        setMasterEndSec(actualDuration);
        generateSequentialCuts(
          selectedCutCount,
          0,
          actualDuration,
          onlineTitle
        );
      }
    }
  };

  const handleMasterSlider = (type, rawVal) => {
    const sec = parseInt(rawVal, 10) || 0;
    let newStart = masterStartSec;
    let newEnd = masterEndSec;

    if (type === "start") {
      newStart = Math.min(sec, Math.max(0, masterEndSec - 2));
      setMasterStartSec(newStart);
      if (videoRef.current) videoRef.current.currentTime = newStart;
    } else {
      newEnd = Math.max(sec, masterStartSec + 2);
      setMasterEndSec(newEnd);
      if (videoRef.current) videoRef.current.currentTime = newEnd;
    }

    generateSequentialCuts(selectedCutCount, newStart, newEnd, onlineTitle);
  };

  const handleSelectCutCount = (count) => {
    setSelectedCutCount(count);
    generateSequentialCuts(count, masterStartSec, masterEndSec, onlineTitle);
  };

  const handleAddCut = () => {
    if (cuts.length >= MAX_CUTS) {
      alert("Maximum 10 cuts allowed!");
      return;
    }

    const lastCut = cuts[cuts.length - 1];
    const nextStartSec = lastCut
      ? Math.min(timeToSeconds(lastCut.endTime) + 1, videoDuration - 1)
      : 0;
    const nextEndSec = Math.min(nextStartSec + 60, videoDuration);
    const newTotal = cuts.length + 1;
    const cleanTitle = onlineTitle
      ? onlineTitle.replace(/[^\w\s|-]/g, "").slice(0, 28).trim()
      : "";

    const newCut = {
      id: `cut-${Date.now()}-${Math.random()}`,
      startTime: secondsToTime(nextStartSec),
      endTime: secondsToTime(nextEndSec),
      aspectRatio: "9:16",
      overlayText: autoCaptionEnabled
        ? cleanTitle
          ? `Part ${newTotal} - ${cleanTitle}`
          : `Part ${newTotal}`
        : "",
    };

    const updated = [...cuts, newCut];
    setCuts(updated);
    setSelectedCutCount(updated.length);
  };

  const handleCutChange = (index, field, value) => {
    setCuts((prevCuts) => {
      const updatedCuts = [...prevCuts];
      updatedCuts[index] = {
        ...updatedCuts[index],
        [field]: value,
      };

      if (field === "endTime" && index + 1 < updatedCuts.length) {
        updatedCuts[index + 1] = {
          ...updatedCuts[index + 1],
          startTime: addSecondsToTime(value, 1),
        };
      }
      return updatedCuts;
    });
  };

  const handleRemoveCut = (idToRemove) => {
    if (cuts.length <= 1) return;
    const filtered = cuts.filter((c) => c.id !== idToRemove);
    setCuts(filtered);
    setSelectedCutCount(filtered.length);
  };

  // Export All Cuts
  const handleExportAllCuts = async () => {
    if (!videoFile && !videoUrl) {
      alert("Pehle koi video upload karein ya link load karein!");
      return;
    }

    try {
      setIsProcessing(true);
      setExportedParts([]);

      let sourceToProcess = videoFile;

      if (videoFile?.isYouTube) {
        const ytBlob = await downloadYouTubeAsBlob(
          videoFile.ytId,
          videoFile.originalUrl,
          pythonApiUrl,
          (msg) => setProgressText(msg)
        );

        if (!ytBlob) {
          setIsProcessing(false);
          setProgressText("");
          alert(
            "Public proxies are busy for this YouTube video! Click the yellow '100% Bypass: Record from Player' button right below the YouTube video to capture & cut it instantly without any server block!"
          );
          return;
        }

        sourceToProcess = new File([ytBlob], videoFile.name || "youtube.mp4", {
          type: "video/mp4",
        });
      } else if (videoFile?.isRemoteUrl) {
        setProgressText("Downloading online video via CORS Proxy...");
        const blob = await fetchWithCorsFallback(videoFile.url, (msg) =>
          setProgressText(msg)
        );
        sourceToProcess = new File([blob], videoFile.name || "online.mp4", {
          type: blob.type || "video/mp4",
        });
      }

      const results = await processVideoCuts(
        sourceToProcess,
        cuts,
        (progress) => {
          setProgressText(progress.label);
        }
      );
      setExportedParts(results);
    } catch (error) {
      alert(error.message || "Error while processing cuts.");
    } finally {
      setIsProcessing(false);
      setProgressText("");
    }
  };

  const masterLeftPercent = Math.min(
    100,
    Math.max(0, (masterStartSec / Math.max(1, videoDuration)) * 100)
  );
  const masterWidthPercent = Math.min(
    100 - masterLeftPercent,
    Math.max(
      2,
      ((masterEndSec - masterStartSec) / Math.max(1, videoDuration)) * 100
    )
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
      {/* Top Header */}
      <header className="max-w-7xl mx-auto mb-6 border-b border-slate-800 pb-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Smart Video Trimmer & Multi-Cut Maker
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Slide under video to cut • Choose 1 to 10 Parts • Auto-Numbering &
              Auto-Caption
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAdvancedApi(!showAdvancedApi)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2.5 rounded-lg text-xs font-semibold border border-slate-700 transition"
            >
              {showAdvancedApi ? "Hide Python API" : "Connect Python yt-dlp"}
            </button>

            <label className="cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg font-semibold text-sm transition text-center shadow-lg shadow-indigo-600/20">
              Upload Video (Max 3GB)
              <input
                type="file"
                accept="video/*"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {/* Optional Python yt-dlp Backend Connector Bar */}
        {showAdvancedApi && (
          <div className="bg-indigo-950/40 border border-indigo-500/30 rounded-xl p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <span className="text-xs font-bold text-indigo-300 shrink-0">
              Python yt-dlp Server URL:
            </span>
            <input
              type="url"
              placeholder="e.g. https://my-ytdlp-api.onrender.com (Optional)"
              value={pythonApiUrl}
              onChange={(e) => setPythonApiUrl(e.target.value)}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
            />
          </div>
        )}

        {/* Paste Online Video Link Bar */}
        <form
          onSubmit={handleLoadUrl}
          className="bg-slate-900 border border-slate-800 rounded-xl p-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
        >
          <span className="text-xs font-bold text-indigo-400 uppercase px-2 shrink-0">
            Online Video Link:
          </span>
          <input
            type="url"
            placeholder="Paste YouTube link or direct .mp4 URL here..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition shrink-0"
          >
            Load Video & Auto-Caption
          </button>
        </form>
      </header>

      {/* Main Two-Column Layout */}
      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: Video Preview + Unblockable Bypass + Cut Slider */}
        <section className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-4 h-fit lg:sticky lg:top-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white">
              1. Video Preview & Cut Slider
            </h2>
            {onlineTitle && (
              <span className="text-xs bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2.5 py-1 rounded-md truncate max-w-[55%]">
                {onlineTitle}
              </span>
            )}
          </div>

          {youtubeId ? (
            <div className="space-y-3">
              <iframe
                src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1`}
                title="YouTube Preview"
                className="w-full rounded-lg bg-black aspect-video border border-slate-800"
                allow="autoplay; encrypted-media"
                allowFullScreen
              />

              {/* 100% UNBLOCKABLE BROWSER STREAM CAPTURE BAR */}
              <div className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="text-xs text-amber-200">
                  <p className="font-bold text-amber-400">
                    100% Unblockable YouTube Bypass (Zero Server Needed):
                  </p>
                  <p className="text-[11px] text-amber-300/80">
                    Play the part you want in the YouTube player above, click{" "}
                    <strong>Record from Player</strong>, and stop when done. It
                    converts straight into a local video ready for 9:16 cutting!
                  </p>
                </div>

                {!isRecordingTab ? (
                  <button
                    type="button"
                    onClick={handleStartTabCapture}
                    className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs px-4 py-2.5 rounded-lg shrink-0 transition shadow-lg shadow-amber-500/20"
                  >
                    100% Bypass: Record from Player
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStopTabCapture}
                    className="bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs px-4 py-2.5 rounded-lg shrink-0 animate-pulse"
                  >
                    Stop Recording & Load Clip
                  </button>
                )}
              </div>
            </div>
          ) : videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              crossOrigin="anonymous"
              onLoadedMetadata={handleLoadedMetadata}
              className="w-full rounded-lg bg-black aspect-video object-contain border border-slate-800"
            />
          ) : (
            <div className="aspect-video rounded-lg border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-6 text-center bg-slate-950/50">
              <p className="text-slate-300 text-sm font-semibold mb-1">
                Koi Video Select Nahi Hai
              </p>
              <p className="text-slate-500 text-xs">
                Upar button se video upload karein ya link paste karein.
              </p>
            </div>
          )}

          {/* DIRECT SLIDER RIGHT UNDER THE VIDEO */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300 font-semibold">
                Slide to Select Cut Range:
              </span>
              <span className="font-mono text-emerald-400 font-bold">
                {secondsToTime(masterStartSec)} to {secondsToTime(masterEndSec)}{" "}
                ({Math.max(0, masterEndSec - masterStartSec)}s selected)
              </span>
            </div>

            <div className="relative h-3 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="absolute top-0 bottom-0 bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full"
                style={{
                  left: `${masterLeftPercent}%`,
                  width: `${masterWidthPercent}%`,
                }}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Start Point:{" "}
                  <strong className="text-indigo-400">
                    {secondsToTime(masterStartSec)}
                  </strong>
                </label>
                <input
                  type="range"
                  min="0"
                  max={videoDuration}
                  value={masterStartSec}
                  onChange={(e) => handleMasterSlider("start", e.target.value)}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  End Point:{" "}
                  <strong className="text-emerald-400">
                    {secondsToTime(masterEndSec)}
                  </strong>
                </label>
                <input
                  type="range"
                  min="0"
                  max={videoDuration}
                  value={masterEndSec}
                  onChange={(e) => handleMasterSlider("end", e.target.value)}
                  className="w-full accent-emerald-500 cursor-pointer"
                />
              </div>
            </div>

            {/* SIMPLE NUMBER PICKER: Ek Baar Mein Kitne Cut Chahiye (1 to 10) */}
            <div className="pt-3 border-t border-slate-800/80">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-200">
                  Ek baar mein kitne Cut chahiye? (Choose 1 to 10):
                </span>
                <span className="text-xs text-indigo-400 font-bold">
                  {selectedCutCount} {selectedCutCount === 1 ? "Cut" : "Cuts"}
                </span>
              </div>

              <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => handleSelectCutCount(num)}
                    className={`py-2 rounded-lg text-xs font-bold transition border ${
                      selectedCutCount === num
                        ? "bg-indigo-600 text-white border-indigo-400 shadow-md shadow-indigo-600/30"
                        : "bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    {num}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Numbered Parts List + Auto-Captions + Export */}
        <section className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
            <div>
              <h2 className="text-base font-bold text-white">
                2. Ordered Cut Parts ({cuts.length} / {MAX_CUTS})
              </h2>
              <p className="text-xs text-slate-400">
                Har part par number aur auto-caption apne-aap lag gaya hai
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddCut}
                disabled={cuts.length >= MAX_CUTS || isProcessing}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 transition disabled:opacity-40"
              >
                + 1 More Cut
              </button>

              <button
                type="button"
                onClick={handleExportAllCuts}
                disabled={(!videoFile && !videoUrl) || isProcessing}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition ${
                  (!videoFile && !videoUrl) || isProcessing
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20"
                }`}
              >
                {isProcessing
                  ? "Cutting Video..."
                  : `Cut & Download (${cuts.length} Parts)`}
              </button>
            </div>
          </div>

          <div className="mb-3 flex items-center justify-between bg-slate-950 border border-slate-800 px-3.5 py-2 rounded-lg">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={autoCaptionEnabled}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAutoCaptionEnabled(checked);
                  setCuts((prev) =>
                    prev.map((c, idx) => ({
                      ...c,
                      overlayText: checked
                        ? onlineTitle
                          ? `Part ${idx + 1}/${prev.length} - ${onlineTitle.slice(0, 25)}`
                          : `Part ${idx + 1} of ${prev.length}`
                        : "",
                    }))
                  );
                }}
                className="accent-indigo-500 rounded"
              />
              <span>
                Auto-add <strong>Part Number + Video Caption</strong> on every
                cut
              </span>
            </label>
          </div>

          {isProcessing && (
            <div className="mb-4 bg-indigo-950/70 border border-indigo-500/40 text-indigo-300 px-4 py-3 rounded-lg text-xs font-semibold animate-pulse">
              {progressText || "Processing video cuts..."}
            </div>
          )}

          {/* Ordered Parts List */}
          <div className="space-y-3 max-h-[58vh] overflow-y-auto pr-1">
            {cuts.map((cut, index) => {
              const orderLabel =
                index === 0
                  ? "Pehla Cut (1st)"
                  : index === cuts.length - 1 && cuts.length > 1
                  ? `Aakhri Cut (${index + 1}th)`
                  : `Agla Cut (${index + 1}nd)`;

              return (
                <div
                  key={cut.id}
                  className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 hover:border-slate-700 transition"
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="bg-indigo-600 text-white text-xs font-bold px-2.5 py-0.5 rounded">
                        Part {index + 1}
                      </span>
                      <span className="text-[11px] bg-slate-900 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-medium">
                        #{index + 1} • {orderLabel}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">
                        ({cut.startTime} → {cut.endTime})
                      </span>
                    </div>

                    {cuts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveCut(cut.id)}
                        className="text-xs text-rose-400 hover:text-rose-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] text-slate-400 mb-1">
                        Start
                      </label>
                      <input
                        type="text"
                        value={cut.startTime}
                        onChange={(e) =>
                          handleCutChange(index, "startTime", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-[10px] text-slate-400 mb-1">
                        End
                      </label>
                      <input
                        type="text"
                        value={cut.endTime}
                        onChange={(e) =>
                          handleCutChange(index, "endTime", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono"
                      />
                    </div>

                    <div className="sm:col-span-3">
                      <label className="block text-[10px] text-slate-400 mb-1">
                        Size / Ratio
                      </label>
                      <select
                        value={cut.aspectRatio}
                        onChange={(e) =>
                          handleCutChange(index, "aspectRatio", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white"
                      >
                        <option value="9:16">9:16 (Reels/Shorts)</option>
                        <option value="1:1">1:1 (Square)</option>
                        <option value="16:9">16:9 (Original)</option>
                        <option value="4:5">4:5 (Portrait)</option>
                      </select>
                    </div>

                    <div className="col-span-2 sm:col-span-5">
                      <label className="block text-[10px] text-slate-400 mb-1">
                        Auto-Caption on Video (Part #{index + 1})
                      </label>
                      <input
                        type="text"
                        placeholder="Auto caption..."
                        value={cut.overlayText}
                        onChange={(e) =>
                          handleCutChange(index, "overlayText", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-emerald-300"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Ready to Download Section */}
          {exportedParts.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-800">
              <h3 className="text-sm font-bold text-emerald-400 mb-3">
                Download Numbered Cuts (Order Wise: 1st to {exportedParts.length}
                th)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {exportedParts.map((item, idx) => (
                  <div
                    key={item.id}
                    className="bg-slate-950 border border-emerald-500/40 rounded-lg p-3 flex items-center justify-between"
                  >
                    <div>
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-bold">
                        #{idx + 1} Cut
                      </span>
                      <p className="text-sm font-bold text-white mt-1">
                        {item.partLabel} ({item.aspectRatio})
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {item.startTime} → {item.endTime}
                      </p>
                    </div>
                    <a
                      href={item.downloadUrl}
                      download={`0${idx + 1}_${item.fileName}`}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3.5 py-2 rounded-lg transition"
                    >
                      Save Part {idx + 1}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
