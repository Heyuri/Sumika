// Pointer -> MouseInfo state machine for one character (EV §4.1–4.5, SUM C10/C11/C23, UI §3.4, §9.4, §9.6).
// DOM-free: CharacterView feeds it normalised pointer records and acts on the drag callbacks.
//
// Emitted sequences (each item is one MouseInfo {type, scope, x, y, button, wheel, collision, device}):
//   click            down, up{click:true}, click
//   double click     down, up, click, dblclick (replaces the 2nd down), up, click            (C11)
//   drag (left, >=4 px; touch 10 px)   down, dragstart, dragend, up{click:false}  -- never click (C10)
//   hover enter/leave  enterall, enter(c) ... leave(c), enter(c2) ... leave(c2), leaveall   (EV §4.3)
//   wheel            wheel{wheel: ±120} per notch, positive = away from the user                (C23)
//   touch long press on a spot with no named collision: down, up{click:false}, down(1), up(1), click(1)
//   right drag (mouse, pen barrel; EV §4.5.1)   down(1), gesture{name}…, up(1){click:false}, gesture{name:'end'}
//                    once a step was made: no move, no click, no character drag while the right button is held
//   touch long press on a spot with no named collision, then a move >= 10 px: down, up{click:false}, down(1),
//                    gesture…, up(1){click:false}, gesture{end} [decision]; 'gesturestep' for each repeated up/down step
//   rest             hover{fresh, clientX, clientY, rest} after 500 ms without a move, only on a named collision
//                    (UI §4.8: SSP's tooltip rest, which also sends OnMouseHover [disasm CCharWndCode::ToolTipDispInfo])
// 'up' carries click:true when a 'click' follows it. Buttons: 0 left, 1 right, 2 middle (also Alt+left),
// 3/4 = X buttons.

const MOUSE = { dblTime: 500, dblDist: 4, dragDist: 4 };
const TOUCH = { dblTime: 300, dblDist: 20, dragDist: 10, longPress: 500 };
const HOVER_MS = 500;
const DOM_BUTTON = [0, 2, 1, 3, 4];   // DOM button -> SSP button (R5)

// Mouse gestures (EV §4.5.1) [disasm ssp.exe 2.9.10 CCharWndCode::OnEXMouseMove 0x417e55–0x418077]: the names by
// JPoint::DegreeToDirection8's sector (table 0xD39940); a step is a move of at least SM_CXDRAG (4 px, CSS px here as
// MOUSE.dragDist) from the last step's point (JPoint::Distance, inclusive)
export const GESTURE_DIRS = ['right_up', 'up', 'left_up', 'left', 'left_down', 'down', 'right_down', 'right'];
const GESTURE_STEP = 4;

/**
 * JPoint::Degree [disasm 0x5779d0]: the angle of the step (rx, ry) -> (cx, cy) in degrees, [0, 360), 0 = right,
 * 90 = up (screen y flipped); a step along an axis is exact.
 */
export function gestureDegree(rx, ry, cx, cy) {
  const dx = cx - rx, up = ry - cy;
  if (dx === 0) return up > 0 ? 90 : 270;
  if (up === 0) return dx > 0 ? 0 : 180;
  let r = Math.atan2(up, dx) / Math.PI;
  if (r < 0) r += 2;
  return r * 180;
}

/** JPoint::DegreeToDirection8 [disasm 0x577a70]: 45° sectors from 22.5° (lower bounds inclusive) -> GESTURE_DIRS index */
export function direction8(deg) {
  return deg < 22.5 || deg >= 337.5 ? 7 : Math.floor((deg - 22.5) / 45);
}

const realClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: id => clearTimeout(id),
};

/** Wheel deltas -> notches (C23): 100 px, 3 lines or 1 page per notch; positive = away from the user. */
export class WheelAccumulator {
  constructor({ idleMs = 1000 } = {}) { this.acc = 0; this.last = -Infinity; this.idleMs = idleMs; }
  /** @returns {number} whole notches to emit (signed) */
  push(deltaY, deltaMode, time) {
    const units = deltaMode === 1 ? -deltaY / 3 : deltaMode === 2 ? -deltaY : -deltaY / 100;
    if (time - this.last > this.idleMs || Math.sign(units) !== Math.sign(this.acc)) this.acc = 0;
    this.last = time;
    this.acc += units;
    const n = Math.trunc(this.acc + (this.acc > 0 ? 1e-9 : -1e-9)) || 0;
    this.acc -= n;
    return n;
  }
}

/**
 * @typedef {Object} PointerRecord
 * @property {number} x       client x (CSS px)
 * @property {number} y       client y
 * @property {number} sx      surface x
 * @property {number} sy      surface y
 * @property {string|null} hit  collision id ('' = no named collision), null = transparent / outside
 * @property {number} [wx]      window-local x: client x minus the base rect's left (CSS px; OnMouseGesture R1/R3)
 * @property {number} [wy]      window-local y
 * @property {string} [col]     collision id by shape only, '' = none (OnMouseGesture R2/R4: SSP tests no alpha)
 * @property {number} [button]  DOM button (down/up)
 * @property {string} [device]  'mouse' | 'touch' | 'pen' | 'eraser'
 * @property {boolean} [alt]
 * @property {number} [time]    ms
 */

export class MouseTracker {
  /**
   * @param {{scope:number, emit:(info:object)=>void, onDrag?:(kind:'start'|'move'|'end', dx:number, dy:number)=>void,
   *          clock?:{now:()=>number, setTimeout:Function, clearTimeout:Function}}} opts
   */
  constructor({ scope, emit, onDrag = () => {}, clock = realClock }) {
    this.scope = scope;
    this.emit = emit;
    this.onDrag = onDrag;
    this.clock = clock;
    this.press = null;
    this.inside = false;
    this.cur = null;          // collision under the pointer while inside
    this.lastPos = null;      // {sx, sy} of the last emitted move
    this.lastClick = null;
    this.hoverTimer = null;
    this.hovered = false;
    this.tipCollision = null; // the collision the last rest asked about (SSP's cache; reset by a rest off any
                              // collision and on leaving the window) [disasm 0x41FA90]
    this.rest = 0;            // bumped by every move, press and leave: a 'hover' is current while it is unchanged
    this.wheelAcc = new WheelAccumulator();
    this.gx = { xUp: 0, xDown: 0 };   // x of the last up / down gesture step: kept across presses, as SSP's
                                      // +0x574 / +0x578, which a press does not reset [disasm 0x417ef2, 0x41a84f]
    this.enabled = true;
  }

  _info(type, r, extra) {
    return {
      type, scope: this.scope, x: Math.floor(r.sx), y: Math.floor(r.sy), button: 0, wheel: 0,
      collision: r.hit === null || r.hit === undefined ? (this.cur || '') : r.hit, device: r.device || 'mouse', ...extra,
    };
  }

  _send(type, r, extra) { this.emit(this._info(type, r, extra)); }

  _time(r) { return r.time !== undefined ? r.time : this.clock.now(); }

  /** @param {PointerRecord} r @returns {boolean} the pointer should be captured */
  down(r) {
    if (this.press || r.hit === null || r.hit === undefined) return false;
    this._clearHover();
    const touch = r.device === 'touch';
    const P = touch ? TOUCH : MOUSE;
    let button = DOM_BUTTON[r.button | 0] ?? 0;
    if (button === 0 && r.alt) button = 2;
    const t = this._time(r);
    const lc = this.lastClick;
    const isDouble = !!(lc && lc.button === button && lc.touch === touch && t - lc.t <= P.dblTime &&
      Math.abs(r.x - lc.x) <= P.dblDist && Math.abs(r.y - lc.y) <= P.dblDist);
    this.lastClick = null;
    this.press = { button, x0: r.x, y0: r.y, t0: t, sx: r.sx, sy: r.sy, hit: r.hit, device: r.device || 'mouse',
      touch, dragging: false, stroke: false, long: false, longTimer: null, double: isDouble,
      wx0: r.wx, wy0: r.wy, col0: r.col ?? r.hit ?? '', g: null };
    // a right press starts a gesture (OnEXRButtonDown 0x41a820: the step state reset; InitDragValue: the reference
    // point, the press point and its collision); not the 2nd press of a right double-click, whose moves take the
    // OnMouseMove path (WM_RBUTTONDBLCLK) [disasm]. Touch gets there only by a long press (_toRightDrag)
    if (button === 1 && !isDouble && !touch) this.press.g = this._gStart(r.x, r.y);
    if (!touch) this._track(r);
    this._send(isDouble ? 'dblclick' : 'down', r, { button });
    if (touch && button === 0) {
      const p = this.press;
      p.longTimer = this.clock.setTimeout(() => {
        p.longTimer = null;
        if (this.press === p && !p.dragging && !p.stroke) p.long = true;
      }, TOUCH.longPress);
    }
    return true;
  }

  /** @param {PointerRecord} r @returns {void} */
  move(r) {
    const p = this.press;
    if (p) {
      // the right button held: gesture steps only; SSP sends no OnMouseMove (so no Enter/Leave) and never drags the
      // character then [disasm OnEXMouseMove 0x417e55–0x418077]
      if (p.g) { this._gStep(p, r); return; }
      if (!p.dragging && !p.stroke) {
        const d = Math.max(Math.abs(r.x - p.x0), Math.abs(r.y - p.y0));
        if (d >= (p.touch ? TOUCH.dragDist : MOUSE.dragDist) && p.button === 0) {
          this._clearLong(p);
          if (p.touch && p.long && p.hit === '') { this._toRightDrag(p); this._gStep(p, r); return; }
          if (p.touch && !p.long && p.hit !== '') p.stroke = true;   // stroking a named part (petting)
          else {
            p.dragging = true;
            this._send('dragstart', { sx: p.sx, sy: p.sy, hit: p.hit, device: p.device }, { button: 0 });
            this.onDrag('start', 0, 0);
          }
        }
      }
      if (p.dragging) { this.onDrag('move', r.x - p.x0, r.y - p.y0); return; }
      if (r.hit !== null && r.hit !== undefined) this._move(r);
      return;
    }
    if (r.device === 'touch') return;
    if (r.hit === null || r.hit === undefined) { this.leave(r); return; }
    this._track(r);
    this._move(r);
    this._armHover(r);
  }

  _track(r) {
    if (!this.inside) {
      this.inside = true;
      this.cur = r.hit;
      this._send('enterall', r);
      this._send('enter', r);
    } else if (r.hit !== this.cur) {
      this._send('leave', { ...r, hit: this.cur });
      this.cur = r.hit;
      this._send('enter', r);
    }
  }

  _move(r) {
    const fx = Math.floor(r.sx), fy = Math.floor(r.sy);
    if (this.lastPos && this.lastPos.sx === fx && this.lastPos.sy === fy) return;
    this.lastPos = { sx: fx, sy: fy };
    this._send('move', r);
  }

  /** @param {PointerRecord} r */
  up(r) {
    const p = this.press;
    if (!p) return;
    this.press = null;
    this._clearLong(p);
    const at = { sx: r.sx, sy: r.sy, hit: r.hit === null || r.hit === undefined ? p.hit : r.hit, device: p.device };
    if (p.g && p.g.last !== -1) {
      // a right drag that made a step: OnMouseUp(R5 1), then OnMouseGesture 'end' at the release point; the click
      // flag set, so neither OnMouseClick nor the menu [disasm OnEXRButtonUp 0x41ac6a–0x41ad3c, OnCWContextMenu]
      this._send('up', at, { button: 1, click: false });
      this._gSend('gesture', p, r, 'end', 0, -1);
      this.lastClick = null;
    } else if (p.dragging) {
      this._send('dragend', at, { button: 0 });
      this._send('up', at, { button: p.button, click: false });
      this.onDrag('end', r.x - p.x0, r.y - p.y0);
      this.lastClick = null;
    } else if (p.long && p.hit === '') {
      // touch long press on the body: a right click (the runtime menu)
      this._send('up', at, { button: 0, click: false });
      this._send('down', at, { button: 1 });
      this._send('up', at, { button: 1, click: true });
      this._send('click', at, { button: 1 });
      this.lastClick = null;
    } else {
      this._send('up', at, { button: p.button, click: true });
      this._send('click', at, { button: p.button });
      this.lastClick = p.double || p.stroke ? null : { t: p.t0, x: p.x0, y: p.y0, button: p.button, touch: p.touch };
    }
    if (p.touch) { this.inside = false; this.cur = null; }
    else if (r.hit === null || r.hit === undefined) this.leave(r);
  }

  /** pointercancel / lost capture: end the press without a click */
  cancel(r) {
    const p = this.press;
    if (!p) return;
    this.press = null;
    this._clearLong(p);
    const at = { sx: (r && r.sx) ?? p.sx, sy: (r && r.sy) ?? p.sy, hit: p.hit, device: p.device };
    if (p.dragging) {
      this._send('dragend', at, { button: 0 });
      this.onDrag('end', r ? r.x - p.x0 : 0, r ? r.y - p.y0 : 0);
    }
    this._send('up', at, { button: p.button, click: false });
    // a gesture under way ends as at a release, at the last point seen: SSP has no rule for a lost capture; this keeps
    // the ghosts' gesture arrays from running into the next gesture [decision, EV §4.5.1]
    if (p.g && p.g.last !== -1) this._gSend('gesture', p, p.g.at, 'end', 0, -1);
    this.lastClick = null;
  }

  // ---- gestures (EV §4.5.1)

  /** the step state of a right press at client (x, y) (OnEXRButtonDown 0x41a84f–0x41a871, InitDragValue) [disasm] */
  _gStart(x, y) {
    // at: the last record seen (a step has one); run: bumped by every new run (the touch wheel stand-in's key)
    return { rx: x, ry: y, last: -1, count: 0, seen: [0, 0, 0, 0, 0, 0, 0, 0], run: 0, at: null };
  }

  /**
   * One move while the right button is held [disasm OnEXMouseMove 0x417e61–0x41805b]: a move of GESTURE_STEP or more
   * from the last step's point is a step, and the point moves to it; a step in another sector than the last starts a
   * run (no event); each further step of the run counts, and the 4th in a row sends its direction once; a step after
   * every sector had a repeated one since the press (or the last circle) sends circle.cw (the last down step right of
   * the last up step) or circle.ccw instead. No time limit, no collision needed. Touch: 'gesturestep' for each
   * repeated up / down step, before that step's gesture: the EventLoop turns it into OnMouseWheel in a run whose
   * gesture got no Value (SSP's touch wheel stand-in, 0x417f5c–0x41802c).
   */
  _gStep(p, r) {
    const g = p.g;
    g.at = r;
    if (Math.hypot(r.x - g.rx, r.y - g.ry) < GESTURE_STEP) return;
    const deg = gestureDegree(g.rx, g.ry, r.x, r.y), dir = direction8(deg);
    g.rx = r.x;
    g.ry = r.y;
    if (dir !== g.last) { g.last = dir; g.count = 0; g.run++; return; }
    g.count++;
    g.seen[dir]++;
    if (dir === 1) this.gx.xUp = r.x;
    else if (dir === 5) this.gx.xDown = r.x;
    let name = g.count === 3 ? GESTURE_DIRS[dir] : null;
    if (g.seen.every(n => n > 0)) {
      g.seen.fill(0);
      name = this.gx.xDown > this.gx.xUp ? 'circle.cw' : 'circle.ccw';
    }
    if (p.touch && (dir === 1 || dir === 5)) this._gSend('gesturestep', p, r, null, deg, dir);
    if (name) this._gSend('gesture', p, r, name, deg, dir);
  }

  /**
   * A 'gesture' / 'gesturestep' MouseInfo: x, y, collision at the point (the collision by shape: SSP tests no alpha),
   * and what OnMouseGesture's References need (SendGestureEvent 0x418850): the window-local point now and at the
   * press, the press's collision, the name, the step's angle; dir and run for the touch wheel stand-in.
   */
  _gSend(type, p, r, name, deg, dir) {
    this._send(type, { sx: r.sx, sy: r.sy, hit: r.col ?? '', device: p.device }, {
      button: 1, name, deg, dir, run: p.g.run, wx: r.wx, wy: r.wy, wx0: p.wx0, wy0: p.wy0, collision0: p.col0,
      sx0: p.sx, sy0: p.sy,
    });
  }

  /**
   * A touch long press on a spot with no named collision is Sumika's right button (UI §9.6); moved TOUCH.dragDist or
   * more it becomes a right drag, so gestures [decision: EV §4.5.1]: the left press ends without a
   * click, a right press at the press point starts the gesture from there.
   */
  _toRightDrag(p) {
    const at0 = { sx: p.sx, sy: p.sy, hit: p.hit, device: p.device };
    this._send('up', at0, { button: 0, click: false });
    p.button = 1;
    this._send('down', at0, { button: 1 });
    p.g = this._gStart(p.x0, p.y0);
  }

  /** the pointer left the opaque area (or the page) */
  leave(r) {
    this._clearHover();
    this.tipCollision = null;
    if (this.press || !this.inside) return;
    const at = { sx: this.lastPos ? this.lastPos.sx : (r ? r.sx : 0), sy: this.lastPos ? this.lastPos.sy : (r ? r.sy : 0), hit: this.cur, device: (r && r.device) || 'mouse' };
    this._send('leave', at);
    this._send('leaveall', at);
    this.inside = false;
    this.cur = null;
    this.lastPos = null;
  }

  /** @param {PointerRecord & {deltaY:number, deltaMode:number}} r */
  wheel(r) {
    if (r.hit === null || r.hit === undefined) return;
    const n = this.wheelAcc.push(r.deltaY, r.deltaMode | 0, this._time(r));
    const k = Math.min(5, Math.abs(n));
    for (let i = 0; i < k; i++) this._send('wheel', r, { wheel: n > 0 ? 120 : -120 });
  }

  /**
   * The tooltip's rest (UI §4.8) [disasm CCharWndCode::ToolTipDispInfo 0x41FA90]: after HOVER_MS without a move,
   * 'hover' only on a named collision; `fresh` when it is not the one the last rest asked about (case-insensitive):
   * SSP sends OnMouseHover and asks the text again only then. A rest off any collision resets that memory.
   */
  _armHover(r) {
    this._clearHover();
    this.hovered = false;
    const at = { ...r };
    const rest = this.rest;
    this.hoverTimer = this.clock.setTimeout(() => {
      this.hoverTimer = null;
      if (this.press || !this.inside || this.hovered || rest !== this.rest) return;
      this.hovered = true;
      const c = this.cur;
      if (!c) { this.tipCollision = null; return; }
      const fresh = this.tipCollision === null || this.tipCollision.toLowerCase() !== c.toLowerCase();
      this.tipCollision = c;
      this._send('hover', { ...at, hit: c }, { fresh, clientX: at.x, clientY: at.y, rest });
    }, HOVER_MS);
  }

  _clearHover() {
    this.rest++;
    if (this.hoverTimer !== null) { this.clock.clearTimeout(this.hoverTimer); this.hoverTimer = null; }
  }

  _clearLong(p) {
    if (p.longTimer !== null) { this.clock.clearTimeout(p.longTimer); p.longTimer = null; }
  }

  destroy() {
    this._clearHover();
    if (this.press) this._clearLong(this.press);
    this.press = null;
  }
}
