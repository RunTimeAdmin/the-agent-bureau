import { useEffect, useRef } from "react";
import * as THREE from "three";

// The scoreboard as two crews facing each other: one figure for every case
// finished on each side, people in hats on the left and machines on the right.
// A figure is green, with a ring over its head, if that case ended with the
// mole caught, and red if the mole got away. Which figure is which case is not shown, and where a figure
// stands in its crew means nothing: the caught ones simply stand nearest the line.
//
// It draws only the two counts the scoreboard already prints for each side.
// The figures' slow bob is decoration.
//
// Without WebGL nothing is drawn and the scoreboard reads as it did before.

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  bob: true, // the figures rise and fall a little
  parallax: true, // the view leans a little toward the pointer
  most: 24, // at most this many figures are drawn on a side
};

export type ArenaSide = { finished: number; solved: number };

const CAUGHT = 0x45ff2e;
const LOST = 0xff6b6b;

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,.9)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export default function Arena({
  humans,
  agents,
}: {
  humans: ArenaSide;
  agents: ArenaSide;
}) {
  const host = useRef<HTMLDivElement>(null);
  const key = `${humans.finished}/${humans.solved}/${agents.finished}/${agents.solved}`;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
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
    el.prepend(canvas);
    el.classList.add("is-drawn");

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x08111f, 18, 40);
    const camera = new THREE.PerspectiveCamera(24, 2, 0.1, 80);
    scene.add(new THREE.HemisphereLight(0xbfd0ff, 0x0a1020, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(0, 6, 8);
    scene.add(sun);
    const glow = glowTexture();

    // The line the two crews face each other across.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(0.04, 2.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3a557f })
    );
    line.position.set(0, 0.01, 0.4);
    scene.add(line);

    // A person: the coat and hat of the game's line-up.
    const coat = new THREE.CylinderGeometry(0.3, 0.46, 1.42, 24).translate(
      0,
      0.71,
      0
    );
    const shoulders = new THREE.SphereGeometry(0.3, 20, 14)
      .scale(1.4, 0.5, 0.8)
      .translate(0, 1.42, 0);
    const head = new THREE.SphereGeometry(0.2, 20, 16).translate(0, 1.78, 0);
    const brim = new THREE.CylinderGeometry(0.4, 0.42, 0.035, 28).translate(
      0,
      1.9,
      0
    );
    const crown = new THREE.CylinderGeometry(0.19, 0.23, 0.26, 20).translate(
      0,
      2.03,
      0
    );
    // A machine: a box on a box, with an aerial.
    const chassis = new THREE.BoxGeometry(0.8, 1.05, 0.5).translate(0, 0.62, 0);
    const casing = new THREE.BoxGeometry(0.62, 0.5, 0.46).translate(0, 1.5, 0);
    const neck = new THREE.BoxGeometry(0.2, 0.12, 0.2).translate(0, 1.2, 0);
    const aerial = new THREE.BoxGeometry(0.03, 0.36, 0.03).translate(
      0,
      1.93,
      0
    );
    const eye = new THREE.BoxGeometry(0.1, 0.1, 0.03);
    // The ring over a figure whose case ended with the mole caught.
    const ring = new THREE.TorusGeometry(0.2, 0.035, 8, 24).rotateX(
      Math.PI / 2
    );

    // A wide room takes twelve to a rank, a narrow one six. Each rank behind stands a step
    // higher, so every figure shows whole and a crew can be counted.
    const PER_ROW = el.clientWidth < 700 ? 6 : 12;
    const STEP = 1.9;
    const bobbers: { group: THREE.Group; seed: number; y: number }[] = [];
    function crew(side: ArenaSide, towards: number, machine: boolean) {
      const drawn = Math.min(side.finished, CONFIG.most);
      // The caught stand nearest the line; the share of each is kept when not every case is drawn.
      const caught = side.finished
        ? Math.round((side.solved / side.finished) * drawn)
        : 0;
      for (let i = 0; i < drawn; i++) {
        const won = i < caught;
        const color = won ? CAUGHT : LOST;
        const row = Math.floor(i / PER_ROW);
        // The front rank fills out from the line; a rank behind fills in from its far end.
        const col =
          row === 0
            ? i % PER_ROW
            : Math.min(PER_ROW, drawn) - 1 - (i % PER_ROW);
        const group = new THREE.Group();
        // Out from the line along the room, then back and up a step.
        group.position.set(towards * (0.9 + col), row * STEP, 0.6 - row * 1.1);
        group.rotation.y = -towards * 0.3;
        const body = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color).multiplyScalar(0.55),
          emissive: color,
          emissiveIntensity: 0.22,
          roughness: 0.6,
        });
        const trim = new THREE.MeshStandardMaterial({
          color: 0x8493b8,
          roughness: 0.7,
        });
        if (machine) {
          const eyes = new THREE.MeshBasicMaterial({ color: 0xffffff });
          const left = new THREE.Mesh(eye, eyes);
          left.position.set(-0.14, 1.52, 0.24);
          const right = new THREE.Mesh(eye, eyes);
          right.position.set(0.14, 1.52, 0.24);
          group.add(
            new THREE.Mesh(chassis, body),
            new THREE.Mesh(neck, trim),
            new THREE.Mesh(casing, body),
            new THREE.Mesh(aerial, trim),
            left,
            right
          );
        } else {
          group.add(
            new THREE.Mesh(coat, body),
            new THREE.Mesh(shoulders, body),
            new THREE.Mesh(head, body),
            new THREE.Mesh(brim, trim),
            new THREE.Mesh(crown, trim)
          );
        }
        if (won) {
          const halo = new THREE.Mesh(
            ring,
            new THREE.MeshBasicMaterial({ color })
          );
          halo.position.y = machine ? 2.32 : 2.42;
          group.add(halo);
        }
        const pool = new THREE.Mesh(
          new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({
            map: glow,
            color,
            transparent: true,
            opacity: 0.22,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        );
        pool.position.set(
          group.position.x,
          group.position.y + 0.012,
          group.position.z
        );
        scene.add(group, pool);
        bobbers.push({
          group,
          seed: i * 1.3 + (machine ? 2 : 0),
          y: group.position.y,
        });
      }
      // The steps the ranks behind stand on.
      const ranks = Math.ceil(drawn / PER_ROW);
      for (let row = 1; row < ranks; row++) {
        const wide = Math.min(PER_ROW, drawn) + 0.2;
        const box = new THREE.BoxGeometry(wide, row * STEP, 1.1);
        const step = new THREE.Mesh(
          box,
          new THREE.MeshStandardMaterial({ color: 0x16243f, roughness: 0.9 })
        );
        step.position.set(
          towards * (0.9 + (wide - 1.2) / 2),
          (row * STEP) / 2,
          0.6 - row * 1.1
        );
        scene.add(step);
      }
    }
    crew(humans, -1, false);
    crew(agents, 1, true);

    const point = new THREE.Vector3();
    const names: [HTMLElement, number, ArenaSide][] = [
      [el.querySelector<HTMLElement>(".arena-side.is-left")!, -1, humans],
      [el.querySelector<HTMLElement>(".arena-side.is-right")!, 1, agents],
    ];
    const lean = { x: 0, y: 0, tx: 0, ty: 0 };
    let dirty = true;
    let visible = false;
    let stopped = false;
    let dist = 20;
    let top = 2.5;
    function resize() {
      const w = el!.clientWidth;
      const h = el!.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const half = Math.tan((camera.fov * Math.PI) / 360);
      const most = Math.min(
        CONFIG.most,
        Math.max(humans.finished, agents.finished, 1)
      );
      top = (Math.ceil(most / PER_ROW) - 1) * STEP + 2.5;
      // Wide enough for the longer crew, and never so near that a lone figure fills the room.
      const reach = 0.9 + Math.max(4, Math.min(PER_ROW, most));
      dist = Math.max(
        (reach + 0.4) / (half * camera.aspect),
        (top / 2 + 1.3) / half
      );
      camera.updateProjectionMatrix();
      dirty = true;
    }
    function onMove(ev: PointerEvent) {
      if (!CONFIG.parallax) return;
      const box = canvas.getBoundingClientRect();
      lean.tx = ((ev.clientX - box.left) / box.width) * 2 - 1;
      lean.ty = ((ev.clientY - box.top) / box.height) * 2 - 1;
      dirty = true;
    }
    function onLeave() {
      lean.tx = lean.ty = 0;
      dirty = true;
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    let before: number | null = null;
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
      // With reduced motion nothing moves by itself: the crews are drawn when something changes.
      if (still && !dirty && !settling) return;
      if (CONFIG.bob && !still)
        for (const b of bobbers)
          b.group.position.y = b.y + Math.sin(ms / 900 + b.seed) * 0.03 + 0.03;
      camera.position.set(lean.x * 1.2, top / 2 + 1.6 - lean.y * 0.4, dist);
      camera.lookAt(0, top / 2 - 0.05, 0);
      dirty = false;
      renderer.render(scene, camera);
      // Each crew's name stands over the middle of it.
      for (const [node, towards, side] of names) {
        const used = Math.min(PER_ROW, Math.min(side.finished, CONFIG.most));
        point
          .set(towards * (0.9 + (Math.max(used, 4) - 1) / 2), 0, 0)
          .project(camera);
        const half = node.offsetWidth / 2 + 8;
        node.style.left = `${Math.min(el!.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * el!.clientWidth))}px`;
      }
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
      renderer.dispose();
      canvas.remove();
      el.classList.remove("is-drawn");
    };
    // Rebuilt whenever the counts change, which is when another case is chosen.
  }, [key]);

  const drawn = (side: ArenaSide) => Math.min(side.finished, CONFIG.most);
  const note = (side: ArenaSide) =>
    side.finished === 0
      ? "nobody has finished this case yet"
      : side.finished > CONFIG.most
        ? `${side.finished} finished, showing ${drawn(side)}`
        : `${side.finished} finished`;
  return (
    <div className="arena" ref={host} aria-hidden="true">
      <span className="arena-side is-left">
        Humans<i>{note(humans)}</i>
      </span>
      <span className="arena-side is-right">
        Agents<i>{note(agents)}</i>
      </span>
      <ul className="arena-key">
        <li className="is-caught">Caught the mole</li>
        <li className="is-lost">The mole got away</li>
      </ul>
    </div>
  );
}
