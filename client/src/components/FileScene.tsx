import { useEffect, useRef } from "react";
import * as THREE from "three";

// The Bureau file in the hero, as an object: an open folder with one sheet for
// each thing the hero says is on every file. The sheet that is picked rises out
// of the folder. The hero's own buttons are moved onto the sheets' tabs, so the
// words stay in the page and the scene only gives them somewhere to stand.
//
// The sheets carry ruled bars, not writing: this is an illustration, and it
// shows no data, real or invented. The folder's slow turn means nothing.
//
// Without WebGL nothing is drawn and the hero keeps its picture and its rings.

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  turn: true, // the folder turns a little, back and forth
  parallax: true, // and leans a little toward the pointer
  glow: true, // a light on the sheet that is picked
};

const LIME = 0xd0ee85;
const SHEET = { w: 3.9, h: 2 };

function sheetTexture(seed: number) {
  const c = document.createElement("canvas");
  c.width = 600;
  c.height = 500;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const draw = () => {
    const g = c.getContext("2d")!;
    g.fillStyle = "#1b271e";
    g.fillRect(0, 0, 600, 500);
    // Ruled bars where a file's lines would be. They stand for lines; they are not lines.
    let s = seed;
    const next = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    for (let row = 0; row < 9; row++) {
      const y = 56 + row * 40;
      g.fillStyle = "#d0ee8566";
      g.fillRect(36, y, 10, 10);
      g.fillStyle = "#e9efdf2e";
      g.fillRect(62, y, 150 + next() * 250, 10);
      g.fillStyle = "#e9efdf16";
      g.fillRect(460, y, 104, 10);
    }
    t.needsUpdate = true;
  };
  draw();
  document.fonts?.ready.then(draw);
  return t;
}

function coverTexture() {
  const c = document.createElement("canvas");
  c.width = 680;
  c.height = 300;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const draw = () => {
    const g = c.getContext("2d")!;
    g.fillStyle = "#16221a";
    g.fillRect(0, 0, 680, 300);
    g.strokeStyle = "#d0ee8540";
    g.lineWidth = 2;
    g.strokeRect(14, 14, 652, 272);
    g.fillStyle = "#d0ee85";
    g.font = '150px "DM Serif Display", serif';
    g.fillText("B", 56, 200);
    g.fillStyle = "#c0cfb4";
    g.font = '500 34px "IBM Plex Mono", monospace';
    g.fillText("THE BUREAU", 196, 128);
    g.fillText("FILE", 196, 176);
    t.needsUpdate = true;
  };
  draw();
  document.fonts?.ready.then(draw);
  return t;
}

export default function FileScene({
  labels,
  active,
  onPick,
  onDrawn,
}: {
  labels: string[];
  active: number;
  onPick: (index: number) => void;
  onDrawn: (drawn: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(active);
  const pick = useRef(onPick);
  const sync = useRef<() => void>(() => {});
  latest.current = active;
  pick.current = onPick;
  const key = labels.join("|");

  useEffect(() => {
    const el = host.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);
    onDrawn(true);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1.2, 0.1, 60);
    scene.add(new THREE.HemisphereLight(0xe6f2d8, 0x0d1410, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-3, 5, 6);
    scene.add(sun);
    const lamp = new THREE.PointLight(LIME, 0, 7);
    scene.add(lamp);

    const file = new THREE.Group();
    scene.add(file);

    // The folder: a back, a lower front with the name on it, and a floor.
    const board = new THREE.MeshStandardMaterial({
      color: 0x1d2b20,
      roughness: 0.6,
      metalness: 0.1,
    });
    const back = new THREE.Mesh(new THREE.BoxGeometry(4.0, 2.1, 0.06), board);
    back.position.set(0, 1.05, -0.5);
    const front = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.25, 0.06), [
      board,
      board,
      board,
      board,
      new THREE.MeshStandardMaterial({ map: coverTexture(), roughness: 0.6 }),
      board,
    ]);
    front.position.set(0, 0.625, 0.5);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.06, 1.06), board);
    const edge = new THREE.LineBasicMaterial({
      color: LIME,
      transparent: true,
      opacity: 0.35,
    });
    for (const part of [back, front]) {
      part.add(
        new THREE.LineSegments(new THREE.EdgesGeometry(part.geometry), edge)
      );
    }
    file.add(back, front, floor);

    // One sheet a label, each with its tab at a different place along the top.
    const n = labels.length;
    const targets: THREE.Mesh[] = [];
    const paper = new THREE.BoxGeometry(SHEET.w, SHEET.h, 0.02);
    const tabGeo = new THREE.BoxGeometry(1.42, 0.36, 0.02);
    const sheets = labels.map((_, i) => {
      const group = new THREE.Group();
      const plain = new THREE.MeshStandardMaterial({
        color: 0x1b271e,
        roughness: 0.7,
      });
      const face = new THREE.MeshStandardMaterial({
        map: sheetTexture(17 + i * 31),
        roughness: 0.7,
        emissive: LIME,
        emissiveIntensity: 0,
      });
      const sheet = new THREE.Mesh(paper, [
        plain,
        plain,
        plain,
        plain,
        face,
        plain,
      ]);
      const tab = new THREE.Mesh(tabGeo, plain);
      const tabX = n < 2 ? 0 : -1.2 + (2.4 * i) / (n - 1);
      tab.position.set(tabX, SHEET.h / 2 + 0.14, 0);
      const rim = new THREE.LineSegments(
        new THREE.EdgesGeometry(paper),
        new THREE.LineBasicMaterial({
          color: LIME,
          transparent: true,
          opacity: 0.25,
        })
      );
      group.add(sheet, tab, rim);
      const z = 0;
      for (const mesh of [sheet, tab]) {
        mesh.userData.index = i;
        targets.push(mesh);
      }
      file.add(group);
      return { group, face, rim, tabX, y: 0, z };
    });

    let dirty = true;
    let visible = false;
    let stopped = false;
    const lean = { x: 0, y: 0, tx: 0, ty: 0 };
    sync.current = () => {
      dirty = true;
    };

    function resize() {
      const w = el!.clientWidth;
      const h = el!.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const half = Math.tan((camera.fov * Math.PI) / 360);
      // Near enough that a button is no wider than the tab it stands on.
      const dist = Math.max(2.7 / (half * camera.aspect), 2.55 / half);
      camera.position.set(0, 2.5, dist);
      camera.lookAt(0, 1.52, 0);
      camera.updateProjectionMatrix();
      dirty = true;
    }

    // The hero's own buttons stand on the tabs.
    const buttons = [...stage.querySelectorAll<HTMLElement>(".agent-node")];
    const point = new THREE.Vector3();
    function place(t: number, dt: number) {
      const on = latest.current;
      let moving = false;
      // The picked sheet stands at the back of the folder, tallest. The others stand in front of
      // it in their own order, each a step lower than the one behind, so every sheet shows.
      let place = 0;
      const resting = sheets.length - 1;
      sheets.forEach((s, i) => {
        const step = i === on ? resting : place++;
        const to = SHEET.h / 2 + 0.2 + (i === on ? 1.12 : step * 0.46);
        const toZ = 0.3 - (0.6 * step) / Math.max(1, resting);
        const first = s.y === 0;
        s.y = still || first ? to : s.y + (to - s.y) * Math.min(1, dt * 6);
        s.z = still || first ? toZ : s.z + (toZ - s.z) * Math.min(1, dt * 6);
        if (Math.abs(to - s.y) > 0.002 || Math.abs(toZ - s.z) > 0.002)
          moving = true;
        s.group.position.set(0, s.y, s.z);
        s.face.emissiveIntensity = i === on ? 0.07 : 0;
        s.rim.material.opacity = i === on ? 0.9 : 0.25;
      });
      const picked = sheets[on];
      if (picked && CONFIG.glow) {
        lamp.intensity = 5;
        lamp.position.set(
          picked.tabX * 0.4,
          picked.y + 0.6,
          picked.group.position.z + 1.6
        );
      } else lamp.intensity = 0;
      const turn = CONFIG.turn && !still ? Math.sin(t * 0.35) * 0.07 : 0;
      file.rotation.set(-0.06 + lean.y * 0.05, -0.24 + turn + lean.x * 0.12, 0);
      file.updateMatrixWorld(true);
      buttons.forEach((button, i) => {
        const s = sheets[i];
        if (!s) return;
        point.set(s.tabX, SHEET.h / 2 + 0.17, 0);
        s.group.localToWorld(point).project(camera);
        button.style.left = `${((point.x + 1) / 2) * el!.clientWidth}px`;
        button.style.top = `${((1 - point.y) / 2) * el!.clientHeight}px`;
        button.style.right = "auto";
        button.style.bottom = "auto";
      });
      return moving;
    }

    // ---- pointer ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function find(ev: MouseEvent): number | null {
      const box = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - box.left) / box.width) * 2 - 1,
        -((ev.clientY - box.top) / box.height) * 2 + 1
      );
      ray.setFromCamera(ndc, camera);
      return (
        (ray.intersectObjects(targets, false)[0]?.object.userData
          .index as number) ?? null
      );
    }
    function onMove(ev: PointerEvent) {
      const box = canvas.getBoundingClientRect();
      if (CONFIG.parallax) {
        lean.tx = ((ev.clientX - box.left) / box.width) * 2 - 1;
        lean.ty = ((ev.clientY - box.top) / box.height) * 2 - 1;
      }
      if (ev.pointerType === "mouse")
        canvas.classList.toggle("is-pick", find(ev) !== null);
      dirty = true;
    }
    function onLeave() {
      lean.tx = lean.ty = 0;
      canvas.classList.remove("is-pick");
      dirty = true;
    }
    function onClick(ev: MouseEvent) {
      const index = find(ev);
      if (index !== null) pick.current(index);
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);

    let before: number | null = null;
    let busy = true;
    function frame(ms: number) {
      if (stopped) return;
      requestAnimationFrame(frame);
      if (!visible) {
        before = null;
        return;
      }
      const dt = before === null ? 0 : Math.min(0.05, (ms - before) / 1000);
      before = ms;
      lean.x += (lean.tx - lean.x) * Math.min(1, dt * 4);
      lean.y += (lean.ty - lean.y) * Math.min(1, dt * 4);
      const settling =
        Math.abs(lean.tx - lean.x) > 0.001 ||
        Math.abs(lean.ty - lean.y) > 0.001;
      // With reduced motion nothing moves by itself: the file is drawn when something changes.
      if (still && !dirty && !busy && !settling) return;
      busy = place(ms / 1000, dt);
      dirty = false;
      renderer.render(scene, camera);
    }

    resize();
    const sized = new ResizeObserver(resize);
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    sized.observe(el);
    seen.observe(el);
    requestAnimationFrame(frame);

    return () => {
      stopped = true;
      sized.disconnect();
      seen.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      renderer.dispose();
      canvas.remove();
      for (const button of buttons) {
        button.style.left =
          button.style.top =
          button.style.right =
          button.style.bottom =
            "";
      }
      sync.current = () => {};
      onDrawn(false);
    };
    // Built once for the hero's labels; which sheet is picked is read each frame.
  }, [key]);

  useEffect(() => sync.current(), [active]);

  return <div className="file-scene" ref={host} />;
}
