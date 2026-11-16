import { useEffect, useRef } from "react";
import * as THREE from "three";

// The room under the home page's headline: five figures in a line-up, all
// alike, and one hanging lamp whose light follows the pointer along the row.
// It is scenery. The figures are nobody from a case, and where the light falls
// says nothing about anyone.
//
// Without WebGL nothing is drawn and the hero keeps its plain background.

// Every feature is a switch here. Turn one off, do not delete it.
const CONFIG = {
  follow: true, // the lamp's light follows the pointer
  sweep: true, // and drifts along the row by itself while the pointer is away
  dust: true, // motes in the lamplight
  figures: 5,
};

const WIDE = 11; // the line-up, side to side

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

export default function HeroRoom() {
  const host = useRef<HTMLDivElement>(null);

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
    el.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x08111f, 16, 34);
    const camera = new THREE.PerspectiveCamera(26, 2, 0.1, 80);
    scene.add(new THREE.HemisphereLight(0x5f7bb8, 0x05080f, 0.9));
    const glow = glowTexture();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 16).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0c1930, roughness: 0.9 })
    );
    floor.position.z = 3;
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 12),
      new THREE.MeshStandardMaterial({ color: 0x0d1c36, roughness: 1 })
    );
    wall.position.set(0, 6, -1.6);
    // No wall is drawn: the room has no back, so it melts into the page behind it.
    wall.visible = false;
    floor.material.transparent = true;
    floor.material.opacity = 0.55;
    scene.add(floor, wall);

    // The figures: one coat, one hat, five times.
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
    for (let i = 0; i < CONFIG.figures; i++) {
      const group = new THREE.Group();
      group.position.set(
        (i - (CONFIG.figures - 1) / 2) * (WIDE / CONFIG.figures),
        0,
        0
      );
      group.scale.setScalar(1.25);
      group.add(
        new THREE.Mesh(coat, cloth),
        new THREE.Mesh(shoulders, cloth),
        new THREE.Mesh(head, cloth),
        new THREE.Mesh(brim, felt),
        new THREE.Mesh(crown, felt)
      );
      scene.add(group);
    }

    // The lamp: a shade on a cord, a cone of light, and the pool it throws.
    const TOP = 3.9;
    const lamp = new THREE.Group();
    lamp.position.set(0, TOP, 1.4);
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
    bulb.scale.setScalar(1.1);
    lamp.add(cord, shade, bulb);
    const spot = new THREE.SpotLight(0xfff1c9, 70, 12, 0.4, 0.6, 1);
    spot.position.copy(lamp.position);
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1.5, TOP, 40, 1, true).translate(0, -TOP / 2, 0),
      new THREE.MeshBasicMaterial({
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    beam.position.copy(lamp.position);
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 4.4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: glow,
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(lamp, spot, spot.target, beam, pool);

    let dust: THREE.Points | null = null;
    if (CONFIG.dust) {
      const count = 160;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * (WIDE + 6);
        pos[i * 3 + 1] = Math.random() * 5;
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

    // ---- where the light falls ----
    let aim = 0; // along the row, in floor units
    let wanted = 0;
    let pointerAt = -Infinity; // when the pointer last moved, in ms
    let visible = false;
    let stopped = false;
    let dirty = true;
    function place() {
      spot.target.position.set(aim, 1, 0);
      pool.position.set(aim, 0.012, 0.3);
      // The cone leans from the lamp to where it is aimed.
      beam.rotation.z = Math.atan2(aim - lamp.position.x, TOP);
      lamp.rotation.z = beam.rotation.z * 0.5;
    }
    function resize() {
      const w = el!.clientWidth;
      const h = el!.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const half = Math.tan((camera.fov * Math.PI) / 360);
      const dist = Math.max(
        (WIDE / 2 + 0.3) / (half * camera.aspect),
        2.25 / half
      );
      camera.position.set(0, 2.2, dist);
      camera.lookAt(0, 2.05, 0);
      camera.updateProjectionMatrix();
      dirty = true;
    }
    // The pointer is tracked on the window, since the hero's text lies over the room.
    function onMove(ev: PointerEvent) {
      if (!CONFIG.follow) return;
      const box = el!.getBoundingClientRect();
      if (ev.clientY < box.top || ev.clientY > box.bottom) return;
      wanted = (((ev.clientX - box.left) / box.width) * 2 - 1) * (WIDE / 2);
      pointerAt = performance.now();
      dirty = true;
    }
    window.addEventListener("pointermove", onMove, { passive: true });

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
      // Left alone for a few seconds, the light drifts along the row.
      if (CONFIG.sweep && !still && ms - pointerAt > 3500)
        wanted = Math.sin(ms / 4200) * (WIDE / 2 - 1);
      const settling = Math.abs(wanted - aim) > 0.002;
      // With reduced motion nothing moves by itself: the room is drawn when the pointer moves it.
      if (still && !dirty && !settling) return;
      aim += (wanted - aim) * Math.min(1, dt * 2.6);
      if (still) aim = wanted;
      if (!still && dust) dust.rotation.y = Math.sin(ms / 23000) * 0.08;
      place();
      dirty = false;
      renderer.render(scene, camera);
    }

    resize();
    place();
    const sized = new ResizeObserver(resize);
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    sized.observe(el);
    seen.observe(el);
    requestAnimationFrame(frame);
    el.classList.add("is-drawn");

    return () => {
      stopped = true;
      sized.disconnect();
      seen.disconnect();
      window.removeEventListener("pointermove", onMove);
      renderer.dispose();
      canvas.remove();
      el.classList.remove("is-drawn");
    };
  }, []);

  return <div className="home-room" ref={host} aria-hidden="true" />;
}
