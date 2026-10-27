/**
 * Everything Presence Floor Plan Card
 *
 * Shows a room built in the Everything Presence Zone Configurator add-on
 * (walls, floor, furniture, doors, sensor, zones) with the live positions
 * of the people the sensor is tracking.
 *
 * Layout comes from the add-on's API through Home Assistant ingress.
 * Live positions come straight from the sensor's Home Assistant entities,
 * so they update as fast as Home Assistant pushes state changes.
 */

const CARD_VERSION = '1.0.0';
const CARD_TAG = 'everything-presence-floorplan-card';
const EDITOR_TAG = `${CARD_TAG}-editor`;
const ADDON_SLUG_SUFFIX = 'everything-presence-zone-configurator';
const DEFAULT_ADDON_SLUG = `234db91b_${ADDON_SLUG_SUFFIX}`;
const CACHE_PREFIX = 'ep-floorplan-card:';
const SESSION_VALIDATE_MS = 5 * 60 * 1000;

const TARGET_COLORS = ['#2196f3', '#ff9800', '#e91e63', '#4caf50', '#9c27b0'];

const FLOOR_COLORS = {
  'wood-oak': ['#c9a16b', 'planks'],
  'wood-walnut': ['#6b4a33', 'planks'],
  'wood-cherry': ['#9a4e2e', 'planks'],
  'wood-ash': ['#d9c3a0', 'planks'],
  'wood-mahogany': ['#7a3324', 'planks'],
  'wood-herringbone': ['#b88b5a', 'herringbone'],
  'carpet-beige': ['#d8c8ae', 'solid'],
  'carpet-gray': ['#9a9a9a', 'solid'],
  'carpet-charcoal': ['#4b4b4f', 'solid'],
  'carpet-navy': ['#2f3e5c', 'solid'],
  'carpet-burgundy': ['#6e2735', 'solid'],
  'tile-white': ['#ececec', 'tiles'],
  'tile-gray': ['#b5b5b5', 'tiles'],
  'tile-terracotta': ['#c0643f', 'tiles'],
  'marble-white': ['#f2f0ec', 'tiles'],
  'marble-black': ['#2b2b2b', 'tiles'],
  slate: ['#5a6068', 'tiles'],
  concrete: ['#a7a39c', 'solid'],
  'vinyl-light': ['#e2d7c5', 'planks'],
};

const ZONE_STYLES = {
  regular: { stroke: '#2196f3', fill: 'rgba(33,150,243,0.12)' },
  exclusion: { stroke: '#f44336', fill: 'rgba(244,67,54,0.12)' },
  entry: { stroke: '#4caf50', fill: 'rgba(76,175,80,0.12)' },
};

const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, ft: 304.8 };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const fmt = (n) => (Math.round(n * 10) / 10).toString();

// ─────────────────────────────────────────────────────────────────
// Add-on access through Home Assistant ingress (shared by all cards)
// ─────────────────────────────────────────────────────────────────

const ingress = {
  slug: null,
  base: null,
  session: null,
  sessionPromise: null,
  validatedAt: 0,
};

const supervisorApi = async (hass, endpoint, method = 'get', data) => {
  const msg = { type: 'supervisor/api', endpoint, method };
  if (data) msg.data = data;
  const result = await hass.callWS(msg);
  // Some Supervisor responses arrive still wrapped in { data }.
  return result && typeof result === 'object' && Object.keys(result).length === 1 && result.data ? result.data : result;
};

const setSessionCookie = (session) => {
  const secure = location.protocol === 'https:' ? ';Secure' : '';
  document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
};

const resolveAddonBase = async (hass, slugOverride) => {
  if (ingress.base && (!slugOverride || slugOverride === ingress.slug)) return ingress.base;
  const candidates = [];
  if (slugOverride) candidates.push(slugOverride);
  else candidates.push(DEFAULT_ADDON_SLUG);

  let lastError;
  for (const slug of candidates) {
    try {
      const info = await supervisorApi(hass, `/addons/${slug}/info`);
      if (info?.ingress_url) {
        ingress.slug = slug;
        ingress.base = info.ingress_url.replace(/\/$/, '');
        return ingress.base;
      }
    } catch (err) {
      lastError = err;
    }
  }

  // The repository prefix in the slug differs between installs, so look it up.
  if (!slugOverride) {
    try {
      const list = await supervisorApi(hass, '/addons');
      const addon = (list?.addons ?? []).find((a) => String(a.slug).endsWith(ADDON_SLUG_SUFFIX));
      if (addon) return resolveAddonBase(hass, addon.slug);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not reach the Everything Presence add-on${lastError?.message ? ` (${lastError.message})` : ''}`,
  );
};

const ensureSession = async (hass, force = false) => {
  if (ingress.sessionPromise) return ingress.sessionPromise;
  const now = Date.now();
  if (!force && ingress.session && now - ingress.validatedAt < SESSION_VALIDATE_MS) return ingress.session;

  ingress.sessionPromise = (async () => {
    if (!force && ingress.session) {
      try {
        await supervisorApi(hass, '/ingress/validate_session', 'post', { session: ingress.session });
        ingress.validatedAt = Date.now();
        setSessionCookie(ingress.session);
        return ingress.session;
      } catch (_err) {
        // Fall through and create a fresh session.
      }
    }
    const result = await supervisorApi(hass, '/ingress/session', 'post');
    ingress.session = result.session;
    ingress.validatedAt = Date.now();
    setSessionCookie(ingress.session);
    return ingress.session;
  })();

  try {
    return await ingress.sessionPromise;
  } finally {
    ingress.sessionPromise = null;
  }
};

const addonFetch = async (hass, path, slug) => {
  const base = await resolveAddonBase(hass, slug);
  await ensureSession(hass);
  let response = await fetch(`${base}${path}`, { credentials: 'same-origin' });
  if (response.status === 401 || response.status === 403) {
    await ensureSession(hass, true);
    response = await fetch(`${base}${path}`, { credentials: 'same-origin' });
  }
  if (!response.ok) throw new Error(`Add-on returned ${response.status} for ${path}`);
  return response.json();
};

const readCache = (key) => {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
};

const writeCache = (key, value) => {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch (_err) {
    // Storage full or blocked; the card still works without a cache.
  }
};

const pickRoom = (rooms, wanted, defaultRoomId) => {
  if (!Array.isArray(rooms) || !rooms.length) return null;
  if (wanted) {
    const w = String(wanted).trim().toLowerCase();
    return rooms.find((r) => r.id === wanted) ?? rooms.find((r) => String(r.name ?? '').trim().toLowerCase() === w) ?? null;
  }
  return rooms.find((r) => r.id === defaultRoomId) ?? rooms[0];
};

const normaliseRoomsPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rooms)) return payload.rooms;
  if (payload?.room) return [payload.room];
  if (payload && typeof payload === 'object' && payload.id) return [payload];
  return [];
};

// ─────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────

const signedArea = (points) => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
};

const polygonPath = (points) =>
  points.length ? `M${points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join('L')}Z` : '';

const humanise = (typeId) =>
  String(typeId ?? '')
    .replace(/^custom-[0-9a-f]+$/i, 'Custom')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

// ─────────────────────────────────────────────────────────────────
// Furniture drawings (top-down, centred on 0,0, head of the item at -y)
// ─────────────────────────────────────────────────────────────────

const furnitureSvg = (item, customTypes) => {
  const w = Math.max(10, num(item.width) ?? 500);
  const d = Math.max(10, num(item.depth) ?? 500);
  const hw = w / 2;
  const hd = d / 2;
  const t = String(item.typeId ?? '').toLowerCase();
  const sw = Math.max(6, Math.min(w, d) * 0.02);
  const rect = (x, y, rw, rh, fill, stroke, rx = 0, extra = '') =>
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.max(0, rw))}" height="${fmt(Math.max(0, rh))}" rx="${fmt(rx)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${fmt(sw)}"` : ''}${extra}/>`;
  const ellipse = (cx, cy, rx, ry, fill, stroke, extra = '') =>
    `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${fmt(sw)}"` : ''}${extra}/>`;

  const custom = customTypes?.find((c) => c.id === item.typeId);
  if (custom) {
    const color = /^#[0-9a-f]{3,8}$/i.test(custom.color ?? '') ? custom.color : '#8d8d8d';
    if (custom.shape === 'circle') return ellipse(0, 0, hw, hd, color, 'rgba(0,0,0,0.35)');
    if (custom.shape === 'lshaped') {
      return `<path d="M${-hw},${-hd}H${hw}V${-hd + d * 0.45}H${-hw + w * 0.45}V${hd}H${-hw}Z" fill="${color}" stroke="rgba(0,0,0,0.35)" stroke-width="${fmt(sw)}"/>`;
    }
    return rect(-hw, -hd, w, d, color, 'rgba(0,0,0,0.35)', custom.shape === 'rounded' ? Math.min(w, d) * 0.15 : 0);
  }

  if (t.startsWith('rug')) {
    const fill = '#9c6b5e';
    if (t.includes('round')) {
      return ellipse(0, 0, hw, hd, fill, null, ' opacity="0.55"') + ellipse(0, 0, hw * 0.8, hd * 0.8, 'none', '#e8d5c4', ' opacity="0.6"');
    }
    return rect(-hw, -hd, w, d, fill, null, 0, ' opacity="0.55"') + rect(-hw * 0.85, -hd * 0.85, w * 0.85, d * 0.85, 'none', '#e8d5c4', 0, ' opacity="0.6"');
  }
  if (t.startsWith('bed') || t === 'crib') {
    const head = Math.min(d * 0.1, 180);
    const pillowH = Math.min(d * 0.14, 300);
    const pillows = w > 1200
      ? rect(-hw + w * 0.08, -hd + head + 40, w * 0.38, pillowH, '#ffffff', '#dcdcdc', 40) + rect(w * 0.04, -hd + head + 40, w * 0.38, pillowH, '#ffffff', '#dcdcdc', 40)
      : rect(-hw + w * 0.12, -hd + head + 40, w * 0.76, pillowH, '#ffffff', '#dcdcdc', 40);
    return rect(-hw, -hd, w, d, '#c8a882', '#a88b6a') +
      rect(-hw, -hd, w, head, '#a88b6a') +
      rect(-hw + w * 0.03, -hd + head * 0.8, w * 0.94, d - head * 0.8 - d * 0.03, '#e8d5c4', '#d4c2b1', 30) +
      rect(-hw + w * 0.03, hd - d * 0.38, w * 0.94, d * 0.35, '#8aa1b8', null, 30, ' opacity="0.8"') +
      pillows;
  }
  if (/sofa|armchair|recliner|chaise|loveseat/.test(t)) {
    const back = Math.min(d * 0.25, 220);
    const arm = Math.min(w * 0.12, 180);
    let seats = '';
    const count = t.includes('3') ? 3 : t.includes('2') ? 2 : 1;
    const sw2 = (w - arm * 2) / count;
    for (let i = 0; i < count; i++) {
      seats += rect(-hw + arm + sw2 * i + 10, -hd + back, sw2 - 20, d - back - 30, '#7f93ab', '#5f7389', 30);
    }
    if (t.includes('lshaped')) {
      return `<path d="M${-hw},${-hd}H${hw}V${hd}H${hw - w * 0.4}V${-hd + d * 0.45}H${-hw}Z" fill="#6b7f96" stroke="#4f6278" stroke-width="${fmt(sw)}"/>`;
    }
    return rect(-hw, -hd, w, d, '#6b7f96', '#4f6278', 40) +
      rect(-hw, -hd, w, back, '#566a80', null, 40) +
      rect(-hw, -hd, arm, d, '#566a80', null, 30) +
      rect(hw - arm, -hd, arm, d, '#566a80', null, 30) +
      seats;
  }
  if (/plant/.test(t)) {
    return ellipse(0, 0, hw, hd, '#4f8a4b', '#3c6b39') + ellipse(-hw * 0.3, -hd * 0.2, hw * 0.45, hd * 0.45, '#6aa864') + ellipse(hw * 0.3, hd * 0.25, hw * 0.4, hd * 0.4, '#5c9a56');
  }
  if (/lamp/.test(t)) {
    return ellipse(0, 0, hw, hd, '#f6e7b4', '#d1bd7a') + ellipse(0, 0, hw * 0.3, hd * 0.3, '#d1bd7a');
  }
  if (/bean-bag|ottoman|stool|round/.test(t)) {
    const fill = /table/.test(t) ? '#b8875a' : '#8d7a6b';
    return ellipse(0, 0, hw, hd, fill, 'rgba(0,0,0,0.3)');
  }
  if (/chair/.test(t)) {
    const back = Math.min(d * 0.22, 120);
    return rect(-hw, -hd, w, d, '#5d5d5d', '#3d3d3d', Math.min(w, d) * 0.2) + rect(-hw, -hd, w, back, '#3d3d3d', null, Math.min(w, d) * 0.1);
  }
  if (/table|desk|island|bar|bench|console|credenza|sideboard/.test(t)) {
    const fill = /island|bar/.test(t) ? '#d9d4cc' : '#b8875a';
    const stroke = /island|bar/.test(t) ? '#a9a39a' : '#8f6640';
    return rect(-hw, -hd, w, d, fill, stroke, 20) + rect(-hw + w * 0.06, -hd + d * 0.08, w * 0.88, d * 0.84, 'none', 'rgba(255,255,255,0.25)', 15);
  }
  if (/bathtub|shower|toilet|sink|vanity/.test(t)) {
    if (t === 'toilet') {
      return rect(-hw, -hd, w, d * 0.3, '#f5f5f5', '#c9c9c9', 20) + ellipse(0, d * 0.12, hw * 0.85, hd * 0.6, '#ffffff', '#c9c9c9');
    }
    return rect(-hw, -hd, w, d, '#f5f5f5', '#c9c9c9', 40) + rect(-hw + w * 0.1, -hd + d * 0.1, w * 0.8, d * 0.8, '#dceaf2', '#b9cfdb', Math.min(w, d) * 0.2);
  }
  if (/fridge|refrigerator|washing|dryer|dishwasher|oven|cooker|stove|freezer/.test(t)) {
    return rect(-hw, -hd, w, d, '#eeeeee', '#bdbdbd', 20) + (/(washing|dryer)/.test(t) ? ellipse(0, d * 0.05, Math.min(hw, hd) * 0.65, Math.min(hw, hd) * 0.65, '#cfd8dc', '#9e9e9e') : '');
  }
  if (/tv|entertainment|fireplace/.test(t)) {
    return rect(-hw, -hd, w, d, '#3e3e3e', '#222222', 15) + rect(-hw + w * 0.05, -hd, w * 0.9, Math.min(d * 0.25, 60), '#111111');
  }
  if (/wardrobe|dresser|drawers|cabinet|bookshelf|shelf|nightstand|storage|rack|filing|shoe/.test(t)) {
    return rect(-hw, -hd, w, d, '#7a5a44', '#5c4033', 10) + `<line x1="${fmt(-hw)}" y1="${fmt(hd - d * 0.12)}" x2="${fmt(hw)}" y2="${fmt(hd - d * 0.12)}" stroke="#5c4033" stroke-width="${fmt(sw)}"/>`;
  }
  return rect(-hw, -hd, w, d, '#a1887f', '#795548', 20);
};

// ─────────────────────────────────────────────────────────────────
// Door drawing, in a frame where the wall runs left to right through y=0
// and +y points into the room when inwardSign is 1.
// ─────────────────────────────────────────────────────────────────

const doorSvg = (door, inwardSign, wallWidth) => {
  const width = num(door.widthMm) > 0 ? num(door.widthMm) : 800;
  const half = width / 2;
  const style = ['single', 'sliding', 'opening', 'double'].includes(door.style) ? door.style : 'single';
  const swingIn = door.swingDirection !== 'out';
  const swingSign = style === 'sliding' || style === 'opening' ? inwardSign : swingIn ? inwardSign : -inwardSign;
  const s = swingSign >= 0 ? 1 : -1;
  const stroke = 'var(--epfc-wall)';
  const sw = Math.max(15, wallWidth * 0.35);
  let out = `<rect x="${fmt(-half)}" y="${fmt(-wallWidth / 2 - 2)}" width="${fmt(width)}" height="${fmt(wallWidth + 4)}" fill="var(--epfc-card)"/>`;
  if (style === 'single') {
    const hinge = door.swingSide === 'right' ? half : -half;
    const start = -hinge;
    const endY = s * width;
    const sweep = (start - hinge) * endY > 0 ? 1 : 0;
    out += `<line x1="${fmt(hinge)}" y1="0" x2="${fmt(hinge)}" y2="${fmt(endY)}" stroke="${stroke}" stroke-width="${fmt(sw)}" stroke-linecap="round"/>`;
    out += `<path d="M${fmt(start)},0 A${fmt(width)},${fmt(width)} 0 0 ${sweep} ${fmt(hinge)},${fmt(endY)}" fill="none" stroke="${stroke}" stroke-width="${fmt(sw * 0.4)}" stroke-dasharray="${fmt(sw * 1.5)} ${fmt(sw)}" opacity="0.7"/>`;
  } else if (style === 'double') {
    const endY = s * half;
    const leaf = (hinge, sweep) =>
      `<line x1="${fmt(hinge)}" y1="0" x2="${fmt(hinge)}" y2="${fmt(endY)}" stroke="${stroke}" stroke-width="${fmt(sw)}" stroke-linecap="round"/>` +
      `<path d="M0,0 A${fmt(half)},${fmt(half)} 0 0 ${sweep} ${fmt(hinge)},${fmt(endY)}" fill="none" stroke="${stroke}" stroke-width="${fmt(sw * 0.4)}" stroke-dasharray="${fmt(sw * 1.5)} ${fmt(sw)}" opacity="0.7"/>`;
    out += leaf(-half, s > 0 ? 1 : 0) + leaf(half, s > 0 ? 0 : 1);
  } else if (style === 'sliding') {
    const dir = door.swingSide === 'right' ? 1 : -1;
    const start = dir > 0 ? 0 : -half;
    const depth = Math.max(24, width * 0.08);
    out += `<line x1="${fmt(start)}" y1="${fmt((s * depth) / 4)}" x2="${fmt(start + half)}" y2="${fmt((s * depth) / 4)}" stroke="${stroke}" stroke-width="${fmt(sw)}" stroke-linecap="round"/>`;
  }
  // Door jambs
  out += `<line x1="${fmt(-half)}" y1="${fmt(-wallWidth / 2)}" x2="${fmt(-half)}" y2="${fmt(wallWidth / 2)}" stroke="var(--epfc-wall)" stroke-width="${fmt(sw * 0.6)}"/>`;
  out += `<line x1="${fmt(half)}" y1="${fmt(-wallWidth / 2)}" x2="${fmt(half)}" y2="${fmt(wallWidth / 2)}" stroke="var(--epfc-wall)" stroke-width="${fmt(sw * 0.6)}"/>`;
  return out;
};

// ─────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────

class EverythingPresenceFloorplanCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return { type: `custom:${CARD_TAG}` };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._room = null;
    this._mapping = null;
    this._customFurniture = [];
    this._customFloors = [];
    this._error = null;
    this._loading = false;
    this._layoutKey = null;
    this._trails = new Map();
    this._refreshTimer = null;
    this._renderedTargets = '';
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    if (config.room_config && typeof config.room_config !== 'object') {
      throw new Error('room_config must be a room object from the add-on');
    }
    const previous = this._config;
    this._config = {
      show_furniture: true,
      show_doors: true,
      show_device: true,
      show_coverage: true,
      show_zones: false,
      show_header: true,
      show_target_labels: true,
      trail_seconds: 0,
      target_size: 350,
      refresh_interval: 300,
      ...config,
    };
    const keyChanged =
      !previous ||
      previous.room !== this._config.room ||
      previous.addon_slug !== this._config.addon_slug ||
      previous.room_url !== this._config.room_url ||
      JSON.stringify(previous.room_config) !== JSON.stringify(this._config.room_config);
    if (keyChanged) {
      this._room = null;
      this._mapping = null;
      this._error = null;
      this._loadCachedLayout();
      if (this._hass) this._loadLayout();
    }
    this._layoutKey = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._config && !this._room?._fromConfig) this._loadLayout();
    this._updateLive();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._startRefresh();
  }

  disconnectedCallback() {
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }

  getCardSize() {
    return 7;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 4, rows: 'auto', min_rows: 3 };
  }

  _startRefresh() {
    clearInterval(this._refreshTimer);
    const seconds = num(this._config?.refresh_interval) ?? 300;
    if (seconds > 0) {
      this._refreshTimer = setInterval(() => this._loadLayout(true), Math.max(15, seconds) * 1000);
    }
  }

  _cacheKey() {
    return `room:${this._config?.room ?? '(default)'}`;
  }

  _loadCachedLayout() {
    if (this._config.room_config) {
      this._room = { ...this._config.room_config, _fromConfig: true };
      return;
    }
    const cached = readCache(this._cacheKey());
    if (cached?.room) {
      this._room = cached.room;
      this._mapping = cached.mapping ?? null;
      this._customFurniture = cached.customFurniture ?? [];
      this._customFloors = cached.customFloors ?? [];
    }
  }

  async _loadLayout(background = false) {
    if (!this._hass || !this._config || this._loading) return;
    if (this._config.room_config) {
      this._room = { ...this._config.room_config, _fromConfig: true };
      this._render();
      return;
    }
    this._loading = true;
    try {
      let rooms;
      let defaultRoomId = null;
      let mapping = null;
      let customFurniture = [];
      let customFloors = [];
      if (this._config.room_url) {
        const response = await fetch(this._config.room_url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`room_url returned ${response.status}`);
        rooms = normaliseRoomsPayload(await response.json());
      } else {
        const slug = this._config.addon_slug;
        const [roomsPayload, settings] = await Promise.all([
          addonFetch(this._hass, '/api/rooms', slug),
          this._config.room ? Promise.resolve(null) : addonFetch(this._hass, '/api/settings', slug).catch(() => null),
        ]);
        rooms = normaliseRoomsPayload(roomsPayload);
        defaultRoomId = settings?.settings?.defaultRoomId ?? settings?.defaultRoomId ?? null;
        const picked = pickRoom(rooms, this._config.room, defaultRoomId);
        const [mappingPayload, furniturePayload, floorsPayload] = await Promise.all([
          picked?.deviceId
            ? addonFetch(this._hass, `/api/device-mappings/${encodeURIComponent(picked.deviceId)}`, slug).catch(() => null)
            : Promise.resolve(null),
          addonFetch(this._hass, '/api/custom-assets/furniture', slug).catch(() => null),
          addonFetch(this._hass, '/api/custom-assets/floors', slug).catch(() => null),
        ]);
        mapping = mappingPayload?.mapping ?? mappingPayload ?? null;
        customFurniture = furniturePayload?.furniture ?? (Array.isArray(furniturePayload) ? furniturePayload : []);
        customFloors = floorsPayload?.floors ?? (Array.isArray(floorsPayload) ? floorsPayload : []);
      }
      const room = pickRoom(rooms, this._config.room, defaultRoomId);
      if (!room) {
        const names = rooms.map((r) => r.name).filter(Boolean).join(', ');
        throw new Error(
          this._config.room
            ? `No room called "${this._config.room}" in the add-on${names ? ` (rooms: ${names})` : ''}`
            : 'The add-on has no rooms yet. Build one in the Zone Configurator first.',
        );
      }
      this._room = room;
      this._mapping = mapping;
      this._customFurniture = customFurniture;
      this._customFloors = customFloors;
      this._error = null;
      writeCache(this._cacheKey(), { room, mapping, customFurniture, customFloors, savedAt: Date.now() });
    } catch (err) {
      // Keep showing the last good layout during a background refresh.
      if (!background || !this._room) {
        const text = err?.message ?? String(err);
        this._error = /unauthori[sz]ed|admin/i.test(text)
          ? 'This user cannot open the Everything Presence add-on. Load the dashboard once as an admin, or set room_url in the card.'
          : text;
      }
    } finally {
      this._loading = false;
      this._layoutKey = null;
      this._render();
    }
  }

  // ── Entity resolution ────────────────────────────────────────

  _deviceEntities() {
    const deviceId = this._room?.deviceId;
    const registry = this._hass?.entities;
    if (!deviceId || !registry) return [];
    return Object.values(registry)
      .filter((e) => e.device_id === deviceId)
      .map((e) => e.entity_id);
  }

  _resolveEntities() {
    const memoKey = [this._room, this._mapping, this._config, this._hass?.entities];
    if (this._entityMemo && this._entityMemo.key.every((v, i) => v === memoKey[i])) {
      return this._entityMemo.value;
    }
    const value = this._computeEntities();
    this._entityMemo = { key: memoKey, value };
    return value;
  }

  _computeEntities() {
    const cfg = this._config;
    const mapped = this._mapping?.mappings ?? {};
    const units = this._mapping?.entityUnits ?? {};
    const deviceEntities = this._deviceEntities();
    const prefix = this._mapping?.esphomeNodeName ? null : this._room?.entityNamePrefix;
    const states = this._hass?.states ?? {};

    const findByPattern = (re, domain) =>
      deviceEntities.find((id) => (!domain || id.startsWith(`${domain}.`)) && re.test(id)) ?? null;

    const targets = [];
    if (Array.isArray(cfg.targets) && cfg.targets.length) {
      cfg.targets.forEach((t, i) => targets.push({ id: i + 1, x: t.x, y: t.y, active: t.active ?? null }));
    } else {
      for (let n = 1; n <= 5; n++) {
        const x =
          mapped[`target${n}X`] ??
          findByPattern(new RegExp(`target_${n}_x$`), 'sensor') ??
          (prefix ? `sensor.${prefix}_target_${n}_x` : null);
        const y =
          mapped[`target${n}Y`] ??
          findByPattern(new RegExp(`target_${n}_y$`), 'sensor') ??
          (prefix ? `sensor.${prefix}_target_${n}_y` : null);
        const active =
          mapped[`target${n}Active`] ??
          findByPattern(new RegExp(`target_${n}_active$`), 'binary_sensor') ??
          (prefix ? `binary_sensor.${prefix}_target_${n}_active` : null);
        if (x && y && (states[x] || states[y] || cfg.room_config)) {
          targets.push({ id: n, x, y, active, unitX: units[`target${n}X`], unitY: units[`target${n}Y`] });
        }
      }
    }

    const angle =
      cfg.installation_angle_entity ??
      mapped.installationAngle ??
      findByPattern(/(installation_angle|tracking_sensor_angle)$/, 'number') ??
      (prefix ? `number.${prefix}_installation_angle` : null);

    const presence =
      cfg.presence_entity ??
      mapped.presence ??
      findByPattern(/_occupancy$/, 'binary_sensor') ??
      (prefix ? `binary_sensor.${prefix}_occupancy` : null);

    // Prefer an occupancy sensor that is not one of the per-zone ones.
    const roomPresence =
      presence && /zone_\d+_occupancy$/.test(presence)
        ? deviceEntities.find((id) => id.startsWith('binary_sensor.') && /_occupancy$/.test(id) && !/zone_\d+_/.test(id)) ?? presence
        : presence;

    return { targets, angle, presence: roomPresence };
  }

  _toMm(entityId, mappedUnit) {
    const state = this._hass?.states?.[entityId];
    if (!state) return null;
    const value = num(state.state);
    if (value === null) return null;
    const unit = String(mappedUnit ?? state.attributes?.unit_of_measurement ?? 'mm').toLowerCase();
    return value * (UNIT_TO_MM[unit] ?? 1);
  }

  _installationAngle(entities) {
    if (num(this._config.installation_angle) !== null) return num(this._config.installation_angle);
    if (!entities.angle) return 0;
    return num(this._hass?.states?.[entities.angle]?.state) ?? 0;
  }

  _deviceToRoom(dx, dy, installationAngle) {
    const placement = this._room?.devicePlacement;
    if (!placement) return { x: dx, y: dy };
    const rad = (((num(placement.rotationDeg) ?? 0) + installationAngle) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: dx * cos - dy * sin + (num(placement.x) ?? 0),
      y: dx * sin + dy * cos + (num(placement.y) ?? 0),
    };
  }

  _livePositions() {
    if (!this._room || !this._hass) return { targets: [], presence: null, entities: null };
    const entities = this._resolveEntities();
    const angle = this._installationAngle(entities);
    const states = this._hass.states;
    const targets = [];
    for (const t of entities.targets) {
      const x = this._toMm(t.x, t.unitX);
      const y = this._toMm(t.y, t.unitY);
      if (x === null || y === null) continue;
      const activeState = t.active ? states[t.active]?.state : undefined;
      // Same rule as the add-on: 0,0 means "no target" unless the sensor says it is active.
      if (x === 0 && y === 0 && activeState !== 'on') continue;
      targets.push({ id: t.id, ...this._deviceToRoom(x, y, angle) });
    }
    const presenceState = entities.presence ? states[entities.presence]?.state : undefined;
    return {
      targets,
      presence: presenceState === 'on' ? true : presenceState === 'off' ? false : null,
      entities,
      angle,
    };
  }

  // ── Rendering ────────────────────────────────────────────────

  _bounds() {
    const pts = [...(this._room?.roomShell?.points ?? [])];
    const placement = this._room?.devicePlacement;
    if (placement && num(placement.x) !== null) pts.push({ x: placement.x, y: placement.y });
    if (!pts.length) {
      // No outline drawn: show the sensor's 6 m range around it.
      const cx = num(placement?.x) ?? 0;
      const cy = num(placement?.y) ?? 0;
      return { minX: cx - 3500, minY: cy - 500, maxX: cx + 3500, maxY: cy + 6500 };
    }
    const xs = pts.map((p) => num(p.x) ?? 0);
    const ys = pts.map((p) => num(p.y) ?? 0);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  _floorFill(defs) {
    const room = this._room;
    const material = room?.floorMaterial;
    if (room?.roomShellFillMode === 'overlay' || !material || material === 'none') return 'var(--epfc-floor)';
    let entry = FLOOR_COLORS[material];
    if (!entry) {
      const custom = this._customFloors?.find((f) => f.id === material);
      if (custom && /^#[0-9a-f]{3,8}$/i.test(custom.color ?? '')) {
        entry = [custom.color, custom.patternType === 'checker' ? 'tiles' : custom.patternType === 'stripes' ? 'planks' : 'solid'];
      }
    }
    if (!entry) return 'var(--epfc-floor)';
    const [color, pattern] = entry;
    if (pattern === 'solid') return color;
    const id = 'epfc-floor-pattern';
    if (pattern === 'planks') {
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="1200" height="180">` +
          `<rect width="1200" height="180" fill="${color}"/>` +
          `<path d="M0,179H1200M400,0V90M1000,90V180" stroke="rgba(0,0,0,0.18)" stroke-width="8"/>` +
          `</pattern>`,
      );
    } else if (pattern === 'herringbone') {
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="300" height="300">` +
          `<rect width="300" height="300" fill="${color}"/>` +
          `<path d="M0,150L150,0M150,300L300,150M0,150L150,300M150,0L300,150" stroke="rgba(0,0,0,0.18)" stroke-width="8"/>` +
          `</pattern>`,
      );
    } else {
      defs.push(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" width="400" height="400">` +
          `<rect width="400" height="400" fill="${color}"/>` +
          `<path d="M0,0H400M0,0V400" stroke="rgba(0,0,0,0.15)" stroke-width="8"/>` +
          `</pattern>`,
      );
    }
    return `url(#${id})`;
  }

  _buildLayoutSvg(live) {
    const room = this._room;
    const cfg = this._config;
    const b = this._bounds();
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1000);
    const pad = span * 0.04 + 150;
    const vb = { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
    const wall = Math.max(60, span * 0.012);
    this._scale = span;

    const defs = [];
    const points = (room.roomShell?.points ?? []).map((p) => ({ x: num(p.x) ?? 0, y: num(p.y) ?? 0 }));
    const hasShell = points.length >= 3;
    const floorFill = this._floorFill(defs);

    let layers = '';

    if (hasShell) {
      defs.push(`<clipPath id="epfc-room-clip"><path d="${polygonPath(points)}"/></clipPath>`);
      layers += `<path d="${polygonPath(points)}" fill="${floorFill}"/>`;
    }

    // Sensor coverage wedge (clipped to the room)
    const placement = room.devicePlacement;
    if (cfg.show_coverage && placement && num(placement.x) !== null) {
      const fov = num(placement.horizontalFovDeg) ?? num(cfg.coverage_fov) ?? 120;
      const range = (num(cfg.coverage_range) ?? 6) * 1000;
      let path;
      if (placement.mountType === 'ceiling' && !num(placement.horizontalFovDeg)) {
        const r = Math.min(range, 3000);
        path = `M${fmt(placement.x - r)},${fmt(placement.y)}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
      } else {
        const steps = 24;
        const pts = [this._deviceToRoom(0, 0, live.angle ?? 0)];
        for (let i = 0; i <= steps; i++) {
          const a = ((-fov / 2 + (fov * i) / steps) * Math.PI) / 180;
          pts.push(this._deviceToRoom(range * Math.sin(a), range * Math.cos(a), live.angle ?? 0));
        }
        path = polygonPath(pts);
      }
      layers += `<path d="${path}" fill="var(--epfc-accent)" opacity="0.08"${hasShell ? ' clip-path="url(#epfc-room-clip)"' : ''}/>`;
    }

    if (cfg.show_furniture && Array.isArray(room.furniture)) {
      // Rugs sit underneath everything else.
      const items = [...room.furniture].sort((a, b) => (String(b.typeId).startsWith('rug') ? 1 : 0) - (String(a.typeId).startsWith('rug') ? 1 : 0));
      for (const item of items) {
        const x = num(item.x);
        const y = num(item.y);
        if (x === null || y === null) continue;
        const title = esc(cfg.furniture_labels?.[item.id] ?? humanise(item.typeId));
        layers += `<g transform="translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(num(item.rotationDeg) ?? 0)})"><title>${title}</title>${furnitureSvg(item, this._customFurniture)}</g>`;
      }
    }

    if (cfg.show_zones && Array.isArray(room.zones)) {
      for (const zone of room.zones) {
        if (zone.enabled === false) continue;
        const x = num(zone.x);
        const y = num(zone.y);
        const w = num(zone.width);
        const h = num(zone.height);
        if ([x, y, w, h].some((v) => v === null) || !w || !h) continue;
        const style = ZONE_STYLES[zone.type] ?? ZONE_STYLES.regular;
        const corners = [
          this._deviceToRoom(x, y, live.angle ?? 0),
          this._deviceToRoom(x + w, y, live.angle ?? 0),
          this._deviceToRoom(x + w, y + h, live.angle ?? 0),
          this._deviceToRoom(x, y + h, live.angle ?? 0),
        ];
        layers += `<path d="${polygonPath(corners)}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="${fmt(wall * 0.4)}" stroke-dasharray="${fmt(wall)} ${fmt(wall * 0.6)}"/>`;
        if (zone.label) {
          const c = this._deviceToRoom(x + w / 2, y + h / 2, live.angle ?? 0);
          layers += `<text x="${fmt(c.x)}" y="${fmt(c.y)}" class="label" font-size="${fmt(span * 0.03)}" fill="${style.stroke}">${esc(zone.label)}</text>`;
        }
      }
    }

    if (hasShell) {
      layers += `<path d="${polygonPath(points)}" fill="none" stroke="var(--epfc-wall)" stroke-width="${fmt(wall)}" stroke-linejoin="round"/>`;
    }

    if (cfg.show_doors && hasShell && Array.isArray(room.doors)) {
      const inward = signedArea(points) >= 0 ? 1 : -1;
      for (const door of room.doors) {
        const i = Math.trunc(num(door.segmentIndex) ?? -1);
        if (i < 0 || i >= points.length) continue;
        const a = points[i];
        const c = points[(i + 1) % points.length];
        const t = Math.min(1, Math.max(0, num(door.positionOnSegment) ?? 0.5));
        const px = a.x + (c.x - a.x) * t;
        const py = a.y + (c.y - a.y) * t;
        const angle = (Math.atan2(c.y - a.y, c.x - a.x) * 180) / Math.PI;
        layers += `<g transform="translate(${fmt(px)} ${fmt(py)}) rotate(${fmt(angle)})">${doorSvg(door, inward, wall)}</g>`;
      }
    }

    if (cfg.show_device && placement && num(placement.x) !== null) {
      const size = Math.max(140, span * 0.03);
      const rot = (num(placement.rotationDeg) ?? 0) + (live.angle ?? 0);
      layers +=
        `<g transform="translate(${fmt(placement.x)} ${fmt(placement.y)}) rotate(${fmt(rot)})"><title>${esc(room.name ?? 'Sensor')} sensor</title>` +
        `<rect x="${fmt(-size)}" y="${fmt(-size * 0.45)}" width="${fmt(size * 2)}" height="${fmt(size * 0.9)}" rx="${fmt(size * 0.25)}" fill="var(--epfc-device)" stroke="var(--epfc-card)" stroke-width="${fmt(size * 0.15)}"/>` +
        `<path d="M${fmt(-size * 0.35)},${fmt(size * 0.45)}L0,${fmt(size * 0.95)}L${fmt(size * 0.35)},${fmt(size * 0.45)}Z" fill="var(--epfc-device)"/>` +
        `</g>`;
    }

    const targetLayer = '<g class="trails"></g><g class="targets"></g>';
    return (
      `<svg viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(room.name ?? 'Room')} floor plan">` +
      `<defs>${defs.join('')}</defs>${layers}${targetLayer}</svg>`
    );
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const cfg = this._config;
    if (!this.shadowRoot.querySelector('ha-card')) {
      this.shadowRoot.innerHTML = `
        <style>${EverythingPresenceFloorplanCard.styles}</style>
        <ha-card>
          <div class="header"><div class="title"></div><div class="status"></div></div>
          <div class="plan"></div>
          <div class="message"></div>
        </ha-card>`;
    }
    const card = this.shadowRoot.querySelector('ha-card');
    const header = card.querySelector('.header');
    const plan = card.querySelector('.plan');
    const message = card.querySelector('.message');

    const titleText = cfg.title === false ? '' : cfg.title ?? this._room?.name ?? 'Floor plan';
    header.style.display = cfg.show_header === false || (cfg.title === false && cfg.show_status === false) ? 'none' : '';
    header.querySelector('.title').textContent = titleText;

    if (cfg.max_height) plan.style.maxHeight = typeof cfg.max_height === 'number' ? `${cfg.max_height}px` : String(cfg.max_height);
    else plan.style.maxHeight = '';

    if (!this._room) {
      plan.innerHTML = '';
      message.textContent = this._error ?? 'Loading floor plan…';
      message.classList.toggle('error', Boolean(this._error));
      return;
    }
    message.textContent = this._error ? `Showing saved layout. ${this._error}` : '';
    message.classList.toggle('error', false);

    const live = this._livePositions();
    const key = JSON.stringify([this._room, this._customFurniture, this._customFloors, cfg, live.angle ?? 0]);
    if (key !== this._layoutKey) {
      this._layoutKey = key;
      plan.innerHTML = this._buildLayoutSvg(live);
      this._renderedTargets = '';
    }
    this._updateLive(live);
  }

  _updateLive(precomputed) {
    if (!this._room || !this._hass || !this.shadowRoot) return;
    const live = precomputed ?? this._livePositions();
    if (!precomputed && (live.angle ?? 0) !== this._lastAngle) {
      this._lastAngle = live.angle ?? 0;
      this._layoutKey = null;
      this._render();
      return;
    }
    this._lastAngle = live.angle ?? 0;
    const svg = this.shadowRoot.querySelector('.plan svg');
    if (!svg) return;
    const cfg = this._config;
    const radius = (num(cfg.target_size) ?? 350) / 2;

    // Status chip
    const status = this.shadowRoot.querySelector('.status');
    if (status) {
      const count = live.targets.length;
      const occupied = count > 0 || live.presence === true;
      status.textContent = cfg.show_status === false ? '' : count > 0 ? `${count} ${count === 1 ? 'person' : 'people'}` : occupied ? 'Occupied' : 'Clear';
      status.classList.toggle('on', occupied);
    }

    // Trails
    const trailSeconds = num(cfg.trail_seconds) ?? 0;
    const now = Date.now();
    const trailLayer = svg.querySelector('.trails');
    if (trailSeconds > 0) {
      for (const t of live.targets) {
        const list = this._trails.get(t.id) ?? [];
        const last = list[list.length - 1];
        if (!last || Math.hypot(last.x - t.x, last.y - t.y) > 30) list.push({ x: t.x, y: t.y, at: now });
        this._trails.set(t.id, list);
      }
      let trailSvg = '';
      for (const [id, list] of this._trails) {
        const fresh = list.filter((p) => now - p.at <= trailSeconds * 1000);
        this._trails.set(id, fresh);
        if (fresh.length < 2) continue;
        const color = TARGET_COLORS[(id - 1) % TARGET_COLORS.length];
        trailSvg += `<polyline points="${fresh.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${fmt(radius * 0.35)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"/>`;
      }
      trailLayer.innerHTML = trailSvg;
    } else if (trailLayer.innerHTML) {
      trailLayer.innerHTML = '';
    }

    // Targets: move existing dots so the CSS transition animates them.
    const layer = svg.querySelector('.targets');
    const seen = new Set();
    for (const t of live.targets) {
      seen.add(String(t.id));
      let g = layer.querySelector(`g[data-id="${t.id}"]`);
      const color = cfg.target_color ?? TARGET_COLORS[(t.id - 1) % TARGET_COLORS.length];
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-id', String(t.id));
        g.setAttribute('class', 'target');
        g.innerHTML =
          `<circle class="halo" r="${fmt(radius * 1.8)}" fill="${color}"/>` +
          `<circle r="${fmt(radius)}" fill="${color}" stroke="#fff" stroke-width="${fmt(radius * 0.18)}"/>` +
          (cfg.show_target_labels
            ? `<text class="target-label" y="${fmt(radius * 0.36)}" font-size="${fmt(radius * 1.05)}">${t.id}</text>`
            : '');
        // Place it before the first paint so it does not slide in from the origin.
        g.style.transform = `translate(${fmt(t.x)}px, ${fmt(t.y)}px)`;
        layer.appendChild(g);
      } else {
        g.style.transform = `translate(${fmt(t.x)}px, ${fmt(t.y)}px)`;
      }
    }
    for (const g of [...layer.querySelectorAll('g[data-id]')]) {
      if (!seen.has(g.getAttribute('data-id'))) g.remove();
    }
    if (!live.targets.length && trailSeconds <= 0) this._trails.clear();
  }

  static get styles() {
    return `
      :host {
        --epfc-accent: var(--primary-color, #03a9f4);
        --epfc-wall: var(--epfc-wall-color, var(--primary-text-color, #212121));
        --epfc-floor: var(--epfc-floor-color, var(--secondary-background-color, #f5f5f5));
        --epfc-device: var(--epfc-device-color, var(--primary-color, #03a9f4));
        --epfc-card: var(--ha-card-background, var(--card-background-color, #fff));
        display: block;
      }
      ha-card { overflow: hidden; height: 100%; display: flex; flex-direction: column; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px 4px; }
      .title { font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .status { font-size: 0.85em; padding: 2px 10px; border-radius: 12px; color: var(--secondary-text-color); background: var(--secondary-background-color, rgba(127,127,127,0.12)); white-space: nowrap; }
      .status:empty { display: none; }
      .status.on { color: var(--text-primary-color, #fff); background: var(--epfc-accent); }
      .plan { flex: 1; display: flex; padding: 8px 12px 12px; min-height: 0; }
      .plan svg { width: 100%; height: 100%; max-height: inherit; display: block; }
      .message { padding: 0 16px 12px; font-size: 0.85em; color: var(--secondary-text-color); }
      .message:empty { display: none; }
      .message.error { color: var(--error-color, #db4437); }
      .label { text-anchor: middle; dominant-baseline: middle; font-family: inherit; }
      .target { transition: transform 0.6s linear; }
      .target .halo { opacity: 0.18; animation: epfc-pulse 2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
      .target-label { text-anchor: middle; fill: #fff; font-weight: 700; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      @keyframes epfc-pulse { 0%, 100% { transform: scale(0.85); opacity: 0.25; } 50% { transform: scale(1.1); opacity: 0.08; } }
      @media (prefers-reduced-motion: reduce) { .target { transition: none; } .target .halo { animation: none; } }
    `;
  }
}

// ─────────────────────────────────────────────────────────────────
// Visual editor
// ─────────────────────────────────────────────────────────────────

class EverythingPresenceFloorplanCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._rooms = null;
    this._roomsError = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._rooms === null && !this._loadingRooms) this._loadRooms();
    if (this._form) this._form.hass = hass;
  }

  async _loadRooms() {
    this._loadingRooms = true;
    try {
      const payload = await addonFetch(this._hass, '/api/rooms', this._config.addon_slug);
      this._rooms = normaliseRoomsPayload(payload);
    } catch (err) {
      this._rooms = [];
      this._roomsError = err?.message ?? String(err);
    }
    this._loadingRooms = false;
    this._render();
  }

  _schema() {
    const roomField = this._rooms?.length
      ? {
          name: 'room',
          selector: {
            select: {
              mode: 'dropdown',
              options: this._rooms.map((r) => ({ value: r.name ?? r.id, label: r.name ?? r.id })),
            },
          },
        }
      : { name: 'room', selector: { text: {} } };
    return [
      roomField,
      { name: 'title', selector: { text: {} } },
      {
        type: 'grid',
        name: '',
        schema: [
          { name: 'show_furniture', selector: { boolean: {} } },
          { name: 'show_doors', selector: { boolean: {} } },
          { name: 'show_device', selector: { boolean: {} } },
          { name: 'show_coverage', selector: { boolean: {} } },
          { name: 'show_zones', selector: { boolean: {} } },
          { name: 'show_target_labels', selector: { boolean: {} } },
        ],
      },
      {
        type: 'grid',
        name: '',
        schema: [
          { name: 'trail_seconds', selector: { number: { min: 0, max: 120, step: 5, mode: 'box', unit_of_measurement: 's' } } },
          { name: 'target_size', selector: { number: { min: 100, max: 1000, step: 50, mode: 'box', unit_of_measurement: 'mm' } } },
          { name: 'max_height', selector: { number: { min: 0, max: 2000, step: 10, mode: 'box', unit_of_measurement: 'px' } } },
        ],
      },
    ];
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) =>
        ({
          room: 'Room',
          title: 'Title (defaults to the room name)',
          show_furniture: 'Furniture',
          show_doors: 'Doors',
          show_device: 'Sensor',
          show_coverage: 'Sensor coverage',
          show_zones: 'Zones',
          show_target_labels: 'Number people',
          trail_seconds: 'Movement trail',
          target_size: 'Person dot size',
          max_height: 'Maximum height',
        })[s.name] ?? s.name;
      this._form.addEventListener('value-changed', (ev) => {
        const config = { ...ev.detail.value };
        for (const k of Object.keys(config)) if (config[k] === '' || config[k] === undefined) delete config[k];
        this._config = config;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
      this._note = document.createElement('p');
      this._note.style.cssText = 'color: var(--secondary-text-color); font-size: 0.9em;';
      this.appendChild(this._note);
    }
    this._form.hass = this._hass;
    this._form.data = {
      show_furniture: true,
      show_doors: true,
      show_device: true,
      show_coverage: true,
      show_zones: false,
      show_target_labels: true,
      trail_seconds: 0,
      target_size: 350,
      ...this._config,
    };
    this._form.schema = this._schema();
    this._note.textContent = this._roomsError
      ? `Couldn't list rooms from the add-on (${this._roomsError}). Type the room name instead.`
      : 'Leave Room empty to show the add-on\'s default room.';
  }
}

customElements.define(CARD_TAG, EverythingPresenceFloorplanCard);
customElements.define(EDITOR_TAG, EverythingPresenceFloorplanCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: 'Everything Presence Floor Plan',
  description: 'Live floor plan with furniture and tracked people from the Everything Presence Zone Configurator.',
  preview: false,
  documentationURL: 'https://github.com/chris-standley/everything-presence-floorplan-card',
});

console.info(`%c EVERYTHING-PRESENCE-FLOORPLAN-CARD %c ${CARD_VERSION} `, 'color:#fff;background:#03a9f4;font-weight:700', 'color:#03a9f4;background:#fff');
