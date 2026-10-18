// Collision lookup (SH §2.13, §6.5). Pure.

/** Is surface point (x, y) inside collision c? Rectangles follow the Win32 PtInRect convention (right/bottom exclusive). */
export function contains(c, x, y) {
  switch (c.kind) {
    case 'rect': return x >= c.x1 && x < c.x2 && y >= c.y1 && y < c.y2;
    case 'ellipse': {
      const rx = (c.x2 - c.x1) / 2, ry = (c.y2 - c.y1) / 2;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (x + 0.5 - (c.x1 + rx)) / rx, dy = (y + 0.5 - (c.y1 + ry)) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case 'circle': {
      const dx = x + 0.5 - c.cx, dy = y + 0.5 - c.cy;
      return dx * dx + dy * dy <= c.r * c.r;
    }
    case 'polygon': {
      // even-odd rule (Win32 ALTERNATE)
      const p = c.pts, n = p.length / 2, px = x + 0.5, py = y + 0.5;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = p[2 * i], yi = p[2 * i + 1], xj = p[2 * j], yj = p[2 * j + 1];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    default: return false;
  }
}

function sortList(list, mode) {
  if (mode === 'ascend') return list.slice().sort((a, b) => a.index - b.index);
  if (mode === 'descend') return list.slice().sort((a, b) => b.index - a.index);
  return list;
}

/**
 * Collisions of a character's current state, front to back: active animations (front first), then the base's
 * (or the base override's), then background animations.
 * @param {import('./surfaces.js').Shell} shell
 * @param {import('./surfaces.js').SurfaceDef} surf
 * @param {import('./animator.js').Animator} anim
 */
export function orderedCollisions(shell, surf, anim) {
  const out = [];
  const mode = surf.collisionSort || 'none';
  const front = surf.drawOrder.slice().reverse();
  for (const id of front) {
    const d = surf.anims.get(id);
    if (d.background || !d.collisions.length || !anim.active(id)) continue;
    out.push(...sortList(d.collisions, mode));
  }
  const ovr = anim.baseOverride();
  const baseSurf = ovr !== null ? shell.surface(ovr) : surf;
  if (baseSurf) out.push(...(ovr !== null ? sortList(baseSurf.collisions, baseSurf.collisionSort) : surf.collisions));
  for (const id of front) {
    const d = surf.anims.get(id);
    if (!d.background || !d.collisions.length || !anim.active(id)) continue;
    out.push(...sortList(d.collisions, mode));
  }
  return out;
}

/** Collision id at surface point (x, y): the first containing region's id, or '' when none. */
export function collisionAt(list, x, y) {
  for (const c of list) if (contains(c, x, y)) return c.id;
  return '';
}
