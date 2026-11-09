let ffmpegInstance = null;
let utilModule = null;

const CORE_VERSION = "0.12.6";
const BASE_CDN_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const DEFAULT_FONT_URL =
  "https://raw.githubusercontent.com/ffmpegwasm/testdata/master/arial.ttf";

export async function initFFmpeg(onLogCallback) {
  if (ffmpegInstance && ffmpegInstance.loaded && utilModule) {
    return { ffmpeg: ffmpegInstance, ...utilModule };
  }

  // Lazy load FFmpeg & Util from ESM CDN only when user clicks Export
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import(/* @vite-ignore */ "https://esm.sh/@ffmpeg/ffmpeg@0.12.10"),
    import(/* @vite-ignore */ "https://esm.sh/@ffmpeg/util@0.12.1"),
  ]);

  utilModule = { fetchFile, toBlobURL };
  const ffmpeg = new FFmpeg();

  if (onLogCallback) {
    ffmpeg.on("log", ({ message }) => {
      onLogCallback(message);
    });
  }

  const coreURL = await toBlobURL(
    `${BASE_CDN_URL}/ffmpeg-core.js`,
    "text/javascript"
  );
  const wasmURL = await toBlobURL(
    `${BASE_CDN_URL}/ffmpeg-core.wasm`,
    "application/wasm"
  );

  await ffmpeg.load({
    coreURL,
    wasmURL,
  });

  try {
    const fontData = await fetchFile(DEFAULT_FONT_URL);
    await ffmpeg.writeFile("arial.ttf", fontData);
  } catch (error) {
    console.warn("Font preload skipped:", error);
  }

  ffmpegInstance = ffmpeg;
  return { ffmpeg: ffmpegInstance, fetchFile, toBlobURL };
}

function sanitizeDrawText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

export function buildFFmpegCommand(cut, inputFileName, outputFileName) {
  const { startTime, endTime, aspectRatio, overlayText } = cut;
  const trimmedText = overlayText ? overlayText.trim() : "";

  const isOriginalRatio =
    !aspectRatio || aspectRatio === "16:9" || aspectRatio === "original";
  const hasText = trimmedText.length > 0;

  if (isOriginalRatio && !hasText) {
    return [
      "-ss",
      startTime,
      "-to",
      endTime,
      "-i",
      inputFileName,
      "-c",
      "copy",
      outputFileName,
    ];
  }

  const videoFilters = [];

  if (aspectRatio === "9:16") {
    videoFilters.push("crop=ih*9/16:ih");
  } else if (aspectRatio === "1:1") {
    videoFilters.push("crop=ih:ih");
  } else if (aspectRatio === "4:5") {
    videoFilters.push("crop=ih*4/5:ih");
  }

  if (hasText) {
    const safeText = sanitizeDrawText(trimmedText);
    videoFilters.push(
      `drawtext=fontfile=arial.ttf:text='${safeText}':x=(w-text_w)/2:y=H-60:fontsize=36:fontcolor=white`
    );
  }

  const filterString = videoFilters.join(",");

  return [
    "-ss",
    startTime,
    "-to",
    endTime,
    "-i",
    inputFileName,
    "-vf",
    filterString,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    outputFileName,
  ];
}

export async function processVideoCuts(videoFile, cuts, onProgressUpdate) {
  if (!videoFile) {
    throw new Error("Please upload a video file first.");
  }
  if (!Array.isArray(cuts) || cuts.length === 0) {
    throw new Error("Please add at least one cut.");
  }

  if (onProgressUpdate) {
    onProgressUpdate({
      label: "Loading FFmpeg WebAssembly engine (first time takes ~5s)...",
    });
  }

  const { ffmpeg, fetchFile } = await initFFmpeg();

  const fileExtension = videoFile.name.split(".").pop() || "mp4";
  const inputFileName = `source_input.${fileExtension}`;

  const inputBuffer = await fetchFile(videoFile);
  await ffmpeg.writeFile(inputFileName, inputBuffer);

  const processedParts = [];

  try {
    for (let i = 0; i < cuts.length; i++) {
      const currentCut = cuts[i];
      const partNumber = i + 1;
      const outputFileName = `part_${partNumber}.mp4`;

      if (onProgressUpdate) {
        onProgressUpdate({
          currentPart: partNumber,
          totalParts: cuts.length,
          label: `Processing Part ${partNumber} of ${cuts.length}...`,
        });
      }

      const args = buildFFmpegCommand(
        currentCut,
        inputFileName,
        outputFileName
      );

      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) {
        throw new Error(`FFmpeg failed while processing Part ${partNumber}`);
      }

      const fileData = await ffmpeg.readFile(outputFileName);
      const videoBlob = new Blob([fileData.buffer], { type: "video/mp4" });
      const downloadUrl = URL.createObjectURL(videoBlob);

      processedParts.push({
        id: currentCut.id || `part-${partNumber}`,
        partLabel: `Part ${partNumber}`,
        fileName: `Part_${partNumber}_${videoFile.name.replace(/\.[^/.]+$/, "")}.mp4`,
        downloadUrl: downloadUrl,
        startTime: currentCut.startTime,
        endTime: currentCut.endTime,
        aspectRatio: currentCut.aspectRatio,
      });

      await ffmpeg.deleteFile(outputFileName);
    }
  } finally {
    try {
      await ffmpeg.deleteFile(inputFileName);
    } catch {
      // Ignore cleanup errors
    }
  }

  return processedParts;
}
