const ROUTE_URL = "../../assets/brand/luxora-loader-route.svg";
const ROUTE_SAMPLE_COUNT = 420;
const REVOLUTION_MS = 1800;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function pathMetrics(points) {
  const lengths = [0];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += Math.hypot(next.x - current.x, next.y - current.y);
    lengths.push(total);
  }
  return { lengths, total };
}

function samplePath(points, metrics, fraction) {
  const normalized = ((fraction % 1) + 1) % 1;
  const target = normalized * metrics.total;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (metrics.lengths[middle] <= target) low = middle;
    else high = middle - 1;
  }
  const current = points[low];
  const next = points[(low + 1) % points.length];
  const segmentStart = metrics.lengths[low];
  const segmentEnd = metrics.lengths[low + 1];
  const local = segmentEnd === segmentStart ? 0 : (target - segmentStart) / (segmentEnd - segmentStart);
  return {
    x: current.x + (next.x - current.x) * local,
    y: current.y + (next.y - current.y) * local
  };
}

async function loadRoute() {
  const response = await fetch(ROUTE_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Luxora route request failed: ${response.status}`);
  const svgDocument = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
  if (svgDocument.querySelector("parsererror")) throw new Error("Luxora route SVG is invalid");
  const source = svgDocument.querySelector("[data-luxora-loader-route]");
  const data = source?.getAttribute("d");
  if (!data) throw new Error("Luxora route path is missing");

  const geometry = document.createElementNS(SVG_NAMESPACE, "path");
  geometry.setAttribute("d", data);
  const total = geometry.getTotalLength();
  if (!Number.isFinite(total) || total <= 0) throw new Error("Luxora route path has no length");

  const points = [];
  for (let index = 0; index < ROUTE_SAMPLE_COUNT; index += 1) {
    const point = geometry.getPointAtLength(total * index / ROUTE_SAMPLE_COUNT);
    points.push({ x: point.x, y: point.y });
  }
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return {
    points,
    bounds: {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys)
    }
  };
}

class LuxoraContourLoader {
  constructor(canvas, route) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.rawPoints = route.points;
    this.bounds = route.bounds;
    this.mediaReduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.forceReduced = false;
    this.visible = !document.hidden;
    this.frame = 0;
    this.resize = this.resize.bind(this);
    this.animate = this.animate.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    document.addEventListener("visibilitychange", () => {
      this.visible = !document.hidden;
      if (this.visible && !this.frame) this.frame = requestAnimationFrame(this.animate);
    });
    this.resize();
    this.frame = requestAnimationFrame(this.animate);
  }

  resize() {
    const rectangle = this.canvas.getBoundingClientRect();
    const deviceScale = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rectangle.width * deviceScale));
    const height = Math.max(1, Math.round(rectangle.height * deviceScale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const contentSize = Math.min(width, height) * 0.67;
    const sourceWidth = this.bounds.maxX - this.bounds.minX;
    const sourceHeight = this.bounds.maxY - this.bounds.minY;
    const scale = contentSize / Math.max(sourceWidth, sourceHeight);
    const offsetX = width / 2 - ((this.bounds.minX + this.bounds.maxX) / 2) * scale;
    const offsetY = height / 2 - ((this.bounds.minY + this.bounds.maxY) / 2) * scale;
    this.points = this.rawPoints.map(({ x, y }) => ({ x: x * scale + offsetX, y: y * scale + offsetY }));
    this.metrics = pathMetrics(this.points);
    this.transform = { width, height };
  }

  setReducedMotion(value) {
    this.forceReduced = value;
  }

  drawRay(context, fraction, isDark, accent) {
    const sampleCount = 28;
    const pathStep = 0.0035;
    const pixelScale = Math.max(1, this.transform.width / 720);
    const samples = [];
    for (let index = sampleCount; index >= 0; index -= 1) {
      samples.push(samplePath(this.points, this.metrics, fraction - index * pathStep));
    }

    context.lineCap = "round";
    context.lineJoin = "round";
    for (let index = 1; index < samples.length; index += 1) {
      const progress = index / (samples.length - 1);
      const opacity = Math.pow(progress, 2.2) * (isDark ? 0.9 : 0.78);
      const previous = samples[index - 1];
      const current = samples[index];
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      context.lineWidth = (0.8 + progress * 3.8) * pixelScale;
      if (isDark) {
        context.strokeStyle = `rgba(${accent.join(",")},${opacity})`;
        context.shadowBlur = 4 + progress * 17;
        context.shadowColor = `rgb(${accent.join(",")})`;
      } else {
        context.strokeStyle = `rgba(0,0,0,${opacity})`;
        context.shadowBlur = 0;
      }
      context.stroke();
    }

    const head = samples[samples.length - 1];
    context.beginPath();
    context.arc(head.x, head.y, 4.8 * pixelScale, 0, Math.PI * 2);
    context.fillStyle = isDark ? "#ffffff" : "#000000";
    context.shadowBlur = isDark ? 20 : 0;
    context.shadowColor = isDark ? `rgb(${accent.join(",")})` : "transparent";
    context.fill();
    context.shadowBlur = 0;
  }

  render(timestamp) {
    const { width, height } = this.transform;
    const context = this.context;
    const isDark = document.documentElement.dataset.theme !== "light";
    const reduced = this.forceReduced || this.mediaReduced.matches;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = isDark ? "#000000" : "#ffffff";
    context.fillRect(0, 0, width, height);

    const phase = reduced ? 0.04 : (timestamp % REVOLUTION_MS) / REVOLUTION_MS;
    this.drawRay(context, phase, isDark, [157, 124, 255]);
    this.drawRay(context, phase + 0.5, isDark, [74, 167, 255]);
  }

  animate(timestamp) {
    this.frame = 0;
    if (!this.visible) return;
    this.render(timestamp);
    this.frame = requestAnimationFrame(this.animate);
  }
}

async function start() {
  const parameters = new URLSearchParams(location.search);
  const startsLight = parameters.get("theme") === "light";
  const startsReduced = parameters.get("motion") === "reduced";
  if (startsLight) document.documentElement.dataset.theme = "light";
  const route = await loadRoute();
  const canvas = document.querySelector(".luxora-loader__canvas");
  const loader = new LuxoraContourLoader(canvas, route);
  const themeButton = document.querySelector("[data-theme-button]");
  const motionButton = document.querySelector("[data-motion-button]");
  themeButton.setAttribute("aria-pressed", String(startsLight));
  themeButton.textContent = startsLight ? "Тёмный фон" : "Светлый фон";
  motionButton.setAttribute("aria-pressed", String(startsReduced));
  loader.setReducedMotion(startsReduced);

  themeButton.addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    themeButton.setAttribute("aria-pressed", String(light));
    themeButton.textContent = light ? "Тёмный фон" : "Светлый фон";
  });
  motionButton.addEventListener("click", () => {
    const reduced = motionButton.getAttribute("aria-pressed") !== "true";
    motionButton.setAttribute("aria-pressed", String(reduced));
    loader.setReducedMotion(reduced);
  });
}

start().catch((error) => {
  document.querySelector(".luxora-loader").setAttribute("aria-label", "Не удалось загрузить фирменную анимацию");
  console.error(error);
});
