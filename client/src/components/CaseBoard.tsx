import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { PublicCase } from "@shared/cases";
import { caseTimes, type CaseTime } from "@shared/caseTimes";

// The board on a case's briefing page: the five suspects under their lamps,
// and above them a rail carrying every clock time the public file prints, in
// the order of the night. A wire runs from each time in a dossier, along the
// beam, into that suspect's lamp. It shows nothing the briefing, the intercept and the dossiers do
// not say, and every suspect is drawn and lit alike.
//
// The lamps' slow sway and the dust are decoration. Without WebGL the board is
// left out and the page reads as it did before.

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  sway: true, // the lamps swing a little
  parallax: true, // the view leans a little toward the pointer
  dust: true, // motes in the lamplight
  threads: true, // the wires from a suspect's lamp to their own times
  cones: true, // the cone of light under each lamp
};

type Pick =
  { kind: "suspect"; id: string } | { kind: "time"; index: number } | null;

const NEON = 0x45ff2e;
const RED = 0xff6b6b;
const PALE = 0xe6edf7;
const WIDE = 9; // the rail and the line-up, side to side
const LIT = 34; // a lamp's light on its suspect
const DIM = 8; // and while someone else is picked
const RAIL = 4.65; // how high the rail hangs, clear of the lamps and the wires
const BEAM = 3.65; // the beam the lamps hang from

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

const sourceName = (theCase: PublicCase, source: string) =>
  source === "brief"
    ? "the briefing"
    : source === "intercept"
      ? "the intercept"
      : `${theCase.suspects.find(s => s.id === source)?.codename ?? source}'s dossier`;

export default function CaseBoard({ theCase }: { theCase: PublicCase }) {
  const host = useRef<HTMLDivElement>(null);
  const choose = useRef<(pick: Pick) => void>(() => {});
  const times = useMemo(() => caseTimes(theCase), [theCase]);
  const [pick, setPick] = useState<Pick>(null);
  const [drawn, setDrawn] = useState(true);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setDrawn(false);
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    el.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x08111f, 50, 110);
    const camera = new THREE.PerspectiveCamera(20, 1.5, 0.1, 200);
    scene.add(new THREE.HemisphereLight(0xb9c8ee, 0x0a1220, 1.6));
    const glow = glowTexture();

    const labels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
    function label(
      text: string,
      at: THREE.Vector3,
      cls: string,
      button = false
    ) {
      const node = document.createElement(button ? "button" : "span");
      if (button) (node as HTMLButtonElement).type = "button";
      node.className = `case-board-label ${cls}`;
      node.textContent = text;
      el!.appendChild(node);
      labels.push({ el: node, at });
      return node;
    }

    // ---- the floor and the wall ----
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDE + 8, 9).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0b1626, roughness: 0.85 })
    );
    floor.position.z = 2;
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDE + 8, 9),
      new THREE.MeshStandardMaterial({ color: 0x0d1829, roughness: 0.95 })
    );
    wall.position.set(0, 4.5, -0.9);
    scene.add(floor, wall);

    // ---- the rail: the night, left to right ----
    // The file is silent for hours between the night and the morning. The rail
    // is cut there, and says so, so the night is not squeezed into a corner.
    let cut = -1;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i].at - times[i - 1].at;
      if (gap >= 180 && (cut < 0 || gap > times[cut].at - times[cut - 1].at))
        cut = i;
    }
    const hourDown = (at: number) => Math.floor(at / 60) * 60;
    const hourUp = (at: number) => Math.ceil(at / 60) * 60;
    const spans =
      cut < 0
        ? [
            {
              from: hourDown(times[0].at),
              to: hourUp(times[times.length - 1].at),
              x0: -WIDE * 0.47,
              x1: WIDE * 0.47,
            },
          ]
        : [
            {
              from: hourDown(times[0].at),
              to: hourUp(times[cut - 1].at),
              x0: 0,
              x1: 0,
            },
            {
              from: hourDown(times[cut].at),
              to: hourUp(times[times.length - 1].at),
              x0: 0,
              x1: 0,
            },
          ];
    if (cut >= 0) {
      // Each side of the cut gets room in proportion to the hours it covers.
      const room = WIDE * 0.94 - WIDE * 0.09;
      const night = spans[0].to - spans[0].from;
      const share = night / (night + spans[1].to - spans[1].from);
      spans[0].x0 = -WIDE * 0.47;
      spans[0].x1 = spans[0].x0 + room * share;
      spans[1].x0 = spans[0].x1 + WIDE * 0.09;
      spans[1].x1 = WIDE * 0.47;
    }
    const xOf = (at: number) => {
      const span = spans.find(s => at <= s.to) ?? spans[spans.length - 1];
      return (
        span.x0 +
        ((at - span.from) / Math.max(60, span.to - span.from)) *
          (span.x1 - span.x0)
      );
    };
    const railColor = new THREE.MeshBasicMaterial({ color: 0x4a6a9c });
    const narrow = el.clientWidth < 420;
    for (const span of spans) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(span.x1 - span.x0, 0.035, 0.035),
        railColor
      );
      bar.position.set((span.x0 + span.x1) / 2, RAIL, -0.6);
      scene.add(bar);
      const hours = (span.to - span.from) / 60;
      // On a narrow screen only every other hour is named, and a short span only at its start.
      const every = !narrow ? 1 : hours > 4 ? 2 : hours;
      for (let at = span.from; at <= span.to; at += 60) {
        const hour = (Math.floor(at / 60) + 12) % 24;
        // On a narrow screen the hour that ends the night would run into the morning's first.
        const marked =
          ((at - span.from) / 60) % every === 0 &&
          !(narrow && cut >= 0 && at === span.to);
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(0.02, marked ? 0.2 : 0.1, 0.02),
          railColor
        );
        tick.position.set(xOf(at), RAIL - (marked ? 0.1 : 0.05), -0.6);
        scene.add(tick);
        if (marked)
          label(
            `${String(hour).padStart(2, "0")}:00`,
            new THREE.Vector3(xOf(at), RAIL - 0.2, -0.6),
            "hour"
          );
      }
    }
    if (cut >= 0) {
      const hours = Math.round((spans[1].from - spans[0].to) / 60);
      label(
        `${hours} h gap`,
        new THREE.Vector3((spans[0].x1 + spans[1].x0) / 2, RAIL, -0.6),
        "cut"
      );
    }
    label(
      "last night",
      new THREE.Vector3(-WIDE / 2 + 0.5, RAIL + 1.5, -0.6),
      "end"
    );
    label(
      "this morning",
      new THREE.Vector3(WIDE / 2 - 0.6, RAIL + 1.5, -0.6),
      "end"
    );
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(WIDE + 1, 0.07, 0.07),
      new THREE.MeshBasicMaterial({ color: 0x1a2740 })
    );
    beam.position.set(0, BEAM, 0.9);
    scene.add(beam);

    // ---- the suspects, all alike ----
    const targets: THREE.Mesh[] = [];
    const n = theCase.suspects.length;
    // A long coat, widest at the hem, with square shoulders.
    const body = new THREE.CylinderGeometry(0.26, 0.4, 1.42, 28).translate(
      0,
      0.71,
      0
    );
    const shoulders = new THREE.SphereGeometry(0.3, 24, 16)
      .scale(1.25, 0.5, 0.8)
      .translate(0, 1.42, 0);
    const collar = new THREE.CylinderGeometry(0.15, 0.2, 0.14, 20).translate(
      0,
      1.58,
      0
    );
    const head = new THREE.SphereGeometry(0.2, 24, 18).translate(0, 1.78, 0);
    // Every suspect wears the same hat and coat: nothing in how one is drawn tells them apart.
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
    const beamOf = new THREE.ConeGeometry(0.82, 3.0, 36, 1, true).translate(
      0,
      -1.5,
      0
    );
    const shade = new THREE.ConeGeometry(0.3, 0.24, 24, 1, true);
    const figures = theCase.suspects.map((suspect, i) => {
      const x = (i - (n - 1) / 2) * (WIDE / n);
      const group = new THREE.Group();
      group.position.set(x, 0, 0.9);
      const skin = new THREE.MeshStandardMaterial({
        color: 0x5b6f96,
        roughness: 0.6,
        metalness: 0,
      });
      const coat = new THREE.Mesh(body, skin);
      coat.scale.set(1.15, 1, 0.8);
      const hat = new THREE.MeshStandardMaterial({
        color: 0x3d4d70,
        roughness: 0.7,
      });
      const face = new THREE.MeshStandardMaterial({
        color: 0x8794b3,
        roughness: 0.6,
      });
      group.add(
        coat,
        new THREE.Mesh(shoulders, skin),
        new THREE.Mesh(collar, hat),
        new THREE.Mesh(head, face),
        new THREE.Mesh(brim, hat),
        new THREE.Mesh(crown, hat)
      );
      group.scale.setScalar(1.12);
      const lamp = new THREE.Group();
      lamp.position.set(x, BEAM, 0.9);
      const cord = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.5, 0.012).translate(0, -0.25, 0),
        new THREE.MeshBasicMaterial({ color: 0x24344f })
      );
      const cone = new THREE.Mesh(
        shade,
        new THREE.MeshBasicMaterial({ color: 0x31456b, side: THREE.DoubleSide })
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
      cone.position.y = -0.6;
      bulb.position.y = -0.7;
      bulb.scale.setScalar(0.7);
      const spot = new THREE.SpotLight(0xfff1c9, LIT, 7, 0.5, 0.7, 1);
      spot.position.set(0, -0.65, 0.5);
      spot.target.position.set(x, 0, 0.9);
      const light = new THREE.Mesh(
        beamOf,
        new THREE.MeshBasicMaterial({
          color: 0xfff1c9,
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      light.position.y = -0.62;
      light.visible = CONFIG.cones;
      lamp.add(cord, cone, bulb, spot, light);
      const pool = new THREE.Mesh(
        new THREE.PlaneGeometry(2.3, 2.3).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          map: glow,
          color: 0xfff1c9,
          transparent: true,
          opacity: 0.16,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      pool.position.set(x, 0.01, 0.9);
      // Anything on the figure finds it.
      const reach = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, 2.1, 10).translate(0, 1.05, 0),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      reach.userData.pick = { kind: "suspect", id: suspect.id } as Pick;
      group.add(reach);
      targets.push(reach);
      scene.add(group, lamp, spot.target, pool);
      // The name is the button for the suspect: a pointer, a finger or a keyboard can pick with it.
      const name = label(
        suspect.codename,
        new THREE.Vector3(x, -0.12, 1.5),
        "name",
        true
      );
      name.addEventListener("click", () =>
        choose.current(
          held?.kind === "suspect" && held.id === suspect.id
            ? null
            : { kind: "suspect", id: suspect.id }
        )
      );
      return {
        suspect,
        x,
        group,
        lamp,
        spot,
        bulb,
        pool,
        light,
        skin,
        name,
        seed: i * 1.9,
      };
    });

    // ---- every time the file prints, on the rail ----
    const pin = new THREE.SphereGeometry(narrow ? 0.11 : 0.08, 16, 12);
    const lead = new THREE.BoxGeometry(0.012, 1, 0.012);
    const rows: number[] = [];
    const marks = times.map((time, index) => {
      const x = xOf(time.at);
      // Every time sits on the rail. Only ones too close to tell apart are stacked, touching.
      let row = rows.findIndex(end => x - end > 0.05);
      if (row < 0) row = rows.length;
      rows[row] = x;
      const y = RAIL + row * (narrow ? 0.23 : 0.17);
      const color =
        time.source === "brief"
          ? PALE
          : time.source === "intercept"
            ? RED
            : NEON;
      const mesh = new THREE.Mesh(pin, new THREE.MeshBasicMaterial({ color }));
      mesh.position.set(x, y, -0.6);
      // The line from a time up to its label, drawn only while the label shows.
      const stem = new THREE.Mesh(lead, new THREE.MeshBasicMaterial({ color }));
      stem.visible = false;
      const reach = new THREE.Mesh(
        new THREE.SphereGeometry(narrow ? 0.3 : 0.19, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      reach.position.copy(mesh.position);
      reach.userData.pick = { kind: "time", index } as Pick;
      targets.push(reach);
      scene.add(mesh, stem, reach);
      let thread: THREE.Line | null = null;
      const owner = figures.find(f => f.suspect.id === time.source);
      if (owner && CONFIG.threads) {
        // Down from the time to the suspect's own run along the beam, across, and into their lamp.
        const run = BEAM + 0.1 + figures.indexOf(owner) * 0.055;
        thread = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, RAIL, -0.6),
            new THREE.Vector3(x, run, -0.6),
            new THREE.Vector3(owner.x, run, -0.6),
            new THREE.Vector3(owner.x, BEAM, 0.9),
          ]),
          new THREE.LineBasicMaterial({
            color: NEON,
            transparent: true,
            opacity: 0.6,
          })
        );
        scene.add(thread);
      }
      const tagAt = new THREE.Vector3(x, y + 0.14, -0.6);
      const tag = label(time.label, tagAt, "time");
      tag.hidden = true;
      return { time, mesh, thread, tag, tagAt, stem, x, y, color };
    });

    let dust: THREE.Points | null = null;
    if (CONFIG.dust) {
      const count = 90;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * (WIDE + 2);
        pos[i * 3 + 1] = Math.random() * 3.2;
        pos[i * 3 + 2] = Math.random() * 2.4 - 0.3;
      }
      dust = new THREE.Points(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.BufferAttribute(pos, 3)
        ),
        new THREE.PointsMaterial({
          map: glow,
          color: 0xfff1c9,
          size: 0.05,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      scene.add(dust);
    }

    // ---- what is picked ----
    let hovered: Pick = null;
    let held: Pick = null;
    let dirty = true;
    function paint() {
      const lit = hovered ?? held;
      const suspectId =
        lit?.kind === "suspect"
          ? lit.id
          : lit?.kind === "time"
            ? times[lit.index].source
            : null;
      const someone = figures.some(f => f.suspect.id === suspectId);
      for (const f of figures) {
        // With someone picked the others stand back; with nobody picked all are lit alike.
        const on = !someone || f.suspect.id === suspectId;
        f.spot.intensity = on ? LIT : DIM;
        f.bulb.material.opacity = on ? 1 : 0.35;
        f.pool.material.opacity = on ? 0.16 : 0.04;
        f.light.material.opacity = on ? (someone ? 0.2 : 0.12) : 0.03;
        f.name.classList.toggle("is-picked", someone && on);
      }
      marks.forEach((m, index) => {
        const mine = someone && m.time.source === suspectId;
        const exact = lit?.kind === "time" && lit.index === index;
        m.mesh.scale.setScalar(exact ? 1.5 : mine ? 1.3 : 1);
        if (m.thread)
          (m.thread.material as THREE.LineBasicMaterial).opacity = mine
            ? 1
            : someone
              ? 0.12
              : 0.6;
        m.tag.hidden = !(mine || exact);
      });
      // Tags that would sit on each other step up, left to right.
      let lastX = -Infinity;
      let step = 0;
      for (const m of marks) {
        if (m.tag.hidden) continue;
        step = m.x - lastX < (narrow ? 1.7 : 0.75) ? step + 1 : 0;
        m.tagAt.y = RAIL + 0.42 + step * (narrow ? 0.42 : 0.27);
        lastX = m.x;
      }
      el!.classList.toggle(
        "is-tagged",
        marks.some(m => !m.tag.hidden)
      );
      for (const m of marks) {
        m.stem.visible = !m.tag.hidden;
        m.stem.scale.y = Math.max(0.01, m.tagAt.y - m.y);
        m.stem.position.set(m.x, (m.tagAt.y + m.y) / 2, -0.6);
      }
      dirty = true;
    }
    choose.current = next => {
      held = next;
      paint();
      setPick(next);
    };

    // ---- view ----
    const lean = { x: 0, y: 0, tx: 0, ty: 0 };
    let dist = 30;
    let visible = false;
    let stopped = false;
    function resize() {
      const w = el!.clientWidth;
      const h = el!.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const half = Math.tan((camera.fov * Math.PI) / 360);
      dist = Math.max((WIDE / 2 + 0.45) / (half * camera.aspect), 3.85 / half);
      camera.updateProjectionMatrix();
      dirty = true;
    }
    const point = new THREE.Vector3();
    function draw(t: number) {
      camera.position.set(lean.x * 1.1, 3.0 - lean.y * 0.5, dist);
      camera.lookAt(0, 2.95, 0);
      if (CONFIG.sway && !still)
        for (const f of figures)
          f.lamp.rotation.z = Math.sin(t * 0.7 + f.seed) * 0.035;
      renderer.render(scene, camera);
      for (const l of labels) {
        point.copy(l.at).project(camera);
        const half = l.el.offsetWidth / 2 + 2;
        l.el.style.left = `${Math.min(el!.clientWidth - half, Math.max(half, ((point.x + 1) / 2) * el!.clientWidth))}px`;
        l.el.style.top = `${((1 - point.y) / 2) * el!.clientHeight}px`;
      }
    }

    // ---- pointer ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function find(ev: PointerEvent | MouseEvent): Pick {
      const box = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - box.left) / box.width) * 2 - 1,
        -((ev.clientY - box.top) / box.height) * 2 + 1
      );
      ray.setFromCamera(ndc, camera);
      return (
        (ray.intersectObjects(targets, false)[0]?.object.userData
          .pick as Pick) ?? null
      );
    }
    const same = (a: Pick, b: Pick) => JSON.stringify(a) === JSON.stringify(b);
    function onMove(ev: PointerEvent) {
      const box = canvas.getBoundingClientRect();
      if (CONFIG.parallax) {
        lean.tx = ((ev.clientX - box.left) / box.width) * 2 - 1;
        lean.ty = ((ev.clientY - box.top) / box.height) * 2 - 1;
      }
      if (ev.pointerType === "mouse") {
        const next = find(ev);
        if (!same(next, hovered)) {
          hovered = next;
          canvas.classList.toggle("is-pick", next !== null);
          paint();
          setPick(next ?? held);
        }
      }
      dirty = true;
    }
    function onLeave() {
      lean.tx = lean.ty = 0;
      hovered = null;
      canvas.classList.remove("is-pick");
      paint();
      setPick(held);
    }
    // A click or a tap keeps what it lands on; one on nothing lets go.
    function onClick(ev: MouseEvent) {
      choose.current(find(ev));
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);

    // ---- frame ----
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
      // With reduced motion nothing moves by itself: the board is drawn when something changes.
      const settling =
        Math.abs(lean.tx - lean.x) > 0.001 ||
        Math.abs(lean.ty - lean.y) > 0.001;
      if (still && !dirty && !settling) return;
      if (!still && dust) dust.rotation.y = Math.sin(ms / 20000) * 0.06;
      dirty = false;
      draw(ms / 1000);
    }

    resize();
    paint();
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
      for (const l of labels) l.el.remove();
      canvas.remove();
      choose.current = () => {};
    };
  }, [theCase, times]);

  if (!drawn) return null;

  const suspect =
    pick?.kind === "suspect"
      ? theCase.suspects.find(s => s.id === pick.id)
      : undefined;
  const time: CaseTime | undefined =
    pick?.kind === "time" ? times[pick.index] : undefined;

  return (
    <aside
      className="case-board"
      aria-label="The suspects and the times on file"
    >
      <div className="case-board-room" ref={host} />
      <ul className="case-board-key">
        <li className="is-brief">A time in the briefing</li>
        <li className="is-intercept">A time in the intercept</li>
        <li className="is-dossier">
          A time in a dossier, wired to that suspect's lamp
        </li>
      </ul>
      <div className="case-board-file" aria-live="polite">
        {suspect ? (
          <>
            <b>{suspect.codename}</b>
            <span>
              {suspect.name} · {suspect.role}
            </span>
            <dl>
              <dt>Last night</dt>
              <dd>{suspect.lastNight}</dd>
              <dt>On file</dt>
              <dd>{suspect.onFile}</dd>
            </dl>
          </>
        ) : time ? (
          <>
            <b>{time.label}</b>
            <span>From {sourceName(theCase, time.source)}</span>
            <p>{time.sentence}</p>
          </>
        ) : (
          <>
            <b>{times.length} times on file</b>
            <p className="case-board-hint">
              Pick a suspect by name, or a time on the rail, to read what the
              file says about it.
            </p>
          </>
        )}
      </div>
      <p className="case-board-note">
        The rail carries every clock time the file prints, and nothing else. It
        is cut where the file is silent for hours. Times too close to tell apart
        are stacked. Every suspect is drawn and lit alike until you pick one.
        The swaying lamps and the dust mean nothing.
      </p>
    </aside>
  );
}
