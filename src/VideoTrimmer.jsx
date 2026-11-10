import React, { useState, useRef, useEffect } from "react";
import { processVideoCuts } from "./processVideoCuts.js";

const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3GB in Bytes
const MAX_CUTS = 10;

// Convert "MM:SS" string to total seconds
const timeToSeconds = (timeStr) => {
  if (!timeStr || !timeStr.includes(":")) return 0;
  const parts = timeStr.split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  return 0;
};

// Convert total seconds back to "MM:SS" string
const secondsToTime = (totalSeconds) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

// Add seconds to a "MM:SS" timestamp
const addSecondsToTime = (timeStr, secondsToAdd = 1) => {
  const currentSeconds = timeToSeconds(timeStr);
  return secondsToTime(currentSeconds + secondsToAdd);
};

// Extract YouTube Video ID if user pastes a YouTube link
const extractYouTubeId = (url) => {
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
};

export default function VideoTrimmer() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [youtubeId, setYoutubeId] = useState(null);
  const [videoDuration, setVideoDuration] = useState(600); // Default 10 mins (600s) before video loads

  // State for pasting external video or YouTube link
  const [urlInput, setUrlInput] = useState("");

  const [cuts, setCuts] = useState([
    {
      id: "cut-1",
      startTime: "00:00",
      endTime: "05:00",
      aspectRatio: "16:9",
      overlayText: "",
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

  // 1. Local File Upload Handler (Max 3GB)
  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert(
        "File size exceeds the 3GB limit! Please select a video smaller than 3GB."
      );
      event.target.value = "";
      return;
    }

    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }

    const localPreviewUrl = URL.createObjectURL(file);
    setYoutubeId(null);
    setVideoFile(file);
    setVideoUrl(localPreviewUrl);
    setExportedParts([]);
  };

  // 2. Paste Video Link / YouTube URL Handler
  const handleLoadUrl = (e) => {
    e.preventDefault();
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      alert("Please paste a valid video or YouTube URL first!");
      return;
    }

    if (videoUrl && videoUrl.startsWith("blob:")) {
      URL.revokeObjectURL(videoUrl);
    }

    const ytId = extractYouTubeId(trimmedUrl);
    if (ytId) {
      // YouTube URL detected
      setYoutubeId(ytId);
      setVideoUrl("");
      setVideoFile({ name: `YouTube_${ytId}.mp4`, isYouTube: true });
      setVideoDuration(900); // Default 15 mins slider range for YouTube preview
      setExportedParts([]);
      return;
    }

    // Direct Video URL (.mp4, .webm, R2 link, etc.)
    setYoutubeId(null);
    setVideoUrl(trimmedUrl);
    setVideoFile({
      name:
        trimmedUrl.split("/").pop().split("?")[0] || "remote_video_stream.mp4",
      isRemoteUrl: true,
      url: trimmedUrl,
    });
    setExportedParts([]);
  };

  // Capture exact video duration when metadata loads
  const handleLoadedMetadata = () => {
    if (videoRef.current && videoRef.current.duration) {
      const actualDuration = Math.floor(videoRef.current.duration);
      if (actualDuration > 0 && Number.isFinite(actualDuration)) {
        setVideoDuration(actualDuration);
        // Clamp Part 1 endTime if video is shorter than 05:00
        setCuts((prevCuts) =>
          prevCuts.map((c, idx) =>
            idx === 0 && timeToSeconds(c.endTime) > actualDuration
              ? { ...c, endTime: secondsToTime(actualDuration) }
              : c
          )
        );
      }
    }
  };

  // Add New Cut with +1s Smart Auto-Shift
  const handleAddCut = () => {
    if (cuts.length >= MAX_CUTS) {
      alert("Maximum 10 cuts are allowed!");
      return;
    }

    const lastCut = cuts[cuts.length - 1];
    const nextStartSec = lastCut
      ? Math.min(timeToSeconds(lastCut.endTime) + 1, videoDuration - 1)
      : 0;
    const nextEndSec = Math.min(nextStartSec + 60, videoDuration);

    const newCut = {
      id: `cut-${Date.now()}-${Math.random()}`,
      startTime: secondsToTime(nextStartSec),
      endTime: secondsToTime(nextEndSec),
      aspectRatio: "16:9",
      overlayText: "",
    };

    setCuts((prevCuts) => [...prevCuts, newCut]);
  };

  // Update Cut via Text Input + Trigger Smart Auto-Shift
  const handleCutChange = (index, field, value) => {
    setCuts((prevCuts) => {
      const updatedCuts = [...prevCuts];
      updatedCuts[index] = {
        ...updatedCuts[index],
        [field]: value,
      };

      // Smart Auto-Shift: Update next cut's startTime to current endTime + 1s
      if (field === "endTime" && index + 1 < updatedCuts.length) {
        updatedCuts[index + 1] = {
          ...updatedCuts[index + 1],
          startTime: addSecondsToTime(value, 1),
        };
      }

      return updatedCuts;
    });
  };

  // Update Cut via Interactive Slider + Seek Video Player Live
  const handleSliderChange = (index, type, rawSeconds) => {
    const secValue = parseInt(rawSeconds, 10) || 0;

    setCuts((prevCuts) => {
      const updatedCuts = [...prevCuts];
      const currentCut = updatedCuts[index];
      const currentStartSec = timeToSeconds(currentCut.startTime);
      const currentEndSec = timeToSeconds(currentCut.endTime);

      if (type === "start") {
        // Ensure start time does not cross end time
        const clampedStart = Math.min(secValue, Math.max(0, currentEndSec - 1));
        updatedCuts[index] = {
          ...currentCut,
          startTime: secondsToTime(clampedStart),
        };
        if (videoRef.current) {
          videoRef.current.currentTime = clampedStart;
        }
      } else if (type === "end") {
        // Ensure end time is at least 1 second after start time
        const clampedEnd = Math.max(secValue, currentStartSec + 1);
        const formattedEnd = secondsToTime(clampedEnd);
        updatedCuts[index] = {
          ...currentCut,
          endTime: formattedEnd,
        };
        if (videoRef.current) {
          videoRef.current.currentTime = clampedEnd;
        }

        // Smart Auto-Shift for the next Part
        if (index + 1 < updatedCuts.length) {
          const nextStartSec = Math.min(clampedEnd + 1, videoDuration);
          const nextEndSec = Math.max(
            timeToSeconds(updatedCuts[index + 1].endTime),
            nextStartSec + 1
          );
          updatedCuts[index + 1] = {
            ...updatedCuts[index + 1],
            startTime: secondsToTime(nextStartSec),
            endTime: secondsToTime(Math.min(nextEndSec, videoDuration)),
          };
        }
      }

      return updatedCuts;
    });
  };

  const handleRemoveCut = (idToRemove) => {
    if (cuts.length <= 1) {
      alert("At least 1 cut is required.");
      return;
    }
    setCuts((prevCuts) => prevCuts.filter((cut) => cut.id !== idToRemove));
  };

  const jumpToCutStart = (startTimeStr) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = timeToSeconds(startTimeStr);
    videoRef.current.play();
  };

  // Export All Cuts with FFmpeg.wasm
  const handleExportAllCuts = async () => {
    if (!videoFile && !videoUrl) {
      alert("Please upload a video or paste a video link first!");
      return;
    }

    if (videoFile?.isYouTube) {
      alert(
        "YouTube links block direct browser downloading due to CORS policy. For FFmpeg export, please paste a direct .mp4 link or upload the video file from your device."
      );
      return;
    }

    try {
      setIsProcessing(true);
      setExportedParts([]);

      let sourceToProcess = videoFile;
      if (videoFile?.isRemoteUrl) {
        setProgressText("Fetching remote video from URL...");
        const response = await fetch(videoFile.url);
        if (!response.ok) {
          throw new Error("Could not fetch video from URL (CORS blocked).");
        }
        const blob = await response.blob();
        sourceToProcess = new File([blob], videoFile.name || "remote.mp4", {
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
      alert(
        error.message || "Something went wrong while trimming the video."
      );
    } finally {
      setIsProcessing(false);
      setProgressText("");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      {/* Top Header + URL Paste Bar + File Upload */}
      <header className="max-w-7xl mx-auto mb-6 border-b border-slate-800 pb-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">
              Client-Side Video Trimmer
            </h1>
            <p className="text-sm text-slate-400">
              Zero-server upload • Visual Cut Slider • Direct URL & Local File
              Support (Max 3GB)
            </p>
          </div>

          <label className="cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-lg font-semibold text-sm transition inline-block text-center shrink-0">
            Upload Video from Device (Max 3GB)
            <input
              type="file"
              accept="video/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        {/* Dedicated Video / YouTube Link Paste Bar */}
        <form
          onSubmit={handleLoadUrl}
          className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
        >
          <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider px-2 shrink-0">
            Paste Video Link:
          </span>
          <input
            type="url"
            placeholder="Paste YouTube URL or direct .mp4 / R2 video link here..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition shrink-0"
          >
            Load Link
          </button>
        </form>
      </header>

      {/* Main Two-Column Dashboard */}
      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: Original Video / YouTube Preview */}
        <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between h-fit lg:sticky lg:top-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-200">
              Original Video Preview
            </h2>
            {videoFile && (
              <span className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                {videoFile.size
                  ? `${(videoFile.size / (1024 * 1024)).toFixed(1)} MB`
                  : videoFile.isYouTube
                  ? "YouTube Preview"
                  : "Direct URL"}
              </span>
            )}
          </div>

          {youtubeId ? (
            <div className="space-y-3">
              <iframe
                src={`https://www.youtube.com/embed/${youtubeId}`}
                title="YouTube video player"
                className="w-full rounded-lg bg-black aspect-video border border-slate-800"
                allowFullScreen
              />
              <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-500/30 p-2.5 rounded-lg">
                YouTube preview loaded! Use the sliders on the right to plan
                your cuts. (For direct MP4 trimming inside the browser, use a
                direct .mp4 link or upload a local file).
              </div>
            </div>
          ) : videoUrl ? (
            <div className="space-y-3">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                crossOrigin="anonymous"
                onLoadedMetadata={handleLoadedMetadata}
                className="w-full rounded-lg bg-black aspect-video object-contain border border-slate-800"
              />
              <div className="flex items-center justify-between text-xs text-slate-400 bg-slate-950/60 p-2.5 rounded-lg">
                <span className="truncate max-w-[65%] font-medium text-slate-300">
                  {videoFile?.name}
                </span>
                <span>Total Length: {secondsToTime(videoDuration)}</span>
              </div>
            </div>
          ) : (
            <div className="aspect-video rounded-lg border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-6 text-center bg-slate-950/40">
              <p className="text-slate-400 text-sm font-medium mb-1">
                No video selected yet
              </p>
              <p className="text-slate-500 text-xs">
                Upload a video (up to 3GB) or paste a link in the bar above.
              </p>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Cuts Manager with Interactive Sliders */}
        <section className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-200">
                Trim Segments ({cuts.length} / {MAX_CUTS})
              </h2>
              <p className="text-xs text-slate-400">
                Slide handles or type MM:SS • Auto-shifts next cut by +1s
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddCut}
                disabled={cuts.length >= MAX_CUTS || isProcessing}
                className={`px-3.5 py-2 rounded-lg text-sm font-semibold transition ${
                  cuts.length >= MAX_CUTS || isProcessing
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white"
                }`}
              >
                + Add New Cut
              </button>

              <button
                type="button"
                onClick={handleExportAllCuts}
                disabled={(!videoFile && !videoUrl) || isProcessing}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  (!videoFile && !videoUrl) || isProcessing
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white"
                }`}
              >
                {isProcessing ? "Processing..." : "Export All Cuts"}
              </button>
            </div>
          </div>

          {isProcessing && (
            <div className="mb-4 bg-indigo-950/60 border border-indigo-500/40 text-indigo-300 px-4 py-3 rounded-lg text-sm font-medium animate-pulse">
              {progressText || "Processing video cuts..."}
            </div>
          )}

          {/* Scrollable List of Cuts */}
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
            {cuts.map((cut, index) => {
              const startSec = timeToSeconds(cut.startTime);
              const endSec = timeToSeconds(cut.endTime);
              const maxSec = Math.max(videoDuration, endSec + 60, 60);
              const leftPercent = Math.min(
                100,
                Math.max(0, (startSec / maxSec) * 100)
              );
              const widthPercent = Math.min(
                100 - leftPercent,
                Math.max(1, ((endSec - startSec) / maxSec) * 100)
              );

              return (
                <div
                  key={cut.id}
                  className="bg-slate-950 border border-slate-800 rounded-lg p-4 transition hover:border-slate-700"
                >
                  {/* Top Bar of Part Card */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 text-xs font-bold px-2.5 py-1 rounded">
                        Part {index + 1}
                      </span>
                      <span className="text-xs text-slate-300 font-mono">
                        {cut.startTime} → {cut.endTime} (
                        {Math.max(0, endSec - startSec)}s)
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      {videoUrl && (
                        <button
                          type="button"
                          onClick={() => jumpToCutStart(cut.startTime)}
                          className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                        >
                          Preview Start
                        </button>
                      )}
                      {cuts.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveCut(cut.id)}
                          className="text-xs text-rose-400 hover:text-rose-300 font-medium"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Interactive Visual Range Slider for Start & End Selection */}
                  <div className="mb-4 bg-slate-900/90 border border-slate-800/80 rounded-lg p-3">
                    <div className="flex justify-between text-[11px] text-slate-400 mb-1.5">
                      <span>
                        Slide Start:{" "}
                        <strong className="text-indigo-400">
                          {cut.startTime}
                        </strong>
                      </span>
                      <span>
                        Slide End:{" "}
                        <strong className="text-emerald-400">
                          {cut.endTime}
                        </strong>
                      </span>
                    </div>

                    {/* Highlighted Visual Timeline Bar */}
                    <div className="relative h-2.5 bg-slate-800 rounded-full overflow-hidden mb-3">
                      <div
                        className="absolute top-0 bottom-0 bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full"
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                        }}
                      />
                    </div>

                    {/* Dual Sliders for Smooth Dragging */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-400 w-10">
                          Start:
                        </span>
                        <input
                          type="range"
                          min="0"
                          max={maxSec}
                          value={startSec}
                          onChange={(e) =>
                            handleSliderChange(index, "start", e.target.value)
                          }
                          className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-400 w-10">
                          End:
                        </span>
                        <input
                          type="range"
                          min="0"
                          max={maxSec}
                          value={endSec}
                          onChange={(e) =>
                            handleSliderChange(index, "end", e.target.value)
                          }
                          className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Manual Input Fields: Start Time, End Time, Aspect Ratio, Text */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                    <div className="sm:col-span-3">
                      <label className="block text-xs text-slate-400 mb-1">
                        Start Time (MM:SS)
                      </label>
                      <input
                        type="text"
                        placeholder="00:00"
                        value={cut.startTime}
                        onChange={(e) =>
                          handleCutChange(index, "startTime", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div className="sm:col-span-3">
                      <label className="block text-xs text-slate-400 mb-1">
                        End Time (MM:SS)
                      </label>
                      <input
                        type="text"
                        placeholder="05:00"
                        value={cut.endTime}
                        onChange={(e) =>
                          handleCutChange(index, "endTime", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div className="sm:col-span-3">
                      <label className="block text-xs text-slate-400 mb-1">
                        Aspect Ratio
                      </label>
                      <select
                        value={cut.aspectRatio}
                        onChange={(e) =>
                          handleCutChange(index, "aspectRatio", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="16:9">16:9 (Landscape)</option>
                        <option value="9:16">9:16 (Reels/Shorts)</option>
                        <option value="1:1">1:1 (Square)</option>
                        <option value="4:5">4:5 (Portrait)</option>
                      </select>
                    </div>

                    <div className="sm:col-span-3">
                      <label className="block text-xs text-slate-400 mb-1">
                        Part Text / Caption
                      </label>
                      <input
                        type="text"
                        placeholder="Enter caption..."
                        value={cut.overlayText}
                        onChange={(e) =>
                          handleCutChange(index, "overlayText", e.target.value)
                        }
                        className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Exported Downloadable Clips Section */}
          {exportedParts.length > 0 && (
            <div className="mt-6 pt-4 border-t border-slate-800">
              <h3 className="text-sm font-semibold text-emerald-400 mb-3">
                Ready to Save ({exportedParts.length} Clips)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {exportedParts.map((item) => (
                  <div
                    key={item.id}
                    className="bg-slate-950 border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-bold text-white">
                        {item.partLabel} ({item.aspectRatio})
                      </p>
                      <p className="text-xs text-slate-400">
                        {item.startTime} to {item.endTime}
                      </p>
                    </div>
                    <a
                      href={item.downloadUrl}
                      download={item.fileName}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-2 rounded-md transition"
                    >
                      Download MP4
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
