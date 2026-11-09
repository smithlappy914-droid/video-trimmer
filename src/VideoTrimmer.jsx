import React, { useState, useRef, useEffect } from "react";
import { processVideoCuts } from "./processVideoCuts.js";

const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3GB in Bytes
const MAX_CUTS = 10;

const timeToSeconds = (timeStr) => {
  if (!timeStr || !timeStr.includes(":")) return 0;
  const parts = timeStr.split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  return 0;
};

const secondsToTime = (totalSeconds) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const addSecondsToTime = (timeStr, secondsToAdd = 1) => {
  const currentSeconds = timeToSeconds(timeStr);
  return secondsToTime(currentSeconds + secondsToAdd);
};

export default function VideoTrimmer() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);

  const [cuts, setCuts] = useState([
    {
      id: "cut-1",
      startTime: "00:00",
      endTime: "05:00",
      aspectRatio: "16:9",
      overlayText: "",
    },
  ]);

  // Processing & Exported Download Links State
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [exportedParts, setExportedParts] = useState([]);

  const videoRef = useRef(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

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

    if (videoUrl) URL.revokeObjectURL(videoUrl);

    const localPreviewUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoUrl(localPreviewUrl);
    setExportedParts([]);
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setVideoDuration(Math.floor(videoRef.current.duration));
    }
  };

  const handleAddCut = () => {
    if (cuts.length >= MAX_CUTS) {
      alert("Maximum 10 cuts are allowed!");
      return;
    }

    const lastCut = cuts[cuts.length - 1];
    const nextStartTime = lastCut
      ? addSecondsToTime(lastCut.endTime, 1)
      : "00:00";
    const defaultNextEndTime = addSecondsToTime(nextStartTime, 59);

    const newCut = {
      id: `cut-${Date.now()}-${Math.random()}`,
      startTime: nextStartTime,
      endTime: defaultNextEndTime,
      aspectRatio: "16:9",
      overlayText: "",
    };

    setCuts((prevCuts) => [...prevCuts, newCut]);
  };

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

  // Trigger FFmpeg processing for all cuts
  const handleExportAllCuts = async () => {
    if (!videoFile) {
      alert("Please upload a video first!");
      return;
    }

    try {
      setIsProcessing(true);
      setExportedParts([]);
      const results = await processVideoCuts(videoFile, cuts, (progress) => {
        setProgressText(progress.label);
      });
      setExportedParts(results);
    } catch (error) {
      alert(error.message || "Something went wrong while trimming the video.");
    } finally {
      setIsProcessing(false);
      setProgressText("");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      {/* Header */}
      <header className="max-w-7xl mx-auto mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Client-Side Video Trimmer
          </h1>
          <p className="text-sm text-slate-400">
            Zero-server upload • Instant Blob preview • Max 3GB file size
          </p>
        </div>

        <div className="mt-4 sm:mt-0">
          <label className="cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition inline-block">
            Upload Video (Max 3GB)
            <input
              type="file"
              accept="video/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>
      </header>

      {/* Main Two-Column Dashboard */}
      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT SIDE: Video Preview */}
        <section className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between h-fit lg:sticky lg:top-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-200">
              Original Video Preview
            </h2>
            {videoFile && (
              <span className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md">
                {(videoFile.size / (1024 * 1024)).toFixed(1)} MB
              </span>
            )}
          </div>

          {videoUrl ? (
            <div className="space-y-3">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onLoadedMetadata={handleLoadedMetadata}
                className="w-full rounded-lg bg-black aspect-video object-contain border border-slate-800"
              />
              <div className="flex items-center justify-between text-xs text-slate-400 bg-slate-950/60 p-2.5 rounded-lg">
                <span className="truncate max-w-[70%] font-medium text-slate-300">
                  {videoFile?.name}
                </span>
                <span>Duration: {secondsToTime(videoDuration)}</span>
              </div>
            </div>
          ) : (
            <div className="aspect-video rounded-lg border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-6 text-center bg-slate-950/40">
              <p className="text-slate-400 text-sm font-medium mb-1">
                No video selected yet
              </p>
              <p className="text-slate-500 text-xs">
                Upload a video up to 3GB to preview directly in your browser.
              </p>
            </div>
          )}
        </section>

        {/* RIGHT SIDE: Cuts List + Export Section */}
        <section className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
            <div>
              <h2 className="text-base font-semibold text-slate-200">
                Trim Segments ({cuts.length} / {MAX_CUTS})
              </h2>
              <p className="text-xs text-slate-400">
                Sequential auto-labeling with +1s smart start-time shift
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
                disabled={!videoFile || isProcessing}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                  !videoFile || isProcessing
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white"
                }`}
              >
                {isProcessing ? "Processing..." : "Export All Cuts"}
              </button>
            </div>
          </div>

          {/* Processing Status Banner */}
          {isProcessing && (
            <div className="mb-4 bg-indigo-950/60 border border-indigo-500/40 text-indigo-300 px-4 py-3 rounded-lg text-sm font-medium animate-pulse">
              {progressText || "Processing video cuts..."}
            </div>
          )}

          {/* Cuts List */}
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            {cuts.map((cut, index) => (
              <div
                key={cut.id}
                className="bg-slate-950 border border-slate-800 rounded-lg p-4 transition hover:border-slate-700"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 text-xs font-bold px-2.5 py-1 rounded">
                      Part {index + 1}
                    </span>
                    <span className="text-xs text-slate-400">
                      ({cut.startTime} — {cut.endTime})
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
            ))}
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