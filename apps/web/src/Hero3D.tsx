import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useLocale, type Locale } from "./i18n";

const SCREEN_TEXT: Record<Locale, { bubbles: Array<{ text: string; mine: boolean }>; input: string; badge: string }> = {
  en: {
    bubbles: [
      { text: "Hello, this is Luxora", mine: false },
      { text: "Clear about what is protected", mine: true },
      { text: "Delivered and read, only when confirmed", mine: false },
      { text: "Calm, fast, honest", mine: true },
    ],
    input: "Write a message…",
    badge: "Beta-0.1 · In development",
  },
  ru: {
    bubbles: [
      { text: "Привет, это Luxora", mine: false },
      { text: "Честно о том, что защищено", mine: true },
      { text: "Доставлено и прочитано — только по факту", mine: false },
      { text: "Спокойно, быстро, честно", mine: true },
    ],
    input: "Написать сообщение…",
    badge: "Beta-0.1 · В разработке",
  },
};

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawScreen(locale: Locale): THREE.CanvasTexture {
  const text = SCREEN_TEXT[locale];
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 1560;
  const g = canvas.getContext("2d")!;

  const bg = g.createLinearGradient(0, 0, 0, canvas.height);
  bg.addColorStop(0, "#15102e");
  bg.addColorStop(1, "#07070d");
  g.fillStyle = bg;
  g.fillRect(0, 0, canvas.width, canvas.height);

  g.fillStyle = "rgba(255,255,255,0.06)";
  g.fillRect(0, 0, canvas.width, 210);
  g.fillStyle = "#ffffff";
  g.font = "700 52px system-ui, sans-serif";
  g.fillText("Luxora", 64, 120);
  g.fillStyle = "#a99bff";
  g.font = "500 30px system-ui, sans-serif";
  g.fillText(text.badge, 64, 168);

  let y = 290;
  for (const b of text.bubbles) {
    const maxW = 470;
    g.font = "500 34px system-ui, sans-serif";
    const words = b.text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const h = 36 + lines.length * 46;
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 48;
    const x = b.mine ? canvas.width - w - 56 : 56;
    roundRect(g, x, y, w, h, 34);
    g.fillStyle = b.mine ? "#6f5bff" : "rgba(255,255,255,0.09)";
    g.fill();
    g.fillStyle = "#ffffff";
    lines.forEach((l, i) => g.fillText(l, x + 24, y + 56 + i * 46));
    y += h + 26;
  }

  g.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(g, 40, canvas.height - 150, canvas.width - 80, 96, 48);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.4)";
  g.font = "500 30px system-ui, sans-serif";
  g.fillText(text.input, 96, canvas.height - 92);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function phoneShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export default function Hero3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const { locale } = useLocale();

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 9);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 4, 6);
    scene.add(key);
    const violet = new THREE.PointLight(0x8b7bff, 25, 20);
    violet.position.set(-4, -2, 3);
    scene.add(violet);
    const blue = new THREE.PointLight(0x2aabee, 18, 20);
    blue.position.set(4, 2, 2);
    scene.add(blue);

    const phone = new THREE.Group();
    const W = 3.2;
    const H = 6.6;
    const R = 0.45;
    const bodyGeo = new THREE.ExtrudeGeometry(phoneShape(W, H, R), {
      depth: 0.22,
      bevelEnabled: true,
      bevelThickness: 0.12,
      bevelSize: 0.12,
      bevelSegments: 6,
      curveSegments: 24,
    });
    const body = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0x17152a, metalness: 0.7, roughness: 0.25 }),
    );
    body.position.z = -0.11;
    phone.add(body);

    const screenTex = drawScreen(locale);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(W - 0.28, H - 0.28),
      new THREE.MeshStandardMaterial({ map: screenTex, roughness: 0.4, metalness: 0 }),
    );
    screen.position.z = 0.13;
    phone.add(screen);
    scene.add(phone);

    const ringGeo = new THREE.TorusGeometry(4.2, 0.02, 12, 160);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0.5 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2.4;
    scene.add(ring);

    const orbs: THREE.Mesh[] = [];
    const orbGeo = new THREE.SphereGeometry(0.12, 24, 24);
    for (let i = 0; i < 26; i++) {
      const color = i % 2 ? 0x8b7bff : 0x2aabee;
      const mesh = new THREE.Mesh(
        orbGeo,
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }),
      );
      const a = (i / 26) * Math.PI * 2;
      const r = 3.6 + (i % 5) * 0.35;
      mesh.position.set(Math.cos(a) * r, Math.sin(a * 1.7) * 2.4, Math.sin(a) * r * 0.4 - 0.5);
      mesh.userData.base = mesh.position.clone();
      mesh.userData.phase = i * 0.7;
      scene.add(mesh);
      orbs.push(mesh);
    }

    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      pointer.y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const start = performance.now();
    const frame = () => {
      const t = (performance.now() - start) / 1000;
      phone.rotation.y += (pointer.x * 0.35 + Math.sin(t * 0.5) * 0.12 - phone.rotation.y) * 0.05;
      phone.rotation.x += (pointer.y * 0.2 - phone.rotation.x) * 0.05;
      phone.position.y = Math.sin(t * 0.8) * 0.12;
      ring.rotation.z = t * 0.12;
      for (const orb of orbs) {
        const base = orb.userData.base as THREE.Vector3;
        const p = orb.userData.phase as number;
        orb.position.y = base.y + Math.sin(t + p) * 0.25;
        orb.position.x = base.x + Math.cos(t * 0.6 + p) * 0.12;
      }
      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    frame();
    if (!reduce) raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      screenTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [locale]);

  return <div className="hero-3d" ref={mountRef} aria-hidden="true" />;
}
