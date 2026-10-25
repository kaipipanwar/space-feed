// Earth Scope: the Earth over one place, seen through a scope, from the city out to the whole planet.
// Keys (PC keyboard or TV remote): left/right = pictures, up = zoom out, down = zoom in, S = change place.
// All data comes from free public services that allow web pages to read them; news.json is made by the
// GitHub Action (make_news.py), because news feeds do not allow that.
'use strict';

const W = 1920, H = 1080;
const $ = (id) => document.getElementById(id);
const NEON = '#39ff14';
const LEVELS = ['city', 'state', 'country', 'continent', 'earth'];
const CONTINENTS = {   // [south, west, north, east] boxes for the continent level
  Asia: [-12, 25, 72, 150], Europe: [34, -25, 72, 45], Africa: [-36, -20, 38, 55],
  'North America': [5, -170, 75, -50], 'South America': [-56, -85, 14, -33], Oceania: [-48, 110, 5, 180],
  Antarctica: [-90, -180, -60, 180],
};
const EUMETSAT = 'https://view.eumetsat.int/geoserver/ows';
const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const DAILY = ['MODIS_Terra_CorrectedReflectance_TrueColor', 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
  'VIIRS_SNPP_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor'];
const LOOP_FRAMES = 16, LOOP_STEP_MS = 1100, AUTO_VIEW_MS = 45000;

const state = { place: null, level: 0, view: 0, boxes: {}, views: [], loop: null, news: null, data: {}, lastKey: 0 };

// ---------- small helpers ----------

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const qs = (o) => new URLSearchParams(o).toString();
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const pad2 = (n) => String(n).padStart(2, '0');
const compass = (d) => 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW'.split(' ')[Math.round(d / 22.5) % 16];
const fmt = (n, d = 0) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function distanceKm(a, b, c, d) {
  const x = Math.sin(rad(a)) * Math.sin(rad(c)) + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
  return 6371 * Math.acos(Math.max(-1, Math.min(1, x)));
}

function sunPosition(lat, lon, when) {
  const start = Date.UTC(when.getUTCFullYear(), 0, 0), day = Math.floor((when - start) / 864e5);
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60;
  const decl = rad(-23.44) * Math.cos(2 * Math.PI / 365 * (day + 10));
  const ha = rad(15 * (hour + lon / 15 - 12)), p = rad(lat);
  const el = Math.asin(Math.sin(p) * Math.sin(decl) + Math.cos(p) * Math.cos(decl) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(p) - Math.tan(decl) * Math.cos(p));
  return { el: deg(el), az: (deg(az) + 180) % 360 };
}

function moon(when) {
  const month = 29.530588, age = ((when - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % month;
  const lit = (1 - Math.cos(2 * Math.PI * age / month)) / 2;
  const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
  return `${names[Math.floor((age / month * 8 + 0.5) % 8)]}, ${Math.round(lit * 100)}% lit`;
}

function densityAltitude(hpa, tempC) {   // how high the air "feels" to a bullet or a plane (metres)
  const paFt = (1 - (hpa / 1013.25) ** 0.190284) * 145366.45, isa = 15 - 1.98 * paFt / 1000;
  return (paFt + 118.8 * (tempC - isa)) * 0.3048;
}

const aqiName = (v) => v <= 50 ? 'good' : v <= 100 ? 'moderate' : v <= 150 ? 'unhealthy for some' : v <= 200 ? 'unhealthy' : v <= 300 ? 'very unhealthy' : 'hazardous';

// A 16:9 box (south, west, north, east) around a centre, from a latitude span.
function box16x9(lat, lon, latSpan) {
  const lonSpan = latSpan * 16 / 9;
  return [lat - latSpan / 2, lon - lonSpan / 2, lat + latSpan / 2, lon + lonSpan / 2];
}

// Grow any box to 16:9 (plus a margin) around its own centre.
function fit16x9([s, w, n, e], margin = 1.15) {
  let latSpan = (n - s) * margin, lonSpan = (e - w) * margin;
  if (lonSpan / latSpan < 16 / 9) lonSpan = latSpan * 16 / 9; else latSpan = lonSpan * 9 / 16;
  const lat = (s + n) / 2, lon = (w + e) / 2;
  return [lat - latSpan / 2, lon - lonSpan / 2, lat + latSpan / 2, lon + lonSpan / 2];
}

// Where a place falls on screen inside a box (plain latitude/longitude grid).
const onScreen = ([s, w, n, e], lat, lon) => ({ x: (lon - w) / (e - w) * W, y: (n - lat) / (n - s) * H });

const wmsBox = ([s, w, n, e]) => `${s},${w},${n},${e}`;   // WMS 1.3.0 with EPSG:4326 wants lat,lon order

// ---------- the place ----------

async function findPlace() {
  const url = new URLSearchParams(location.search);
  if (url.get('lat') && url.get('lon')) return describe(+url.get('lat'), +url.get('lon'), url.get('name'));
  try { const saved = JSON.parse(localStorage.getItem('earthscope.place')); if (saved) return saved; } catch { /* private window */ }
  const news = await loadNews();
  if (news?.place) return searchCity(news.place, news.country);
  return null;
}

async function searchCity(name, country) {
  const r = await json(`https://geocoding-api.open-meteo.com/v1/search?${qs({ name, count: 10, language: 'en' })}`);
  const hit = (r.results || []).find((p) => !country || p.country === country) || (r.results || [])[0];
  if (!hit) throw new Error(`No place called ${name}`);
  return describe(hit.latitude, hit.longitude, hit.name);
}

async function describe(lat, lon, name) {
  const r = await json(`https://api.bigdatacloud.net/data/reverse-geocode-client?${qs({ latitude: lat, longitude: lon, localityLanguage: 'en' })}`);
  return { lat, lon, name: name || r.city || r.locality, state: r.principalSubdivision, country: r.countryName, continent: r.continent };
}

function savePlace(p) { try { localStorage.setItem('earthscope.place', JSON.stringify(p)); } catch { /* fine */ } }

// The picture area of each level.
async function levelBoxes(p) {
  const nom = async (params) => {
    const r = await json(`https://nominatim.openstreetmap.org/search?${qs({ ...params, format: 'json', limit: 1 })}`);
    const b = r[0]?.boundingbox?.map(Number);   // [south, north, west, east]
    return b ? fit16x9([b[0], b[2], b[1], b[3]]) : null;
  };
  // The weather satellites see ~4 km per pixel, so the city view is ~3,500 km wide to stay sharp.
  const boxes = { city: box16x9(p.lat, p.lon, 18), earth: [-90, -180, 90, 180] };
  boxes.state = (await nom({ state: p.state, country: p.country }).catch(() => null)) || box16x9(p.lat, p.lon, 14);
  boxes.country = (await nom({ country: p.country }).catch(() => null)) || box16x9(p.lat, p.lon, 32);
  boxes.continent = fit16x9(CONTINENTS[p.continent] || [p.lat - 35, p.lon - 62, p.lat + 35, p.lon + 62], 1.0);
  return boxes;
}

function levelTitle(level) {
  const p = state.place;
  return { city: p.name, state: p.state, country: p.country, continent: p.continent, earth: 'Earth' }[level] || level;
}

// ---------- pictures ----------

// Which weather satellite sees this longitude best, and whether it gives natural colour.
function geoSource(lon) {
  if (lon >= 10 && lon <= 110) return { kind: 'eumetsat', layer: 'msg_iodc:rgb_naturalenhncd', name: 'EUMETSAT Meteosat (Indian Ocean)' };
  if (lon >= -60 && lon < 10) return { kind: 'eumetsat', layer: 'msg_fes:rgb_naturalenhncd', name: 'EUMETSAT Meteosat (0°)' };
  if (lon < -105 || lon > 170) return { kind: 'gibs', layer: 'GOES-West_ABI_GeoColor', name: 'NOAA GOES-West', step: 10 };
  if (lon < -60) return { kind: 'gibs', layer: 'GOES-East_ABI_GeoColor', name: 'NOAA GOES-East', step: 10 };
  return { kind: 'gibs', layer: 'Himawari_AHI_Band3_Red_Visible_1km', name: 'JMA Himawari (visible, grey)', step: 10 };
}

let capsCache = null;
async function newestEumetsat(layer) {
  if (!capsCache || Date.now() - capsCache.at > 10 * 60e3) {
    const xml = await (await fetch(`${EUMETSAT}?service=WMS&request=GetCapabilities&version=1.3.0`)).text();
    capsCache = { at: Date.now(), xml };
  }
  const block = capsCache.xml.slice(capsCache.xml.indexOf(`<Name>${layer}</Name>`));
  const m = block.match(/<Dimension name="time"[^>]*>[^<]*\/([0-9T:\-.]+)Z\/PT15M/);
  return new Date(m[1].slice(0, 16) + ':00Z');
}

// The newest daylight picture times for a box (oldest first), searching back up to 30 hours.
async function loopTimes(box, src) {
  const cLat = (box[0] + box[2]) / 2, cLon = (box[1] + box[3]) / 2;
  const step = (src.step || 15) * 60e3;
  let newest = src.kind === 'eumetsat' ? await newestEumetsat(src.layer)
    : new Date(Math.floor((Date.now() - 50 * 60e3) / step) * step);
  const times = [];
  for (let t = newest.getTime(); times.length < LOOP_FRAMES && t > newest - 30 * 3600e3; t -= step) {
    if (sunPosition(cLat, cLon, new Date(t)).el >= 8) times.push(new Date(t));
  }
  return times.reverse();
}

function geoUrl(box, src, time, width, height) {
  const t = time.toISOString().slice(0, 16) + ':00Z';
  if (src.kind === 'eumetsat') {
    return `${EUMETSAT}?${qs({ service: 'WMS', request: 'GetMap', version: '1.3.0', layers: src.layer, styles: '', crs: 'EPSG:4326',
      bbox: wmsBox(box), format: 'image/jpeg', width, height, time: t })}`;
  }
  return `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: src.layer, CRS: 'EPSG:4326',
    BBOX: wmsBox(box), FORMAT: 'image/jpeg', WIDTH: width, HEIGHT: height, TIME: t })}`;
}

const loadImage = (src) => new Promise((ok, fail) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = fail; i.src = src; });

// Share of black pixels: gaps between a satellite's stripes, or night.
function blackShare(img) {
  const c = document.createElement('canvas'); c.width = 96; c.height = 54;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, 96, 54);
  const d = g.getImageData(0, 0, 96, 54).data; let black = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 24) black++;
  return black / (96 * 54);
}

// The newest sharp daily picture of a box that has no big gaps.
async function newestDaily(box, maxGap) {
  for (let back = 0; back < 4; back++) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    for (const layer of DAILY) {
      const url = (w, h) => `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: layer, CRS: 'EPSG:4326',
        BBOX: wmsBox(box), FORMAT: 'image/jpeg', WIDTH: w, HEIGHT: h, TIME: day })}`;
      try {
        if (blackShare(await loadImage(url(192, 108))) <= maxGap) return { url: url(W, H), day, layer };
      } catch { /* try the next one */ }
    }
  }
  return null;
}

// NASA EPIC: the newest whole-Earth photo taken while this longitude faced the camera.
async function newestGlobe(p) {
  const photos = await json('https://epic.gsfc.nasa.gov/api/natural');
  const off = (q) => Math.abs(((q.centroid_coordinates.lon - p.lon + 540) % 360) - 180);
  const best = photos.sort((a, b) => off(a) - off(b))[0];
  const d = best.date.slice(0, 10).replace(/-/g, '/');
  return { url: `https://epic.gsfc.nasa.gov/archive/natural/${d}/jpg/${best.image}.jpg`, photo: best };
}

// Where the place is on an EPIC photo shown "contain" on the screen. The globe sits in the middle of the
// photo; its size follows from the satellite's distance and the camera's 0.6225° field of view (measured).
function globeTarget(photo, p) {
  const pos = photo.dscovr_j2000_position, dist = Math.hypot(pos.x, pos.y, pos.z);
  const rr = deg(Math.asin(6378 / dist)) / 0.6225 * H;   // globe radius in screen pixels (photo shown 1080 tall)
  const p0 = rad(photo.centroid_coordinates.lat), pl = rad(p.lat), dl = rad(p.lon - photo.centroid_coordinates.lon);
  const x = Math.cos(pl) * Math.sin(dl), y = Math.cos(p0) * Math.sin(pl) - Math.sin(p0) * Math.cos(pl) * Math.cos(dl);
  return { x: W / 2 + rr * x, y: H / 2 - rr * y };
}

// The pictures (views) of a level; left/right moves between them.
function viewsFor(level) {
  const box = state.boxes[level];
  if (level === 'earth') return [{ kind: 'globe', name: 'whole Earth, NASA EPIC' }, { kind: 'daily', name: 'world today', box, gap: 0.3 }];
  const views = [{ kind: 'loop', name: 'live loop', box }, { kind: 'still', name: 'newest picture', box }];
  const sharp = level === 'city' ? box16x9(state.place.lat, state.place.lon, 1.5) : box;
  const daily = { kind: 'daily', name: 'sharpest today', box: sharp, gap: level === 'city' ? 0.01 : 0.08 };
  // Small areas: the sharp daily picture first (the 15-minute satellite is blocky this close).
  return level === 'city' || level === 'state' ? [daily, ...views] : [...views, daily];
}

let showToken = 0;
async function showView() {
  const token = ++showToken;
  stopLoop();
  const level = LEVELS[state.level], view = state.views[state.view], p = state.place;
  renderViews();
  status('loading pictures …');
  try {
    if (view.kind === 'globe') {
      const g = await newestGlobe(p);
      if (token !== showToken) return;
      setPicture(g.url, true);   // NASA's photos may be shown but not read by a page, so no loadImage here
      const target = globeTarget(g.photo, p);
      setSource('NASA EPIC camera, 1.5 million km away');
      setFrameTime(new Date(g.photo.date.replace(' ', 'T') + 'Z'));
      drawReticle(target, 0.35);
    } else if (view.kind === 'daily') {
      const d = await newestDaily(view.box, view.gap);
      if (token !== showToken) return;
      if (!d) throw new Error('no clear daily picture in the last 4 days');
      setPicture(d.url, level === 'earth');
      setSource(`NASA ${d.layer.split('_').slice(0, 2).join(' ')} · ${d.day}`);
      setFrameTime(null, d.day);
      drawReticle(level === 'earth' ? onEarthMap(p) : onScreen(view.box, p.lat, p.lon), level === 'city' ? 1 : 0.6);
    } else {
      const src = geoSource((view.box[1] + view.box[3]) / 2);
      const times = await loopTimes(view.box, src);
      if (token !== showToken) return;
      const target = onScreen(view.box, p.lat, p.lon);
      setSource(`${src.name} · every ${src.step || 15} min`);
      drawReticle(target, level === 'city' ? 1 : 0.6);
      if (view.kind === 'still') {
        const t = times[times.length - 1];
        setPicture(geoUrl(view.box, src, t, W, H));
        setFrameTime(t);
      } else {
        await startLoop(view.box, src, times, token);
      }
    }
    status('');
  } catch (e) {
    console.warn(e);
    status(`picture not available: ${e.message}`);
  }
}

// The world map is 2:1, shown "contain" in the 16:9 screen.
function onEarthMap(p) {
  const mapH = W / 2, top = (H - mapH) / 2;
  return { x: (p.lon + 180) / 360 * W, y: top + (90 - p.lat) / 180 * mapH };
}

let front = 'imgA', pictureCount = 0;
function setPicture(url, contain = false) {
  const mine = ++pictureCount;   // a slow older picture must not cover a newer one
  const next = front === 'imgA' ? 'imgB' : 'imgA';
  const img = $(next);
  img.classList.toggle('contain', contain);
  img.onload = () => {
    if (mine !== pictureCount) return;
    img.classList.add('on'); $(front).classList.remove('on'); front = next;
  };
  img.src = url;
}

async function startLoop(box, src, times, token) {
  // Show the newest picture at once; the server is slow, so the loop starts when all frames are in.
  const newest = times[times.length - 1];
  setPicture(geoUrl(box, src, newest, 960, 540));
  setFrameTime(newest);
  status(`loading ${times.length} pictures for the loop …`);
  // Small pictures (the satellite sees ~4 km per pixel anyway).
  const frames = [];
  await Promise.all(times.map(async (t, i) => {
    try { frames[i] = { t, img: await loadImage(geoUrl(box, src, t, 960, 540)) }; } catch { /* skip a missing frame */ }
  }));
  const ok = frames.filter(Boolean);
  if (token !== showToken || !ok.length) return;
  let i = 0;
  const step = () => {
    const f = ok[i % ok.length];
    setPicture(f.img.src);
    setFrameTime(f.t);
    i++;
  };
  step();
  state.loop = setInterval(step, LOOP_STEP_MS);
}

function stopLoop() { clearInterval(state.loop); state.loop = null; }

// ---------- the scope ----------

// A thin, see-through rifle-scope reticle on the place, plus a separate bright line straight through it.
function drawReticle(target, scale) {
  const c = $('reticle'), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const { x, y } = target, ring = 300 * scale, gap = 26 * scale;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(57,255,20,0.32)';
  g.lineWidth = 1.5;
  g.beginPath();
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    g.moveTo(x + sx * gap, y + sy * gap); g.lineTo(x + sx * 4000, y + sy * 4000);
    for (let k = 1; k < 5; k++) {   // range marks
      const r = gap + k * (ring - gap) / 5;
      if (sx) { g.moveTo(x + sx * r, y - 9); g.lineTo(x + sx * r, y + 9); } else { g.moveTo(x - 9, y + sy * r); g.lineTo(x + 9, y + sy * r); }
    }
  }
  g.stroke();
  g.lineWidth = 4;   // thicker posts outside the ring, still see-through
  g.beginPath();
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1]]) { g.moveTo(x + sx * ring, y + sy * ring); g.lineTo(x + sx * 4000, y + sy * 4000); }
  g.stroke();
  g.lineWidth = 1.5;
  g.beginPath(); g.arc(x, y, ring, 0, Math.PI * 2); g.stroke();

  // The "you are here" line: bright, solid, the whole height of the screen.
  g.save();
  g.shadowColor = NEON; g.shadowBlur = 14;
  g.strokeStyle = 'rgba(57,255,20,0.9)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 120); g.stroke();
  g.restore();
  g.fillStyle = NEON; g.font = '700 26px Rajdhani, sans-serif'; g.textAlign = 'center';
  const tag = `▼ ${state.place.name.toUpperCase()}`;
  g.fillText(tag, Math.max(120, Math.min(W - 120, x)), 26);

  // The solid centre dot and the coordinates.
  g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = NEON; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
  const p = state.place, lab = `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'}`
    + (state.data.elevation != null ? ` · ${Math.round(state.data.elevation)} m` : '');
  g.font = '700 26px "Share Tech Mono", monospace'; g.textAlign = 'left';
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.strokeText(lab, x + 20, y - 18);
  g.fillText(lab, x + 20, y - 18);
}

// ---------- data for each level ----------

async function cityData(p) {
  const wx = await json(`https://api.open-meteo.com/v1/forecast?${qs({
    latitude: p.lat, longitude: p.lon, timezone: 'auto', forecast_days: 1,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,'
      + 'cloud_cover,visibility,uv_index,surface_pressure,pressure_msl,dew_point_2m,precipitation',
    hourly: 'soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm',
    daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min,uv_index_max' })}`);
  state.data.elevation = wx.elevation;
  state.data.tz = wx.timezone; state.data.tzOffset = wx.utc_offset_seconds;
  const c = wx.current, d = wx.daily, now = new Date();
  const hour = wx.hourly.time.indexOf(c.time.slice(0, 13) + ':00');
  const soil = ['0_to_1cm', '1_to_3cm', '3_to_9cm', '9_to_27cm', '27_to_81cm'].map((k) => [k.replace(/_to_/, '–').replace('cm', ' cm'),
    wx.hourly[`soil_moisture_${k}`][Math.max(0, hour)]]);
  const air = await json(`https://air-quality-api.open-meteo.com/v1/air-quality?${qs({ latitude: p.lat, longitude: p.lon, current: 'us_aqi,pm2_5,pm10' })}`).catch(() => null);
  const quakes = await quakeCount({ latitude: p.lat, longitude: p.lon, maxradiuskm: 300 }, 30, 2.5);
  const iss = await json('https://api.wheretheiss.at/v1/satellites/25544').catch(() => null);
  const sun = sunPosition(p.lat, p.lon, now);
  state.data.aqi = air?.current?.us_aqi; state.data.temp = c.temperature_2m;
  return {
    rows: [
      `${fmt(c.temperature_2m)}°C, feels ${fmt(c.apparent_temperature)}°C · today ${fmt(d.temperature_2m_min[0])}–${fmt(d.temperature_2m_max[0])}°C`,
      `Wind ${fmt(c.wind_speed_10m)} km/h from ${compass(c.wind_direction_10m)} · humidity ${fmt(c.relative_humidity_2m)}%`,
      `Cloud ${fmt(c.cloud_cover)}% · visibility ${fmt(c.visibility / 1000)} km · rain ${fmt(c.precipitation, 1)} mm`,
      `UV now ${fmt(c.uv_index)}, peak ${fmt(d.uv_index_max[0])} · sunrise ${d.sunrise[0].slice(11)} · sunset ${d.sunset[0].slice(11)}`,
      air ? `Air: AQI ${fmt(air.current.us_aqi)} (${aqiName(air.current.us_aqi)}) · PM2.5 ${fmt(air.current.pm2_5)} · PM10 ${fmt(air.current.pm10)}` : 'Air: —',
      `Earthquakes ≤300 km, 30 days: ${quakes}`,
      iss ? `Space station: ${fmt(distanceKm(p.lat, p.lon, iss.latitude, iss.longitude))} km away, ${fmt(iss.altitude)} km up` : '',
    ].filter(Boolean),
    sideTitle: 'SCOPE DATA',
    side: [
      ['WIND', `${(c.wind_speed_10m / 3.6).toFixed(1)} m/s · ${pad2(Math.round(c.wind_direction_10m)).padStart(3, '0')}° ${compass(c.wind_direction_10m)}`],
      ['GUSTS', `${(c.wind_gusts_10m / 3.6).toFixed(1)} m/s`],
      ['TEMP', `${c.temperature_2m.toFixed(1)}°C · dew ${c.dew_point_2m.toFixed(1)}°C`],
      ['HUMID', `${Math.round(c.relative_humidity_2m)}%`],
      ['PRESS', `${Math.round(c.surface_pressure)} hPa · ${Math.round(c.pressure_msl)} MSL`],
      ['DENS ALT', `${fmt(densityAltitude(c.surface_pressure, c.temperature_2m))} m`],
      ['VIS', `${(c.visibility / 1000).toFixed(1)} km`],
      ['SUN', `az ${pad2(Math.round(sun.az)).padStart(3, '0')}° · el ${sun.el >= 0 ? '+' : ''}${Math.round(sun.el)}°`],
      ['MOON', moon(now)],
    ],
    soil,
  };
}

async function quakeCount(area, days, minMag) {
  try {
    const r = await json(`https://earthquake.usgs.gov/fdsnws/event/1/query?${qs({ format: 'geojson', minmagnitude: minMag,
      starttime: new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), ...area })}`);
    if (!r.features.length) return 'none';
    const big = r.features.reduce((a, b) => (a.properties.mag > b.properties.mag ? a : b));
    return `${r.features.length} (biggest M${big.properties.mag.toFixed(1)}, ${big.properties.place})`;
  } catch { return '—'; }
}

const boxArea = ([s, w, n, e]) => ({ minlatitude: Math.max(-90, s), maxlatitude: Math.min(90, n), minlongitude: Math.max(-180, w), maxlongitude: Math.min(180, e) });

// A region: weather on a 4 x 4 grid of points, earthquakes and natural events inside the box.
async function regionData(level) {
  const box = state.boxes[level];
  const [s, w, n, e] = box;
  const lats = [], lons = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { lats.push((s + (n - s) * (i + 0.5) / 4).toFixed(2)); lons.push((w + (e - w) * (j + 0.5) / 4).toFixed(2)); }
  const grid = await json(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: lats.join(','), longitude: lons.join(','),
    current: 'temperature_2m,wind_speed_10m,precipitation,cloud_cover' })}`).catch(() => []);
  const pts = (Array.isArray(grid) ? grid : [grid]).filter((g) => g?.current);
  const by = (k, dir) => pts.reduce((a, b) => (dir * a.current[k] > dir * b.current[k] ? a : b));
  const where = (g) => `${g.latitude.toFixed(1)}°, ${g.longitude.toFixed(1)}°`;
  const rows = [];
  if (pts.length) {
    const hot = by('temperature_2m', 1), cold = by('temperature_2m', -1), windy = by('wind_speed_10m', 1);
    const raining = pts.filter((g) => g.current.precipitation > 0).length;
    const cloud = pts.reduce((a, g) => a + g.current.cloud_cover, 0) / pts.length;
    rows.push(`Hottest ${fmt(hot.current.temperature_2m)}°C at ${where(hot)}`, `Coolest ${fmt(cold.current.temperature_2m)}°C at ${where(cold)}`,
      `Windiest ${fmt(windy.current.wind_speed_10m)} km/h at ${where(windy)}`, `Cloud cover ${fmt(cloud)}% · raining at ${raining} of ${pts.length} points`);
  }
  rows.push(`Earthquakes, 7 days: ${await quakeCount(boxArea(box), 7, level === 'continent' ? 4.5 : 3)}`);
  const ev = await json(`https://eonet.gsfc.nasa.gov/api/v3/events?${qs({ status: 'open', days: 30, bbox: `${w},${n},${e},${s}` })}`).catch(() => ({ events: [] }));
  const side = ev.events.slice(0, 8).map((x) => [x.categories[0]?.title.split(' ')[0].toUpperCase().slice(0, 8) || 'EVENT', x.title.slice(0, 34)]);
  return { rows, sideTitle: `NATURAL EVENTS (${ev.events.length})`, side: side.length ? side : [['—', 'no open events in this area']] };
}

// The whole planet: space weather, big earthquakes, natural events, the space station.
async function earthData() {
  const [kp, wind, xray, quakes, ev, iss] = await Promise.all([
    json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json').catch(() => null),
    json('https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json').catch(() => null),
    json('https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json').catch(() => null),
    json('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson').catch(() => null),
    json('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30').catch(() => null),
    json('https://api.wheretheiss.at/v1/satellites/25544').catch(() => null),
  ]);
  const kpNow = kp ? Number(Array.isArray(kp.at(-1)) ? kp.at(-1)[1] : kp.at(-1).Kp) : null;
  const speed = wind ? Number(wind[0]?.proton_speed) : null;
  const flux = xray ? xray.filter((r) => r.energy === '0.1-0.8nm').at(-1)?.flux : null;
  const flare = flux ? (flux >= 1e-4 ? 'X' : flux >= 1e-5 ? 'M' : flux >= 1e-6 ? 'C' : flux >= 1e-7 ? 'B' : 'A') + (flux / 10 ** Math.floor(Math.log10(flux))).toFixed(1) : '—';
  state.data.kp = kpNow;
  const cats = {};
  for (const x of ev?.events || []) { const c = x.categories[0]?.title || 'Other'; cats[c] = (cats[c] || 0) + 1; }
  const big = quakes?.features?.length ? quakes.features.reduce((a, b) => (a.properties.mag > b.properties.mag ? a : b)) : null;
  return {
    rows: [
      `Earthquakes M4.5+, 24 h: ${quakes ? quakes.features.length : '—'}${big ? ` (biggest M${big.properties.mag.toFixed(1)}, ${big.properties.place})` : ''}`,
      `Space weather: Kp ${kpNow ?? '—'} ${kpNow >= 5 ? '(storm, auroras likely)' : '(quiet)'}`,
      `Solar wind ${speed ? fmt(speed) + ' km/s' : '—'} · X-ray ${flare}`,
      iss ? `Space station over ${iss.latitude.toFixed(1)}°, ${iss.longitude.toFixed(1)}° at ${fmt(iss.velocity)} km/h` : '',
      `Natural events open now: ${ev ? ev.events.length : '—'}`,
    ].filter(Boolean),
    sideTitle: 'EVENTS BY KIND',
    side: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [String(v), k]),
  };
}

let dataToken = 0;
async function showData() {
  const token = ++dataToken, level = LEVELS[state.level], p = state.place;
  $('levelName').textContent = levelTitle(level).toUpperCase();
  $('where').textContent = level === 'city'
    ? `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'} · ${p.state}, ${p.country}`
    : level === 'earth' ? 'the whole planet' : `around ${p.name}`;
  renderLadder();
  renderNews();
  $('rows').replaceChildren(el('div', 'row dim', 'loading …'));
  $('sideRows').replaceChildren();
  renderGauge(null);
  try {
    const d = level === 'city' ? await cityData(p) : level === 'earth' ? await earthData() : await regionData(level);
    if (token !== dataToken) return;
    $('rows').replaceChildren(...d.rows.map((r) => el('div', 'row', esc(r))));
    $('sideTitle').textContent = d.sideTitle;
    $('sideRows').replaceChildren(...d.side.map(([k, v]) => el('div', 'row', `<b>${esc(k)}</b>${esc(v)}`)));
    renderGauge(d.soil);
  } catch (e) { console.warn(e); $('rows').textContent = 'data not available right now'; }
  renderDataLine();
}

// Ground water: soil moisture by depth, as water tubes (0.5 m³/m³ is about full for most soils).
function renderGauge(soil) {
  const g = $('gauge');
  if (!soil) { g.replaceChildren(); return; }
  g.replaceChildren(...soil.map(([depth, v]) => {
    const t = el('div', 'tube');
    const pct = Math.max(0, Math.min(100, (v ?? 0) / 0.5 * 100));
    t.innerHTML = `<div class="val">${v == null ? '—' : Math.round(v * 100) + '%'}</div><div class="glass"><div class="water" style="height:${pct}%"></div></div>${depth}`;
    return t;
  }));
  g.prepend(el('div', 'row mono', 'GROUND<br>WATER'));
}

// ---------- the bottom lines ----------

async function loadNews() {
  try { state.news = await json(`../news.json?${Date.now()}`); } catch { state.news = null; }
  return state.news;
}

let newsX = 0, newsWidth = 0;
function renderNews() {
  const level = LEVELS[state.level];
  const key = level === 'continent' || level === 'earth' ? 'world' : level;
  const stories = state.news?.levels?.[key] || [];
  $('newsLabel').textContent = `${(key === 'world' ? 'WORLD' : levelTitle(level)).toUpperCase()} NEWS`;
  const tz = state.data.tz;
  $('newsText').innerHTML = stories.length ? stories.map((s) => {
    const t = new Date(s.time).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<span class="h">${esc(t)}</span> <span class="t">${esc(s.title)}</span>${s.summary ? ` <span class="s">— ${esc(s.summary)}</span>` : ''}`;
  }).join('<span class="sep">◆</span>') + '<span class="sep">◆</span>' : '<span class="s">no news for this place yet</span>';
  newsWidth = $('newsText').scrollWidth; newsX = 0;
}

function scrollNews(ms) {
  newsX -= ms * 0.12;   // pixels per millisecond
  if (newsWidth && -newsX > newsWidth) newsX = $('newsWindow').clientWidth;
  $('newsText').style.transform = `translateX(${newsX}px)`;
}

async function renderDataLine() {
  const tiles = [];
  try {
    const [fx, gold, silver] = await Promise.all([json('https://open.er-api.com/v6/latest/USD'), json('https://api.gold-api.com/price/XAU'), json('https://api.gold-api.com/price/XAG')]);
    const inr = fx.rates.INR;
    tiles.push(['GOLD 24K', `₹${fmt(gold.price * inr / 31.1035 * 10)}/10g`], ['SILVER', `₹${fmt(silver.price * inr / 31.1035 * 1000)}/kg`], ['USD/INR', inr.toFixed(2)]);
  } catch { /* prices offline */ }
  if (state.data.temp != null) tiles.push(['TEMP', `${fmt(state.data.temp)}°C`]);
  if (state.data.aqi != null) tiles.push(['AQI', `${fmt(state.data.aqi)} ${aqiName(state.data.aqi)}`]);
  if (state.data.kp == null) {
    const kp = await json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json').catch(() => null);
    if (kp) state.data.kp = Number(Array.isArray(kp.at(-1)) ? kp.at(-1)[1] : kp.at(-1).Kp);
  }
  if (state.data.kp != null) tiles.push(['KP', String(state.data.kp)]);
  tiles.push(['SPOT PRICES', 'world market, before Indian tax']);
  $('dataLine').replaceChildren(...tiles.map(([k, v]) => el('div', 'tile', `<b>${esc(k)}</b>${esc(v)}`)));
}

// ---------- clock, ladder, dots ----------

let lastTime = '';
function tickClock() {
  const tz = state.data.tz, now = new Date();
  const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
  if (time !== lastTime) {
    const spans = $('time').children;
    if (spans.length !== time.length) $('time').replaceChildren(...[...time].map((ch) => el('span', '', ch)));
    [...time].forEach((ch, i) => {
      const s = $('time').children[i];
      if (s.textContent !== ch) { s.textContent = ch; s.classList.remove('tick'); void s.offsetWidth; s.classList.add('tick'); }
    });
    lastTime = time;
    const date = now.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    const utc = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
    $('date').textContent = `${date} · ${utc}`;
  }
}

function renderLadder() {
  $('ladder').replaceChildren(...[...LEVELS].reverse().map((l) => el('div', LEVELS[state.level] === l ? 'on' : '', esc(levelTitle(l).toUpperCase()))));
}

function renderViews() {
  $('views').innerHTML = state.views.map((v, i) => (i === state.view ? `<b>● ${esc(v.name)}</b>` : '○')).join('  ') + '   ← →';
}

const setSource = (s) => { $('source').textContent = s; };
const status = (s) => { $('status').textContent = s; };
function setFrameTime(t, day) {
  $('frameTime').textContent = t ? `PICTURE ${t.toLocaleString('en-GB', { timeZone: state.data.tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : day ? `PICTURE ${day}` : '';
}

// ---------- keys ----------

function goLevel(i) {
  state.level = Math.max(0, Math.min(LEVELS.length - 1, i));
  state.views = viewsFor(LEVELS[state.level]);
  state.view = 0;
  showData();
  showView();
}

function goView(i) {
  state.view = (i + state.views.length) % state.views.length;
  showView();
}

document.addEventListener('keydown', (e) => {
  if (!$('setup').hidden) return;
  state.lastKey = Date.now();
  const k = e.key;
  if (k === 'ArrowUp') goLevel(state.level + 1);
  else if (k === 'ArrowDown') goLevel(state.level - 1);
  else if (k === 'ArrowRight') goView(state.view + 1);
  else if (k === 'ArrowLeft') goView(state.view - 1);
  else if (k === 's' || k === 'S') { $('setup').hidden = false; $('setupCity').focus(); }
  else return;
  e.preventDefault();
});

$('setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await start(await searchCity($('setupCity').value.trim())); } catch (err) { status(err.message); }
});
$('setupGps').addEventListener('click', () => navigator.geolocation.getCurrentPosition(
  async (pos) => start(await describe(pos.coords.latitude, pos.coords.longitude)), (err) => status(err.message)));

// ---------- start ----------

function fitScreen() {
  const s = Math.min(innerWidth / W, innerHeight / H);
  $('screen').style.transform = `translate(${(innerWidth - W * s) / 2}px, ${(innerHeight - H * s) / 2}px) scale(${s})`;
}

async function start(place) {
  $('setup').hidden = true;
  state.place = place;
  status('finding the areas …');
  place.boxes = place.boxes || await levelBoxes(place);   // remembered with the place, so later starts are quick
  state.boxes = place.boxes;
  savePlace(place);
  goLevel(0);
}

async function boot() {
  fitScreen();
  addEventListener('resize', fitScreen);
  let last = performance.now();
  const frame = (now) => { scrollNews(now - last); last = now; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  setInterval(tickClock, 250);
  setInterval(() => { if (state.place) showData(); }, 10 * 60e3);                 // fresh data every 10 minutes
  setInterval(async () => { await loadNews(); if (state.place) renderNews(); }, 15 * 60e3);
  setInterval(() => {                                                                 // like a screensaver: next picture
    if (state.place && Date.now() - state.lastKey > 2 * 60e3 && state.views[state.view]?.kind !== 'loop') goView(state.view + 1);
  }, AUTO_VIEW_MS);
  if (!state.news) await loadNews();
  try {
    const place = await findPlace();
    if (place) await start(place); else $('setup').hidden = false;
  } catch (e) { status(e.message); $('setup').hidden = false; }
}

boot();
