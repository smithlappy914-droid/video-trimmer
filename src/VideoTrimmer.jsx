import React, { useState, useRef, useEffect } from "react";

const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3GB Limit
const MAX_CUTS = 10;

const timeToSeconds = (timeStr) => {
  if (!timeStr || !timeStr.includes(":")) return 0;
  const parts = timeStr.split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
};

const secondsToTime = (totalSeconds) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const addSecondsToTime = (timeStr, secondsToAdd = 1) => {
  return secondsToTime(timeToSeconds(timeStr) + secondsToAdd);
};

const extractYouTubeId = (url) => {
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
};

export default function VideoTrimmer() {
  // Save Python Backend URL automatically in browser localStorage
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("yt_cloud_server_url") || ""
  );

  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [youtubeId, setYoutubeId] = useState(null);
  const [videoDuration, setVideoDuration] = useState(300);
  const [onlineTitle, setOnlineTitle] = useState("");

  const [masterStartSec, setMasterStartSec] = useState(0);
  const [masterEndSec, setMasterEndSec] = useState(60);
  const [selectedCutCount, setSelectedCutCount] = useState(1);

  const [urlInput, setUrlInput] = useState("");
  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);

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
    localStorage.setItem("yt_cloud_server_url", serverUrl);
  }, [serverUrl]);

  useEffect(() => {
    return () => {
      if (videoUrl && videoUrl.startsWith("blob:")) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

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

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert("File size exceeds 3GB limit!");
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

  const handleLoadUrl = async (e) => {
    e.preventDefault();
    const trimmedUrl = urlInput.trim();
    if (!trimmedUrl) {
      alert("Please paste a YouTube or Video link first!");
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
        if (oembedData.title) fetchedTitle = oembedData.title;
      }
    } catch {
      // Ignore metadata error
    }

    setOnlineTitle(fetchedTitle);

    const ytId = extractYouTubeId(trimmedUrl);
    if (ytId) {
      setYoutubeId(ytId);
      setVideoUrl("");
      setVideoDuration(1200); // 20 min slider range
      setMasterStartSec(0);
      setMasterEndSec(60);
      setVideoFile({
        name: `${fetchedTitle}.mp4`,
        isYouTube: true,
        originalUrl: trimmedUrl,
      });
      generateSequentialCuts(selectedCutCount, 0, 60, fetchedTitle);
      return;
    }

    setYoutubeId(null);
    setVideoUrl(trimmedUrl);
    setVideoFile({
      name: trimmedUrl.split("/").pop().split("?")[0] || "online_video.mp4",
      isRemoteUrl: true,
      originalUrl: trimmedUrl,
    });
    generateSequentialCuts(selectedCutCount, 0, 60, fetchedTitle);
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
    if (cuts.length >= MAX_CUTS) return;
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
      updatedCuts[index] = { ...updatedCuts[index], [field]: value };

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

  // 100% CLOUD SERVER CUTTING (0% Laptop CPU/RAM Load)
  const handleExportAllCuts = async () => {
    const cleanBackend = serverUrl.trim().replace(/\/$/, "");
    if (!cleanBackend) {
      alert(
        "Upar 'Render Python Server URL' box mein apna Python Web Service link paste karein taaki saari cutting cloud server par ho (0% laptop load)!"
      );
      return;
    }

    if (!videoFile && !videoUrl) {
      alert("Pehle YouTube link load karein ya video file upload karein!");
      return;
    }

    try {
      setIsProcessing(true);
      setExportedParts([]);
      setProgressText(
        "Cloud Server par video download aur cut ho rahi hai (Laptop CPU: 0% load)..."
      );

      let response;

      if (videoFile?.isYouTube || videoFile?.isRemoteUrl) {
        // Send YouTube URL + Cuts list to Render Python Server
        response = await fetch(`${cleanBackend}/process-youtube`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: videoFile.originalUrl,
            cuts: cuts,
          }),
        });
      } else {
        // Upload local file to Render Python Server for zero-laptop-load cutting
        const formData = new FormData();
        formData.append("file", videoFile);
        formData.append("cuts_json", JSON.stringify(cuts));

        response = await fetch(`${cleanBackend}/process-upload`, {
          method: "POST",
          body: formData,
        });
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Cloud server failed to cut video.");
      }

      // Attach full Render download URLs to each cut part
      const readyParts = data.parts.map((p, idx) => ({
        id: `cloud-part-${idx}-${Date.now()}`,
        partLabel: p.partLabel,
        fileName: p.fileName,
        downloadUrl: `${cleanBackend}${p.downloadPath}`,
        startTime: p.startTime,
        endTime: p.endTime,
        aspectRatio: p.aspectRatio,
      }));

      setExportedParts(readyParts);
    } catch (error) {
      alert(error.message || "Cloud server error.");
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
      <header className="max-w-7xl mx-auto mb-6 border-b border-slate-800 pb-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">
              100% Cloud Video Trimmer (Zero Laptop Load)
            </h1>
            <p className="text-xs sm:text-sm text-slate-400">
              All cutting & 9:16 rendering runs on Render Cloud Server • 0%
              Laptop CPU Load
            </p>
          </div>

          <label className="cursor-pointer bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg font-semibold text-sm transition text-center">
            Upload Local Video (Max 3GB)
            <input
              type="file"
              accept="video/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        {/* Cloud Server URL Box (Saves automatically) */}
        <div className="bg-indigo-950/40 border border-indigo-500/40 rounded-xl p-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          <span className="text-xs font-bold text-indigo-300 uppercase px-2 shrink-0">
            Render Python Server URL:
          </span>
          <input
            type="url"
            placeholder="Paste your Render Python Web Service URL (e.g. https://video-trimmer-api.onrender.com)"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-emerald-300 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <span className="text-[11px] text-emerald-400 font-semibold px-2 shrink-0">
            {serverUrl ? "✓ Connected" : "Required for 0% Laptop Load"}
          </span>
        </div>

        {/* Paste Online Video / YouTube Link Bar */}
        <form
          onSubmit={handleLoadUrl}
          className="bg-slate-900 border border-slate-800 rounded-xl p-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
        >
          <span className="text-xs font-bold text-emerald-400 uppercase px-2 shrink-0">
            YouTube / Video Link:
          </span>
          <input
            type="url"
            placeholder="Paste YouTube link or direct .mp4 URL here..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition shrink-0"
          >
            Load Link & Auto-Caption
          </button>
        </form>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN: Video Preview + Cut Slider + 1-10 Selector */}
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
              onLoadedMetadata={handleLoadedMetadata}
              className="w-full rounded-lg bg-black aspect-video object-contain border border-slate-800"
            />
          ) : (
            <div className="aspect-video rounded-lg border-2 border-dashed border-slate-800 flex flex-col items-center justify-center p-6 text-center bg-slate-950/50">
              <p className="text-slate-300 text-sm font-semibold mb-1">
                Koi Video Select Nahi Hai
              </p>
              <p className="text-slate-500 text-xs">
                Upar YouTube link paste karein ya local video upload karein.
              </p>
            </div>
          )}

          {/* Direct Cut Slider Under Video */}
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

            {/* 1 to 10 Cut Selector */}
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
                        ? "bg-indigo-600 text-white border-indigo-400"
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

        {/* RIGHT COLUMN: Ordered Cuts + Cloud Export */}
        <section className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
            <div>
              <h2 className="text-base font-bold text-white">
                2. Ordered Cut Parts ({cuts.length} / {MAX_CUTS})
              </h2>
              <p className="text-xs text-slate-400">
                Cloud Server par cut hoga • Laptop par 0% load
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
                  ? "Cutting on Cloud..."
                  : `Cut on Cloud (${cuts.length} Parts)`}
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
              {progressText}
            </div>
          )}

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
                  className="bg-slate-950 border border-slate-800 rounded-lg p-3.5"
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

          {/* Cloud Ready Download Section */}
          {exportedParts.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-800">
              <h3 className="text-sm font-bold text-emerald-400 mb-3">
                Cloud Cuts Ready (Order Wise: 1st to {exportedParts.length}th)
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
                      download={item.fileName}
                      target="_blank"
                      rel="noreferrer"
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
