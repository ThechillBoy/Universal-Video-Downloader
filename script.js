(function () {
  "use strict";

  var form = document.getElementById("url-form");
  var urlInput = document.getElementById("url-input");
  var inputWrap = document.getElementById("input-wrap");
  var pasteBtn = document.getElementById("paste-btn");
  var analyzeBtn = document.getElementById("analyze-btn");
  var analyzeLabel = document.getElementById("analyze-label");
  var formStatus = document.getElementById("form-status");

  var resultCard = document.getElementById("result-card");
  var thumb = document.getElementById("thumb");
  var platformBadge = document.getElementById("platform-badge");
  var durationBadge = document.getElementById("duration-badge");
  var resultTitle = document.getElementById("result-title");
  var resultDuration = document.getElementById("result-duration");
  var resultPlatform = document.getElementById("result-platform");
  var resultRes = document.getElementById("result-res");

  var qualityChips = document.getElementById("quality-chips");
  var formatChips = document.getElementById("format-chips");
  var fileSizeEl = document.getElementById("file-size");

  var downloadBtn = document.getElementById("download-btn");
  var downloadLabel = document.getElementById("download-label");
  var resetBtn = document.getElementById("reset-btn");
  var progressZone = document.getElementById("progress-zone");
  var progressBar = document.getElementById("progress-bar");
  var progressFill = document.getElementById("progress-fill");
  var progressPct = document.getElementById("progress-pct");
  var dlStatus = document.getElementById("dl-status");

  var ORIGIN =
    location.protocol === "http:" || location.protocol === "https:"
      ? location.origin
      : null;

  var analyzing = false;
  var downloading = false;
  var eventSource = null;
  var streamSettled = false;
  var displayedPercent = 0;

  var QUALITY_BASE_MB = {
    "2160": 480,
    "1440": 320,
    "1080": 150,
    "720": 85,
    "480": 45,
    "360": 26
  };

  var FORMAT_MULT = {
    mp4: 1,
    webm: 0.9,
    mp3: 0.04
  };

  var TINTS = {
    "YouTube": { tint: [255, 84, 84], tint2: [255, 157, 77] },
    "Vimeo": { tint: [84, 200, 255], tint2: [94, 129, 255] },
    "TikTok": { tint: [120, 130, 255], tint2: [255, 94, 178] },
    "Instagram": { tint: [255, 94, 178], tint2: [155, 89, 255] },
    "X / Twitter": { tint: [96, 165, 250], tint2: [122, 125, 255] },
    "Facebook": { tint: [77, 145, 255], tint2: [84, 200, 255] },
    "Dailymotion": { tint: [160, 94, 255], tint2: [84, 200, 255] },
    "Generic": { tint: [84, 200, 255], tint2: [122, 125, 255] }
  };

  var state = {
    platform: "Generic",
    duration: 0,
    quality: "1080",
    format: "mp4",
    session: null
  };

  function isValidUrl(value) {
    var candidate = value.trim();
    if (!candidate) return false;
    if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
    try {
      var parsed = new URL(candidate);
      return parsed.hostname.indexOf(".") > 0;
    } catch (e) {
      return false;
    }
  }

  function formatDuration(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var mm = m < 10 ? "0" + m : String(m);
    var ss = s < 10 ? "0" + s : String(s);
    return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return "";
    var mb = bytesPerSec / 1048576;
    return mb >= 1 ? mb.toFixed(1) + " MB/s" : Math.round(bytesPerSec / 1024) + " KB/s";
  }

  function estimateSize() {
    var base = QUALITY_BASE_MB[state.quality] || 150;
    var mult = FORMAT_MULT[state.format] || 1;
    var durFactor = state.duration > 0 ? Math.min(3, Math.max(0.5, state.duration / 90)) : 1;
    var size = base * mult * durFactor;
    if (state.format === "mp3") return (size * 0.9).toFixed(1) + " MB";
    return Math.round(size) + " MB";
  }

  function setFormStatus(message, kind) {
    formStatus.textContent = message;
    formStatus.className = "status" + (kind ? " is-" + kind : "");
  }

  function getActiveChip(container) {
    var active = container.querySelector(".chip.active");
    return active ? active.getAttribute("data-value") : null;
  }

  function refreshFileSize() {
    state.quality = getActiveChip(qualityChips) || "1080";
    state.format = getActiveChip(formatChips) || "mp4";
    fileSizeEl.textContent = "≈ " + estimateSize();
    var qualityLabel = state.format === "mp3" ? "Audio only" : state.quality + "p";
    resultRes.textContent = qualityLabel;
  }

  function applyAvailableHeights(heights) {
    var chips = Array.prototype.slice.call(qualityChips.querySelectorAll(".chip"));
    var maxH = 0;
    (heights || []).forEach(function (h) {
      if (typeof h === "number" && h > maxH) maxH = h;
    });
    function enableAll() {
      chips.forEach(function (c) {
        c.disabled = false;
        c.removeAttribute("title");
      });
    }
    if (!maxH) {
      enableAll();
      return;
    }
    var anyEnabled = false;
    chips.forEach(function (c) {
      var v = parseInt(c.getAttribute("data-value"), 10) || 0;
      if (v <= maxH) {
        c.disabled = false;
        c.removeAttribute("title");
        anyEnabled = true;
      } else {
        c.disabled = true;
        c.setAttribute("title", "Not available for this video");
      }
    });
    if (!anyEnabled) {
      enableAll();
      return;
    }
    var active = qualityChips.querySelector(".chip.active");
    if (!active || active.disabled) {
      chips.forEach(function (c) {
        c.classList.remove("active");
      });
      var best = null;
      var bestV = -1;
      chips.forEach(function (c) {
        if (c.disabled) return;
        var v = parseInt(c.getAttribute("data-value"), 10) || 0;
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      });
      if (best) best.classList.add("active");
    }
  }

  function bindChipGroup(container) {
    container.addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) return;
      container.querySelectorAll(".chip").forEach(function (c) {
        c.classList.remove("active");
      });
      chip.classList.add("active");
      refreshFileSize();
    });
  }

  function backendUnreachableError(err) {
    if (!ORIGIN) {
      return "Backend required: run “python server.py” in the project folder, then open http://127.0.0.1:8321";
    }
    if (err && err.name === "TypeError") {
      return "Cannot reach the backend server. Is “python server.py” running?";
    }
    return err && err.message ? err.message : "Request failed.";
  }

  function setupAnalysis() {
    analyzing = true;
    analyzeBtn.disabled = true;
    analyzeBtn.classList.add("is-loading");
    analyzeLabel.textContent = "Analyzing…";
    urlInput.disabled = true;
    setFormStatus("Scanning video sources…", "");
  }

  function clearAnalysis() {
    analyzing = false;
    analyzeBtn.disabled = false;
    analyzeBtn.classList.remove("is-loading");
    analyzeLabel.textContent = "Analyze Video";
    urlInput.disabled = false;
  }

  function finishAnalysis(data) {
    clearAnalysis();

    state.platform = data.platform || "Generic";
    state.duration = data.duration || 0;

    resultTitle.textContent = data.title || "Untitled video";
    resultDuration.textContent = formatDuration(state.duration);
    resultPlatform.textContent = state.platform;
    durationBadge.textContent = formatDuration(state.duration);
    platformBadge.textContent = state.platform;

    var palette = TINTS[state.platform] || TINTS.Generic;
    thumb.style.setProperty("--tint-rgb", palette.tint.join(", "));
    thumb.style.setProperty("--tint-2-rgb", palette.tint2.join(", "));

    resetDownloadState();
    resultCard.hidden = false;
    applyAvailableHeights(data.heights);
    refreshFileSize();
    setFormStatus("Video found on " + state.platform + ".", "ok");
    resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function runAnalysis() {
    setupAnalysis();
    try {
      var res = await fetch(ORIGIN + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.value })
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || "Analysis failed (HTTP " + res.status + ").");
      finishAnalysis(data);
    } catch (err) {
      clearAnalysis();
      setFormStatus(backendUnreachableError(err), "error");
    }
  }

  function closeStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function resetDownloadState() {
    closeStream();
    streamSettled = false;
    downloading = false;
    displayedPercent = 0;
    state.session = null;
    downloadBtn.disabled = false;
    downloadLabel.textContent = "Download";
    resetBtn.classList.add("hidden");
    progressZone.hidden = true;
    progressFill.style.width = "0%";
    progressBar.setAttribute("aria-valuenow", "0");
    progressPct.textContent = "0%";
    dlStatus.textContent = "Preparing…";
    dlStatus.className = "status";
  }

  function phaseText(percent) {
    if (percent < 5) return "Fetching stream…";
    if (percent < 95) return "Downloading…";
    return "Finishing…";
  }

  async function startDownload() {
    if (downloading) return;
    downloading = true;
    streamSettled = false;
    downloadBtn.disabled = true;
    downloadLabel.textContent = "Starting…";
    progressZone.hidden = false;
    resetBtn.classList.add("hidden");
    progressFill.style.width = "0%";
    progressPct.textContent = "0%";
    dlStatus.textContent = "Contacting server…";
    dlStatus.className = "status";
    displayedPercent = 0;
    try {
      var res = await fetch(ORIGIN + "/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.value, quality: state.quality, format: state.format })
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || "Download failed to start.");
      streamProgress(data.session);
    } catch (err) {
      failDownload(backendUnreachableError(err));
    }
  }

  function streamProgress(session) {
    state.session = session;
    closeStream();
    eventSource = new EventSource(ORIGIN + "/api/events?session=" + session);
    eventSource.addEventListener("progress", function (e) {
      var d = JSON.parse(e.data);
      var p = d.percent || 0;
      if (p > displayedPercent) displayedPercent = p;
      var shown = Math.min(100, displayedPercent);
      var rounded = Math.floor(shown);
      progressFill.style.width = shown + "%";
      progressPct.textContent = rounded + "%";
      progressBar.setAttribute("aria-valuenow", String(rounded));
      var speed = d.speed ? " · " + formatSpeed(d.speed) : "";
      dlStatus.textContent = phaseText(shown) + speed;
    });
    eventSource.addEventListener("done", function (e) {
      var d = JSON.parse(e.data);
      streamSettled = true;
      closeStream();
      completeDownload(d);
    });
    eventSource.addEventListener("failed", function (e) {
      var d = JSON.parse(e.data);
      streamSettled = true;
      closeStream();
      failDownload(d.message || "Download failed.");
    });
    eventSource.onerror = function () {
      if (streamSettled) return;
      dlStatus.textContent = "Connection interrupted — retrying…";
    };
  }

  function heightNote(d) {
    if (state.format === "mp3" || !d.height) return "";
    if (String(d.height) === state.quality) return "";
    return d.height + "p delivered (" + state.quality + "p not available for this video)";
  }

  function completeDownload(d) {
    downloading = false;
    downloadBtn.disabled = false;
    downloadLabel.textContent = "Ready ✓";
    resetBtn.classList.remove("hidden");
    progressFill.style.width = "100%";
    progressPct.textContent = "100%";
    progressBar.setAttribute("aria-valuenow", "100");
    var note = heightNote(d);
    dlStatus.textContent =
      "Download complete" + (note ? " — " + note : "") + ". " + (d.filename || "File saved.");
    dlStatus.className = "status is-ok";
    var link = document.createElement("a");
    link.href = ORIGIN + "/api/file?session=" + state.session;
    link.download = d.filename || "video";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function failDownload(message) {
    downloading = false;
    downloadBtn.disabled = false;
    downloadLabel.textContent = "Download";
    dlStatus.textContent = message;
    dlStatus.className = "status is-error";
  }

  function resetAll() {
    resetDownloadState();
    resultCard.hidden = true;
    urlInput.value = "";
    urlInput.focus();
    setFormStatus("", "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function pasteFromClipboard() {
    urlInput.focus();
    try {
      var text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        setFormStatus("Link pasted from clipboard.", "ok");
      } else {
        setFormStatus("Clipboard is empty.", "error");
      }
    } catch (err) {
      setFormStatus("Clipboard access blocked — paste manually (Ctrl+V).", "error");
    }
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (analyzing || downloading) return;
    if (!isValidUrl(urlInput.value)) {
      inputWrap.classList.remove("error");
      void inputWrap.offsetWidth;
      inputWrap.classList.add("error");
      setFormStatus("Please enter a valid video URL.", "error");
      urlInput.focus();
      return;
    }
    inputWrap.classList.remove("error");
    formStatus.className = "status";
    formStatus.textContent = "";
    runAnalysis();
  });

  inputWrap.addEventListener("animationend", function () {
    inputWrap.classList.remove("error");
  });

  urlInput.addEventListener("input", function () {
    formStatus.className = "status";
    formStatus.textContent = "";
  });

  pasteBtn.addEventListener("click", pasteFromClipboard);
  downloadBtn.addEventListener("click", startDownload);
  resetBtn.addEventListener("click", resetAll);
  bindChipGroup(qualityChips);
  bindChipGroup(formatChips);

  refreshFileSize();
})();
