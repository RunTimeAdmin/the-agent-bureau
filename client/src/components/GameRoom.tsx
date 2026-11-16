import { useEffect, useRef } from "react";
import * as THREE from "three";

// The room a case is played in: the five suspects in a line-up, and one lamp.
// While the case is open, the suspect being questioned steps forward under the
// lamp. Once
// the case is over, the lamp is on whoever was accused and a red light is on
// the mole.
//
// It shows only what the page beside it already shows: who is selected and,
// after the accusation, the verdict. Until
// then every suspect is drawn alike. The lamp's sway and the dust are
// decoration; the lamp's pulse means an answer is being written.
//
// Without WebGL nothing is drawn and the page reads as it did before.

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  step: true, // the suspect being questioned steps forward
  sway: true, // the lamp swings a little
  pulse: true, // the lamp pulses while an answer is being written
  dust: true, // motes in the lamplight
};

export type RoomState = {
  /** Who the lamp is on: the suspect being questioned, or the one accused. */
  lit: string | null;
  /** Set only once the case is over. */
  mole: string | null;
  /** An answer is being written. */
  waiting: boolean;
};

const WIDE = 10; // the line-up, side to side
const TOP = 3.9; // how high the lamp hangs

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

export default function GameRoom({
  suspects,
  state,
  onPick,
}: {
  suspects: { id: string; codename: string }[];
  state: RoomState;
  onPick?: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(state);
  const pick = useRef(onPick);
  const sync = useRef<() => void>(() => {});
  latest.current = state;
  pick.current = onPick;
  const ids = suspects.map(s => s.id).join(",");

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
    scene.fog = new THREE.Fog(0x08111f, 16, 34);
    const camera = new THREE.PerspectiveCamera(26, 2, 0.1, 80);
    scene.add(new THREE.HemisphereLight(0x7f9bd8, 0x0a1020, 2.1));
    const glow = glowTexture();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 16).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x0c1930,
        roughness: 0.9,
        transparent: true,
        opacity: 0.55,
      })
    );
    floor.position.z = 3;
    scene.add(floor);

    // The figures: one coat, one hat, for every suspect.
    const coat = new THREE.CylinderGeometry(0.3, 0.46, 1.42, 28).translate(
      0,
      0.71,
      0
    );
    const shoulders = new THREE.SphereGeometry(0.3, 24, 16)
      .scale(1.4, 0.5, 0.8)
      .translate(0, 1.42, 0);
    const head = new THREE.SphereGeometry(0.2, 24, 18).translate(0, 1.78, 0);
    const brim = new THREE.CylinderGeometry(0.4, 0.42, 0.035, 32).translate(
      0,
      1.9,
      0
    );
    const crown = new THREE.CylinderGeometry(0.19, 0.23, 0.26, 24).translate(
      0,
      2.03,
      0
    );
    const cloth = new THREE.MeshStandardMaterial({
      color: 0x55668c,
      roughness: 0.7,
    });
    const felt = new THREE.MeshStandardMaterial({
      color: 0x33415f,
      roughness: 0.8,
    });
    const targets: THREE.Mesh[] = [];
    const figures = suspects.map((suspect, i) => {
      const x = (i - (suspects.length - 1) / 2) * (WIDE / suspects.length);
      const group = new THREE.Group();
      group.position.set(x, 0, 0);
      group.scale.setScalar(1.2);
      group.add(
        new THREE.Mesh(coat, cloth),
        new THREE.Mesh(shoulders, cloth),
        new THREE.Mesh(head, cloth),
        new THREE.Mesh(brim, felt),
        new THREE.Mesh(crown, felt)
      );
      // Anything on the figure finds it.
      const reach = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.6, 2.3, 10).translate(0, 1.15, 0),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      reach.userData.id = suspect.id;
      group.add(reach);
      targets.push(reach);
      scene.add(group);
      return { id: suspect.id, x, group, z: 0 };
    });

    // The lamp: a shade on a cord, a cone of light, and the pool it throws.
    const lamp = new THREE.Group();
    const cord = new THREE.Mesh(
      new THREE.BoxGeometry(0.015, 4, 0.015).translate(0, 2, 0),
      new THREE.MeshBasicMaterial({ color: 0x5a6f99 })
    );
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.34, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x3a4f7a, side: THREE.DoubleSide })
    );
    const bulb = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: 0xfff1c9,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    bulb.position.y = -0.12;
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1.15, TOP, 40, 1, true).translate(0, -TOP / 2, 0),
      new THREE.MeshBasicMaterial({
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    lamp.add(cord, shade, bulb, beam);
    const spot = new THREE.SpotLight(0xfff1c9, 70, 12, 0.36, 0.6, 1);
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 3.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glow,
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(lamp, spot, spot.target, pool);

    // The red light that finds the mole once the case is over.
    const red = new THREE.SpotLight(0xff2a2a, 0, 9, 0.42, 0.6, 1);
    const redPool = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glow,
        color: 0xff4d4d,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(red, red.target, redPool);

    let dust: THREE.Points | null = null;
    if (CONFIG.dust) {
      const count = 120;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * (WIDE + 4);
        pos[i * 3 + 1] = Math.random() * 4;
        pos[i * 3 + 2] = Math.random() * 4 - 1;
      }
      dust = new THREE.Points(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.BufferAttribute(pos, 3)
        ),
        new THREE.PointsMaterial({
          map: glow,
          color: 0xfff1c9,
          size: 0.06,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      scene.add(dust);
    }

    // ---- what the page says ----
    let lampX = 0;
    let lampTo = 0;
    let dirty = true;
    let visible = false;
    let stopped = false;
    let hovered: string | null = null;
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
      const dist = Math.max(
        (WIDE / 2 + 0.9) / (half * camera.aspect),
        3.0 / half
      );
      // In a wide room the row spreads to use it, up to a comfortable gap.
      const gap = Math.min(
        4.6,
        Math.max(
          WIDE / figures.length,
          (dist * half * camera.aspect * 1.5) / figures.length
        )
      );
      figures.forEach((f, i) => {
        f.x = (i - (figures.length - 1) / 2) * gap;
        f.group.position.x = f.x;
      });
      camera.position.set(0, 2.0, dist);
      camera.lookAt(0, 1.75, 0);
      camera.updateProjectionMatrix();
      dirty = true;
    }

    const point = new THREE.Vector3();
    const names = [...el.querySelectorAll<HTMLElement>("[data-suspect]")];
    function place(t: number, dt: number) {
      const now = latest.current;
      const lit = figures.find(f => f.id === now.lit) ?? null;
      const mole = figures.find(f => f.id === now.mole) ?? null;
      let moving = false;
      for (const f of figures) {
        // The one under the lamp stands a step forward of the row.
        const to = CONFIG.step && f === lit ? 1.1 : 0;
        f.z = still ? to : f.z + (to - f.z) * Math.min(1, dt * 5);
        if (Math.abs(to - f.z) > 0.002) moving = true;
        f.group.position.z = f.z;
      }
      lampTo = lit ? lit.x : 0;
      lampX = still ? lampTo : lampX + (lampTo - lampX) * Math.min(1, dt * 4);
      if (Math.abs(lampTo - lampX) > 0.002) moving = true;
      const litZ = lit ? lit.z : 0;
      lamp.position.set(lampX, TOP, litZ + 0.1);
      lamp.rotation.z = CONFIG.sway && !still ? Math.sin(t * 0.8) * 0.02 : 0;
      spot.position.set(lampX, TOP, litZ + 0.6);
      spot.target.position.set(lampX, 1, litZ);
      pool.position.set(lampX, 0.012, litZ + 0.2);
      // With nobody under it the lamp is low; while an answer is written it pulses.
      const beat =
        now.waiting && CONFIG.pulse && !still
          ? 0.72 + Math.sin(t * 7) * 0.28
          : 1;
      const on = lit ? 1 : 0.25;
      spot.intensity = 42 * on * beat;
      bulb.scale.setScalar(1.1 * (0.8 + 0.2 * beat));
      beam.material.opacity = 0.09 * on * beat;
      pool.material.opacity = 0.2 * on * beat;
      if (mole) {
        red.position.set(mole.x, 3.4, mole.z + 2.6);
        red.target.position.set(mole.x, 1, mole.z);
        redPool.position.set(mole.x, 0.014, mole.z + 0.2);
      }
      red.intensity = mole ? 170 : 0;
      redPool.material.opacity = mole ? 0.5 : 0;
      for (const node of names) {
        const f = figures.find(k => k.id === node.dataset.suspect)!;
        // Across, a name follows its figure, which may have stepped forward; down, all names keep one line.
        point.set(f.x, 1, f.z).project(camera);
        const across = point.x;
        point.set(f.x, -0.12, 0.6).project(camera);
        const half = node.offsetWidth / 2 + 2;
        node.style.left = `${Math.min(el!.clientWidth - half, Math.max(half, ((across + 1) / 2) * el!.clientWidth))}px`;
        node.style.top = `${((1 - point.y) / 2) * el!.clientHeight}px`;
      }
      return moving || (now.waiting && !still);
    }

    // ---- pointer ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function find(ev: MouseEvent): string | null {
      const box = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - box.left) / box.width) * 2 - 1,
        -((ev.clientY - box.top) / box.height) * 2 + 1
      );
      ray.setFromCamera(ndc, camera);
      return (
        (ray.intersectObjects(targets, false)[0]?.object.userData
          .id as string) ?? null
      );
    }
    function onMove(ev: PointerEvent) {
      if (!pick.current || ev.pointerType !== "mouse") return;
      const next = find(ev);
      if (next === hovered) return;
      hovered = next;
      canvas.classList.toggle("is-pick", next !== null);
    }
    function onClick(ev: MouseEvent) {
      const id = find(ev);
      if (id) pick.current?.(id);
    }
    canvas.addEventListener("pointermove", onMove);
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
      // With reduced motion nothing moves by itself: the room is drawn when the page changes it.
      if (still && !dirty && !busy) return;
      if (!still && dust) dust.rotation.y = Math.sin(ms / 23000) * 0.08;
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
      canvas.removeEventListener("click", onClick);
      renderer.dispose();
      canvas.remove();
      el.classList.remove("is-drawn");
      sync.current = () => {};
    };
    // The room is built once for a case's suspects; what changes after that is read each frame.
  }, [ids]);

  useEffect(() => sync.current(), [state]);

  return (
    <div className="game-room" ref={host} aria-hidden="true">
      {suspects.map(suspect => {
        const accused = state.mole !== null && state.lit === suspect.id;
        const mole = state.mole === suspect.id;
        return (
          <span
            key={suspect.id}
            data-suspect={suspect.id}
            className={`game-room-name ${state.lit === suspect.id ? "is-lit" : ""} ${
              mole ? "is-mole" : ""
            }`}
          >
            {suspect.codename}
            {state.mole !== null && (
              <em>
                {[accused && "accused", mole && "the mole"]
                  .filter(Boolean)
                  .join(" · ")}
              </em>
            )}
          </span>
        );
      })}
    </div>
  );
}
