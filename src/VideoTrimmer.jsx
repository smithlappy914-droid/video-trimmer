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

// Multi-Fallback CORS Proxy Fetcher for remote URLs
async function fetchWithCorsFallback(targetUrl, onStatus) {
  const proxyList = [
    (u) => u, // 1. Try direct first
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`, // 2. CORSProxy.io
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, // 3. AllOrigins
  ];

  for (let i = 0; i < proxyList.length; i++) {
    try {
      if (onStatus && i > 0) {
        onStatus(`Bypassing CORS via Proxy #${i}...`);
      }
      const proxiedUrl = proxyList[i](targetUrl);
      const response = await fetch(proxiedUrl);
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size > 1000) {
          return blob;
        }
      }
    } catch {
      // Continue to next proxy
    }
  }
  throw new Error("All CORS proxies timed out for this link.");
}

// Resolve YouTube direct MP4 stream via public Piped/Invidious APIs
async function resolveYouTubeMp4Stream(ytId, onStatus) {
  const instances = [
    `https://pipedapi.kavin.rocks/streams/${ytId}`,
    `https://pipedapi.tokhmi.xyz/streams/${ytId}`,
    `https://pipedapi.moomoo.me/streams/${ytId}`,
    `https://api.piped.projectsegfau.lt/streams/${ytId}`,
  ];

  for (const apiUrl of instances) {
    try {
      if (onStatus) onStatus("Resolving direct MP4 stream from YouTube link...");
      const res = await fetch(apiUrl);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && Array.isArray(data.videoStreams)) {
        // Find a combined video+audio MP4 stream
        const mp4Stream =
          data.videoStreams.find(
            (s) => s.format === "MPEG_4" && s.videoOnly === false
          ) || data.videoStreams[0];
        if (mp4Stream && mp4Stream.url) {
          return mp4Stream.url;
        }
      }
    } catch {
      // Try next public instance
    }
  }
  return null;
}

export default function VideoTrimmer() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [youtubeId, setYoutubeId] = useState(null);
  const [videoDuration, setVideoDuration] = useState(300); // Default 5 mins (300s)
  const [onlineTitle, setOnlineTitle] = useState("");

  // Main Slider Range directly under the video player
  const [masterStartSec, setMasterStartSec] = useState(0);
  const [masterEndSec, setMasterEndSec] = useState(300);
  const [selectedCutCount, setSelectedCutCount] = useState(1);

  const [urlInput, setUrlInput] = useState("");
  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);

  const [cuts, setCuts] = useState([
    {
      id: "cut-1",
      startTime: "00:00",
      endTime: "05:00",
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

  // Helper: Generate N sequential cuts from Master Range with Auto-Numbering & Auto-Captions
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
      // Smart Auto-Shift: Part 1 starts at 00:00, Part 2 starts at Part 1 End + 1s
      const startSec =
        i === 0
          ? rangeStartSec
          : rangeStartSec + i * segmentLength + 1;
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

  // 2. Load Online URL / YouTube Link + Auto-Fetch Title for Auto-Caption
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
    let fetchedTitle = "Online Video";

    // Auto-fetch video title from noembed (CORS-free API) for Auto-Captions
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
      // Fallback if metadata not found
    }

    setOnlineTitle(fetchedTitle);

    const ytId = extractYouTubeId(trimmedUrl);
    if (ytId) {
      setYoutubeId(ytId);
      setVideoDuration(600);
      setMasterStartSec(0);
      setMasterEndSec(300);
      setVideoFile({
        name: `${fetchedTitle}.mp4`,
        isYouTube: true,
        ytId: ytId,
        originalUrl: trimmedUrl,
      });

      // Auto-populate cuts with fetched online title
      generateSequentialCuts(selectedCutCount, 0, 300, fetchedTitle);

      // Try resolving direct MP4 stream in background so native player works
      const resolvedStream = await resolveYouTubeMp4Stream(ytId);
      if (resolvedStream) {
        setVideoUrl(`https://corsproxy.io/?${encodeURIComponent(resolvedStream)}`);
        setYoutubeId(null); // Switch to native video player if stream resolved!
      }
      return;
    }

    // Direct Video URL (.mp4, R2 link, etc.) wrapped with CORS support
    setYoutubeId(null);
    setVideoUrl(trimmedUrl);
    setVideoFile({
      name:
        trimmedUrl.split("/").pop().split("?")[0] || "online_video.mp4",
      isRemoteUrl: true,
      url: trimmedUrl,
    });
    generateSequentialCuts(selectedCutCount, 0, 300, fetchedTitle);
  };

  // Update duration when video loads in player
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

  // Master Slider Change (Directly below video player)
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

  // Quick Selector: Choose How Many Cuts (1 to 10) at once
  const handleSelectCutCount = (count) => {
    setSelectedCutCount(count);
    generateSequentialCuts(count, masterStartSec, masterEndSec, onlineTitle);
  };

  // Manual "+ Add New Cut" with +1s Smart Auto-Shift
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

  // Edit Individual Cut Input
  const handleCutChange = (index, field, value) => {
    setCuts((prevCuts) => {
      const updatedCuts = [...prevCuts];
      updatedCuts[index] = {
        ...updatedCuts[index],
        [field]: value,
      };

      // Smart Auto-Shift (+1s) for next part
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

  // Export All Cuts with Automatic CORS Proxy & YouTube Stream Fallback
  const handleExportAllCuts = async () => {
    if (!videoFile && !videoUrl) {
      alert("Pehle koi video file upload karein ya link load karein!");
      return;
    }

    try {
      setIsProcessing(true);
      setExportedParts([]);

      let sourceToProcess = videoFile;

      // Case 1: If it's a YouTube link, resolve direct MP4 stream + fetch via CORS proxy
      if (videoFile?.isYouTube) {
        const streamUrl = await resolveYouTubeMp4Stream(
          videoFile.ytId,
          (msg) => setProgressText(msg)
        );

        if (!streamUrl) {
          throw new Error(
            "YouTube security blocked direct stream extraction on this network. Tip: Upload the downloaded MP4 file from your device for instant 3GB trimming!"
          );
        }

        const blob = await fetchWithCorsFallback(streamUrl, (msg) =>
          setProgressText(msg)
        );
        sourceToProcess = new File([blob], videoFile.name || "youtube.mp4", {
          type: "video/mp4",
        });
      }
      // Case 2: If it's a remote URL (.mp4 link), fetch through Multi-CORS Proxy
      else if (videoFile?.isRemoteUrl) {
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
      {/* Top Bar: Upload + Online Link Input */}
      <header className="max-w-7xl mx-auto mb-6 border-b border-slate-800 pb-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Smart Video Trimmer & Multi-Cut Maker
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              Slide under video to cut • Choose 1 to 10 Parts • Auto-Numbering
              & Auto-Caption
            </p>
          </div>

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
            placeholder="Paste direct .mp4 link or video URL here..."
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
        {/* LEFT COLUMN: Video Preview + Direct Cut Slider + 1-10 Cut Selector */}
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

          {/* Video Player Box */}
          {youtubeId ? (
            <iframe
              src={`https://www.youtube.com/embed/${youtubeId}`}
              title="YouTube Preview"
              className="w-full rounded-lg bg-black aspect-video border border-slate-800"
              allowFullScreen
            />
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
                Upar button se video upload karein ya link paste karein. Jaise
                hi video aayegi, neeche slider se cut select karein!
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

            {/* Visual Highlight Bar */}
            <div className="relative h-3 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="absolute top-0 bottom-0 bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full"
                style={{
                  left: `${masterLeftPercent}%`,
                  width: `${masterWidthPercent}%`,
                }}
              />
            </div>

            {/* Start & End Range Sliders Directly Under Video */}
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

          {/* Auto-Caption Toggle Bar */}
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

                  {/* Inputs for Start, End, Ratio, Auto-Caption */}
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

          {/* Ready to Download Section (Sequentially Numbered) */}
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
