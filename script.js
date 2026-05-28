/**
 * Miles Clock — generative segment timepiece
 * Spinning line segments; rotation direction encodes a 4×6 bitmap font.
 */

const CONFIG = {
  digitCount: 4,
  baseRows: 8,
  baseCols: 6,
  glyphRows: 6,
  glyphCols: 4,
  maxRpm: 120,
  maxResolution: 4,
  digitWidth: 198,
  digitHeight: 268,
  digitGap: 48,
  segmentLength: 18,
  strokeWidth: 2.4,
  insetX: 22,
  insetY: 22,
  framePadding: 8,
  frameRadius: 12,
  motion: {
    velocitySmoothing: 4.2,
    spinInertia: 5.5,
    directionBlend: 8,
    maxDelta: 0.05,
  },
  render: {
    glowBlur: 6,
    glowAlpha: 0.35,
    frameOpacity: 0.55,
  },
  presets: {
    ambient: { rpm: 36, resolution: 2, phaseMode: "random" },
    studio: { rpm: 42, resolution: 2, phaseMode: "random" },
    installation: { rpm: 8, resolution: 2, phaseMode: "aligned", digitGap: 64 },
  },
  mobileBreakpoint: 640,
  mobileRowGap: 36,
};

const mobileLayoutQuery = window.matchMedia(
  `(max-width: ${CONFIG.mobileBreakpoint}px)`
);

const FONT_DIGITS = {
  0: ["1111", "1001", "1001", "1001", "1001", "1111"],
  1: ["0010", "0110", "0010", "0010", "0010", "0111"],
  2: ["1111", "0001", "0011", "1100", "1000", "1111"],
  3: ["1111", "0001", "0111", "0001", "0001", "1111"],
  4: ["1001", "1001", "1111", "0001", "0001", "0001"],
  5: ["1111", "1000", "1111", "0001", "0001", "1111"],
  6: ["1111", "1000", "1111", "1001", "1001", "1111"],
  7: ["1111", "0001", "0010", "0010", "0100", "0100"],
  8: ["1111", "1001", "1111", "1001", "1001", "1111"],
  9: ["1111", "1001", "1001", "1111", "0001", "1111"],
};

const state = {
  mode: "ambient",
  resolution: 2,
  targetRpm: 36,
  currentRpm: 0,
  paused: false,
  palette: "graphite",
  directionHints: false,
  phaseMode: "random",
  studioOpen: false,
  cells: [],
  cwCells: [],
  ccwCells: [],
  frames: [],
  metrics: null,
  activeTimeKey: "",
  spinAngle: 0,
  spinVelocity: 0,
  lastFrameTime: null,
  staticLayer: null,
  digitGapOverride: null,
  hourFormat: "12",
};

const dom = {
  body: document.body,
  canvas: document.getElementById("segment-display"),
  studioTrigger: document.getElementById("studio-trigger"),
  studioClose: document.getElementById("studio-close"),
  studioPanel: document.getElementById("studio-panel"),
  resolutionSlider: document.getElementById("resolution-slider"),
  resolutionValue: document.getElementById("resolution-value"),
  speedSlider: document.getElementById("speed-slider"),
  speedValue: document.getElementById("speed-value"),
  paletteSelect: document.getElementById("palette-select"),
  displayStats: document.getElementById("display-stats"),
  hintControl: document.getElementById("hint-control"),
  timeReadout: document.getElementById("time-readout"),
  randomizePhases: document.getElementById("randomize-phases"),
  alignPhases: document.getElementById("align-phases"),
  modeButtons: document.querySelectorAll(".mode-btn"),
  hourToggle: document.getElementById("hour-toggle"),
};

const ctx =
  dom.canvas.getContext("2d", { alpha: true, desynchronized: true }) ??
  dom.canvas.getContext("2d");

const faviconCanvas = document.createElement("canvas");
faviconCanvas.width = 64;
faviconCanvas.height = 64;
const faviconCtx = faviconCanvas.getContext("2d");
let lastFaviconLabel = "";

/* —— Utilities —— */

function readCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function normalizeDegrees(value) {
  const n = value % 360;
  return n < 0 ? n + 360 : n;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function expSmooth(current, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  return current + (target - current) * t;
}

function getLocalTimeParts() {
  const now = new Date();
  return {
    now,
    h24: String(now.getHours()).padStart(2, "0"),
    m: String(now.getMinutes()).padStart(2, "0"),
  };
}

function getDisplayHours() {
  const { now } = getLocalTimeParts();
  if (state.hourFormat === "24") {
    return String(now.getHours()).padStart(2, "0");
  }
  let h = now.getHours() % 12;
  if (h === 0) h = 12;
  return String(h).padStart(2, "0");
}

/** Four digit string HHMM — left to right on display */
function getTimeDigits() {
  const { m } = getLocalTimeParts();
  return `${getDisplayHours()}${m}`;
}

function getFormattedTime() {
  const { m } = getLocalTimeParts();
  return `${getDisplayHours()}:${m}`;
}

function getPalette() {
  return {
    stroke: readCssVar("--stroke"),
    strokeDim: readCssVar("--stroke-dim"),
    strokeGlow: readCssVar("--stroke-glow"),
    frame: readCssVar("--frame"),
    hintCw: readCssVar("--hint-cw"),
    hintCcw: readCssVar("--hint-ccw"),
  };
}

/* —— Layout —— */

function getDigitGap() {
  if (state.digitGapOverride != null) return state.digitGapOverride;
  return CONFIG.digitGap;
}

function isStackedLayout() {
  return mobileLayoutQuery.matches;
}

/** Digit block top-left (canvas coordinates) */
function getDigitOrigin(digitIndex, metrics) {
  if (metrics.layout === "stacked") {
    const col = digitIndex % 2;
    const row = Math.floor(digitIndex / 2);
    return {
      x: CONFIG.framePadding + col * (CONFIG.digitWidth + metrics.digitGap),
      y:
        CONFIG.framePadding +
        row * (CONFIG.digitHeight + metrics.rowGap),
    };
  }

  return {
    x: CONFIG.framePadding + digitIndex * (CONFIG.digitWidth + metrics.digitGap),
    y: CONFIG.framePadding,
  };
}

function getMetrics() {
  const scale = state.resolution;
  const rows = CONFIG.baseRows * scale;
  const cols = CONFIG.baseCols * scale;
  const digitGap = getDigitGap();
  const stacked = isStackedLayout();
  const rowGap = stacked ? CONFIG.mobileRowGap : 0;
  const pairWidth = CONFIG.digitWidth * 2 + digitGap;

  const viewWidth = stacked
    ? pairWidth + CONFIG.framePadding * 2
    : CONFIG.digitWidth * CONFIG.digitCount +
      digitGap * (CONFIG.digitCount - 1) +
      CONFIG.framePadding * 2;

  const viewHeight = stacked
    ? CONFIG.digitHeight * 2 + rowGap + CONFIG.framePadding * 2
    : CONFIG.digitHeight + CONFIG.framePadding * 2;

  return {
    scale,
    rows,
    cols,
    digitGap,
    rowGap,
    layout: stacked ? "stacked" : "row",
    glyphRowOffset: Math.floor((rows - CONFIG.glyphRows * scale) / 2),
    glyphColOffset: Math.floor((cols - CONFIG.glyphCols * scale) / 2),
    cellWidth: (CONFIG.digitWidth - CONFIG.insetX * 2) / Math.max(cols - 1, 1),
    cellHeight:
      (CONFIG.digitHeight - CONFIG.insetY * 2) / Math.max(rows - 1, 1),
    segmentLength: Math.max(2.5, CONFIG.segmentLength / Math.sqrt(scale)),
    strokeWidth: Math.max(0.65, CONFIG.strokeWidth / Math.sqrt(scale)),
    viewWidth,
    viewHeight,
  };
}

function isGlyphPixelOn(digit, row, col, metrics) {
  const glyphRow = row - metrics.glyphRowOffset;
  const glyphCol = col - metrics.glyphColOffset;

  if (
    glyphRow < 0 ||
    glyphRow >= CONFIG.glyphRows * metrics.scale ||
    glyphCol < 0 ||
    glyphCol >= CONFIG.glyphCols * metrics.scale
  ) {
    return false;
  }

  const fontRow = Math.floor(glyphRow / metrics.scale);
  const fontCol = Math.floor(glyphCol / metrics.scale);
  return FONT_DIGITS[digit][fontRow][fontCol] === "1";
}

function pathRoundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
}

/* —— Canvas —— */

function configureCanvas(metrics) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.round(metrics.viewWidth * dpr);
  const h = Math.round(metrics.viewHeight * dpr);

  if (dom.canvas.width !== w || dom.canvas.height !== h) {
    dom.canvas.width = w;
    dom.canvas.height = h;
    state.staticLayer = null;
  }

  dom.canvas.style.aspectRatio = `${metrics.viewWidth} / ${metrics.viewHeight}`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function updateDisplayMeta(metrics) {
  const total = metrics.rows * metrics.cols * CONFIG.digitCount;
  dom.resolutionValue.textContent = `${state.resolution}×`;
  dom.speedValue.textContent = String(Math.round(state.targetRpm));
  dom.displayStats.textContent = `${metrics.cols}×${metrics.rows} · ${total.toLocaleString()} segments`;
}

/* —— Phases —— */

function applyPhaseMode() {
  if (state.phaseMode === "random") {
    state.cells.forEach((cell) => {
      cell.phaseOffset = Math.random() * 360;
    });
    return;
  }
  state.cells.forEach((cell) => {
    cell.phaseOffset = 0;
  });
}

function randomizePhases() {
  state.phaseMode = "random";
  applyPhaseMode();
  drawDisplay();
}

function alignPhases() {
  state.phaseMode = "aligned";
  applyPhaseMode();
  drawDisplay();
}

/* —— Display graph —— */

function buildDisplay() {
  const metrics = getMetrics();

  state.cells = [];
  state.cwCells = [];
  state.ccwCells = [];
  state.frames = [];
  state.metrics = metrics;
  state.activeTimeKey = "";
  state.staticLayer = null;

  configureCanvas(metrics);

  dom.body.dataset.layout = metrics.layout;

  for (let index = 0; index < CONFIG.digitCount; index += 1) {
    const { x: originX, y: originY } = getDigitOrigin(index, metrics);

    state.frames.push({
      x: originX - CONFIG.framePadding,
      y: originY - CONFIG.framePadding,
      width: CONFIG.digitWidth + CONFIG.framePadding * 2,
      height: CONFIG.digitHeight + CONFIG.framePadding * 2,
      radius: CONFIG.frameRadius,
    });

    for (let row = 0; row < metrics.rows; row += 1) {
      for (let col = 0; col < metrics.cols; col += 1) {
        state.cells.push({
          cx: originX + CONFIG.insetX + col * metrics.cellWidth,
          cy: originY + CONFIG.insetY + row * metrics.cellHeight,
          digitIndex: index,
          row,
          col,
          direction: null,
          targetDirection: 0,
          displayDirection: 0,
          phaseOffset: 0,
        });
      }
    }
  }

  state.staticLayer = createStaticLayer(metrics);
  applyPhaseMode();
  updateTimeMask(getTimeDigits(), metrics);
  updateDisplayMeta(metrics);
  drawDisplay();
}

function updateTimeMask(timeKey, metrics = state.metrics ?? getMetrics(), force = false) {
  if (!force && timeKey === state.activeTimeKey) return;

  state.activeTimeKey = timeKey;
  state.cwCells = [];
  state.ccwCells = [];

  state.cells.forEach((cell) => {
    const digit = timeKey[cell.digitIndex];
    const nextDirection = isGlyphPixelOn(digit, cell.row, cell.col, metrics) ? 1 : -1;

    if (cell.direction !== null && cell.direction !== nextDirection) {
      if (state.phaseMode !== "aligned") {
        cell.phaseOffset = normalizeDegrees(
          cell.phaseOffset + (cell.direction - nextDirection) * state.spinAngle
        );
      }
    }

    if (state.phaseMode === "aligned") {
      cell.phaseOffset = 0;
    }

    cell.targetDirection = nextDirection;
    cell.direction = nextDirection;

    if (cell.displayDirection === 0) {
      cell.displayDirection = nextDirection;
    }

    if (cell.direction === 1) state.cwCells.push(cell);
    else state.ccwCells.push(cell);
  });
}

function blendCellDirections(dt) {
  const rate = CONFIG.motion.directionBlend;
  state.cells.forEach((cell) => {
    cell.displayDirection = expSmooth(
      cell.displayDirection,
      cell.targetDirection,
      rate,
      dt
    );
  });
}

function drawFrames(targetContext = ctx) {
  const palette = getPalette();
  targetContext.save();
  targetContext.globalAlpha = CONFIG.render.frameOpacity;
  targetContext.beginPath();

  state.frames.forEach((frame) => {
    pathRoundedRect(
      targetContext,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.radius
    );
  });

  targetContext.fillStyle = palette.frame;
  targetContext.fill();
  targetContext.strokeStyle = palette.frame;
  targetContext.lineWidth = 0.5;
  targetContext.stroke();
  targetContext.restore();
}

function createStaticLayer(metrics) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const layer = document.createElement("canvas");
  const layerCtx = layer.getContext("2d");

  layer.width = dom.canvas.width;
  layer.height = dom.canvas.height;
  layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layerCtx.imageSmoothingEnabled = true;
  layerCtx.lineCap = "round";
  drawFrames(layerCtx);
  return layer;
}

function drawSegments(cells, strokeStyle, useDisplayDirection = false, coloredHints = false) {
  if (cells.length === 0 || !state.metrics) return;

  const palette = getPalette();
  const half = state.metrics.segmentLength / 2;
  const spin = state.spinAngle;
  const { glowBlur, glowAlpha } = CONFIG.render;
  const useGlow = !coloredHints;

  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = state.metrics.strokeWidth;
  if (useGlow) {
    ctx.shadowColor = palette.strokeGlow || strokeStyle;
    ctx.shadowBlur = glowBlur;
    ctx.globalAlpha = glowAlpha;
  }
  ctx.beginPath();

  cells.forEach((cell) => {
    const dir = useDisplayDirection ? cell.displayDirection : cell.direction;
    const angle = degreesToRadians(90 + cell.phaseOffset + dir * spin);
    const dx = half * Math.cos(angle);
    const dy = half * Math.sin(angle);
    ctx.moveTo(cell.cx - dx, cell.cy - dy);
    ctx.lineTo(cell.cx + dx, cell.cy + dy);
  });

  ctx.stroke();
  if (useGlow) {
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
  ctx.beginPath();

  cells.forEach((cell) => {
    const dir = useDisplayDirection ? cell.displayDirection : cell.direction;
    const angle = degreesToRadians(90 + cell.phaseOffset + dir * spin);
    const dx = half * Math.cos(angle);
    const dy = half * Math.sin(angle);
    ctx.moveTo(cell.cx - dx, cell.cy - dy);
    ctx.lineTo(cell.cx + dx, cell.cy + dy);
  });

  ctx.stroke();
  ctx.restore();
}

function drawDisplay() {
  if (!state.metrics) return;

  const palette = getPalette();
  const { viewWidth, viewHeight } = state.metrics;

  ctx.clearRect(0, 0, viewWidth, viewHeight);

  if (state.staticLayer) {
    ctx.drawImage(state.staticLayer, 0, 0, viewWidth, viewHeight);
  } else {
    drawFrames();
  }

  const useBlend = true;

  if (!state.directionHints) {
    drawSegments(state.cells, palette.stroke, useBlend);
    return;
  }

  drawSegments(state.ccwCells, palette.hintCcw, useBlend, true);
  drawSegments(state.cwCells, palette.hintCw, useBlend, true);
}

function drawFaviconSegment(context, cx, cy, halfLen, degrees, color) {
  const rad = degreesToRadians(degrees);
  const dx = halfLen * Math.cos(rad);
  const dy = halfLen * Math.sin(rad);
  context.strokeStyle = color;
  context.beginPath();
  context.moveTo(cx - dx, cy - dy);
  context.lineTo(cx + dx, cy + dy);
  context.stroke();
}

function getFaviconHandAngles() {
  const { now } = getLocalTimeParts();
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  return {
    hour: 90 + (h + m / 60) * 30,
    minute: 90 + m * 6,
  };
}

function updateFavicon(force = false) {
  const { now } = getLocalTimeParts();
  const tick = `${now.getHours()}:${now.getMinutes()}`;
  if (!force && tick === lastFaviconLabel) return;
  lastFaviconLabel = tick;

  const link = document.getElementById("favicon");
  if (!link || !faviconCtx) return;

  const size = 64;
  const pad = 2;
  const boxSize = size - pad * 2;
  const cx = size / 2;
  const cy = size / 2;
  const { hour, minute } = getFaviconHandAngles();

  faviconCtx.clearRect(0, 0, size, size);
  faviconCtx.fillStyle = "#080808";
  faviconCtx.fillRect(0, 0, size, size);

  faviconCtx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  faviconCtx.lineWidth = 1.5;
  faviconCtx.strokeRect(pad + 0.75, pad + 0.75, boxSize - 1.5, boxSize - 1.5);

  faviconCtx.lineCap = "round";
  faviconCtx.lineWidth = 2.5;
  drawFaviconSegment(faviconCtx, cx, cy, 16, hour, "#5bb8ff");
  drawFaviconSegment(faviconCtx, cx, cy, 26, minute, "#ff6b7d");

  link.type = "image/png";
  link.href = faviconCanvas.toDataURL("image/png");
}

function syncClock(forceMask = false) {
  const digits = getTimeDigits();
  updateTimeMask(digits, state.metrics ?? undefined, forceMask);

  if (dom.timeReadout) {
    const { now } = getLocalTimeParts();
    const formatted = getFormattedTime();
    dom.timeReadout.textContent = formatted;
    dom.timeReadout.dateTime = now.toISOString();
  }

  updateFavicon();
}

function setHourFormat(format) {
  if (format !== "12" && format !== "24") return;

  state.hourFormat = format;
  dom.body.dataset.hourFormat = format;

  if (dom.hourToggle) {
    dom.hourToggle.setAttribute("aria-pressed", format === "24");
    dom.hourToggle.setAttribute(
      "aria-label",
      format === "12"
        ? "12 hour format. Click to switch to 24 hour."
        : "24 hour format. Click to switch to 12 hour."
    );
  }

  state.activeTimeKey = "";
  syncClock(true);
}

function setDirectionHints(enabled) {
  state.directionHints = enabled;
  dom.body.dataset.hints = enabled ? "on" : "off";

  if (dom.hintControl) {
    dom.hintControl.setAttribute("aria-pressed", String(enabled));
    dom.hintControl.setAttribute(
      "aria-label",
      enabled ? "Color direction hints on" : "Color direction hints off"
    );
  }

  drawDisplay();
}

/* —— Motion —— */

function getTargetDegreesPerSecond() {
  if (state.paused) return 0;
  return state.currentRpm * 6;
}

function stepMotion(dt) {
  const targetRpm = state.paused ? 0 : state.targetRpm;
  state.currentRpm = expSmooth(
    state.currentRpm,
    targetRpm,
    CONFIG.motion.velocitySmoothing,
    dt
  );

  const targetOmega = getTargetDegreesPerSecond();
  state.spinVelocity = expSmooth(
    state.spinVelocity,
    targetOmega,
    CONFIG.motion.spinInertia,
    dt
  );

  state.spinAngle = normalizeDegrees(state.spinAngle + state.spinVelocity * dt);
  blendCellDirections(dt);
}

function animate(frameTime) {
  if (state.lastFrameTime === null) {
    state.lastFrameTime = frameTime;
  }

  const dt = Math.min((frameTime - state.lastFrameTime) / 1000, CONFIG.motion.maxDelta);
  state.lastFrameTime = frameTime;

  stepMotion(dt);
  syncClock();
  drawDisplay();

  requestAnimationFrame(animate);
}

/* —— Modes & UI —— */

function applyModePreset(mode) {
  const preset = CONFIG.presets[mode];
  if (!preset) return;

  state.mode = mode;
  state.targetRpm = preset.rpm;
  state.resolution = preset.resolution;
  state.phaseMode = preset.phaseMode;
  state.digitGapOverride = preset.digitGap ?? null;

  dom.body.dataset.mode = mode;
  dom.speedSlider.value = String(preset.rpm);
  dom.resolutionSlider.value = String(preset.resolution);

  if (preset.phaseMode === "aligned") alignPhases();
  else if (state.phaseMode === "random") applyPhaseMode();

  buildDisplay();
  syncModeButtons();
}

function syncModeButtons() {
  dom.modeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mode === state.mode);
  });
}

function setStudioOpen(open) {
  state.studioOpen = open;
  dom.body.dataset.studio = open ? "open" : "closed";
  dom.studioPanel.hidden = !open;
  dom.studioTrigger.setAttribute("aria-expanded", String(open));

  if (open && state.mode === "ambient") {
    applyModePreset("studio");
  }
}

function setPalette(name) {
  state.palette = name;
  dom.body.dataset.palette = name;
  state.staticLayer = null;
  if (state.metrics) {
    state.staticLayer = createStaticLayer(state.metrics);
  }
  drawDisplay();
}

function bindControls() {
  dom.resolutionSlider.addEventListener("input", (e) => {
    state.resolution = Number(e.target.value);
    buildDisplay();
  });

  dom.speedSlider.addEventListener("input", (e) => {
    state.targetRpm = Number(e.target.value);
    dom.speedValue.textContent = String(state.targetRpm);
  });

  dom.paletteSelect.addEventListener("change", (e) => {
    setPalette(e.target.value);
  });

  dom.hintControl?.addEventListener("click", () => {
    setDirectionHints(!state.directionHints);
  });

  dom.hourToggle?.addEventListener("click", () => {
    setHourFormat(state.hourFormat === "12" ? "24" : "12");
  });

  dom.randomizePhases.addEventListener("click", randomizePhases);
  dom.alignPhases.addEventListener("click", alignPhases);

  dom.studioTrigger.addEventListener("click", () => setStudioOpen(!state.studioOpen));
  dom.studioClose.addEventListener("click", () => setStudioOpen(false));

  dom.modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      applyModePreset(btn.dataset.mode);
      if (btn.dataset.mode !== "ambient") setStudioOpen(true);
      else setStudioOpen(false);
    });
  });

  window.addEventListener("resize", () => {
    if (!state.metrics) return;
    const nextLayout = isStackedLayout() ? "stacked" : "row";
    if (nextLayout !== state.metrics.layout) {
      buildDisplay();
      return;
    }
    configureCanvas(state.metrics);
    state.staticLayer = createStaticLayer(state.metrics);
    drawDisplay();
  });

  mobileLayoutQuery.addEventListener("change", () => {
    if (state.metrics) buildDisplay();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;

    const key = e.key.toLowerCase();

    if (key === "f") {
      e.preventDefault();
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
      return;
    }

    if (key === "s") {
      e.preventDefault();
      if (state.mode === "ambient") {
        applyModePreset("studio");
        setStudioOpen(true);
      } else {
        setStudioOpen(!state.studioOpen);
      }
      return;
    }

    if (key === " ") {
      e.preventDefault();
      state.paused = !state.paused;
      return;
    }

    if (key === "escape") {
      if (state.studioOpen) setStudioOpen(false);
      return;
    }

    if (key === "1") applyModePreset("ambient");
    if (key === "2") applyModePreset("studio");
    if (key === "3") applyModePreset("installation");
    if (key === "r") randomizePhases();
    if (key === "a") alignPhases();
    if (key === "h") setDirectionHints(!state.directionHints);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      state.activeTimeKey = "";
      syncClock(true);
    }
  });
}

function init() {
  dom.resolutionSlider.max = String(CONFIG.maxResolution);
  dom.speedSlider.max = String(CONFIG.maxRpm);
  dom.paletteSelect.value = state.palette;

  setHourFormat(state.hourFormat);
  setDirectionHints(state.directionHints);
  bindControls();
  applyModePreset("ambient");
  setStudioOpen(false);
  syncClock(true);
  updateFavicon(true);
  requestAnimationFrame(animate);
}

init();
