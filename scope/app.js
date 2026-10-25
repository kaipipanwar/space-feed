// Earth Scope: the Earth over one place, seen through a scope, from the city out to the whole planet.
// Keys (PC keyboard or TV remote): left/right = pictures, up = zoom out, down = zoom in, OK/Enter or W = weather
// layer on/off, S = change place (and which way you face when you look at the screen, for the compass).
// Levels: HERE (your exact spot, closest map + live traffic) -> city -> state -> country -> continent -> Earth.
// Settings in the address, kept only in this browser: ?facing=<degrees> ?here=<lat>,<lon> ?tomtom=<free TomTom key>
// All data comes from free public services that allow web pages to read them; news.json is made by the
// GitHub Action (make_news.py), because news feeds do not allow that.
'use strict';

const W = 1920, H = 1080;
const $ = (id) => document.getElementById(id);
const NEON = '#39ff14';
const LEVELS = ['here', 'city', 'state', 'country', 'continent', 'earth'];
const CONTINENTS = {   // [south, west, north, east] boxes for the continent level
  Asia: [-12, 25, 72, 150], Europe: [34, -25, 72, 45], Africa: [-36, -20, 38, 55],
  'North America': [5, -170, 75, -50], 'South America': [-56, -85, 14, -33], Oceania: [-48, 110, 5, 180],
  Antarctica: [-90, -180, -60, 180],
};
const EUMETSAT = 'https://view.eumetsat.int/geoserver/ows';
const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
// NASA's night camera (city lights and moonlit land), newest first
const NIGHT = ['VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance', 'VIIRS_NOAA21_DayNightBand_At_Sensor_Radiance',
  'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance'];

const DAILY = ['MODIS_Terra_CorrectedReflectance_TrueColor', 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
  'VIIRS_SNPP_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor'];
const LOOP_FRAMES = 16, LOOP_STEP_MS = 1100, AUTO_VIEW_MS = 45000;

const state = { place: null, level: 1, view: 0, boxes: {}, views: [], loop: null, news: null, data: {}, lastKey: 0, weather: false,
  facing: null,   // the compass direction you face when you look at the screen (degrees), if known
  here: null };   // your exact spot { lat, lon, accuracy, source }, if known

// ---------- small helpers ----------

const json = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const qs = (o) => new URLSearchParams(o).toString();
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const pad2 = (n) => String(n).padStart(2, '0');
const compass = (d) => 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW'.split(' ')[Math.round(d / 22.5) % 16];
const fmt = (n, d = 0) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const last = (a) => a[a.length - 1];   // older TV browsers lack Array.prototype.at
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

// Sun and Moon: the point on Earth where each is straight overhead, then its height and direction from the place.
const dJ = (t) => t / 864e5 + 2440587.5 - 2451545.0, sn = (x) => Math.sin(rad(x));
function sunLon(t) { const d = dJ(t), g = 357.528 + 0.9856003 * d; return (((280.460 + 0.9856474 * d + 1.915 * sn(g) + 0.020 * sn(2 * g)) % 360) + 360) % 360; }
function moonLonLat(t) {
  const d = dJ(t), lp = 218.316 + 13.176396 * d, mp = 134.963 + 13.064993 * d, f = 93.272 + 13.229350 * d;
  const dd = 297.850 + 12.190749 * d, m = 357.529 + 0.98560028 * d;
  const lon = lp + 6.289 * sn(mp) + 1.274 * sn(2 * dd - mp) + 0.658 * sn(2 * dd) + 0.214 * sn(2 * mp) - 0.186 * sn(m) - 0.114 * sn(2 * f);
  return [((lon % 360) + 360) % 360, 5.128 * sn(f)];
}
function overhead(t, lon, lat = 0) {   // ecliptic longitude/latitude -> the point on Earth below it
  const d = dJ(t), eps = rad(23.439 - 0.0000004 * d), l = rad(lon), b = rad(lat);
  const ra = deg(Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)));
  const dec = deg(Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)));
  const gmst = (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360;
  return [dec, ((((ra - gmst) % 360) + 540) % 360) - 180];
}
function skyPosition([oLat, oLon], lat, lon) {   // height above the horizon and compass direction, degrees
  const p1 = rad(lat), p2 = rad(oLat), dl = rad(oLon - lon);
  const dist = Math.acos(Math.max(-1, Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl))));
  const az = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return { el: 90 - deg(dist), az: (deg(az) + 360) % 360 };
}
const sunSky = (t, lat, lon) => skyPosition(overhead(t, sunLon(t)), lat, lon);
const moonSky = (t, lat, lon) => skyPosition(overhead(t, ...moonLonLat(t)), lat, lon);

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

// Slide a box so the place does not sit under a panel (the area stays the same size).
// The same area, moved so the place is exactly in the middle of the screen.
function centreOn([s, w, n, e], lat, lon) {
  const latSpan = n - s, lonSpan = e - w;
  return [lat - latSpan / 2, lon - lonSpan / 2, lat + latSpan / 2, lon + lonSpan / 2];
}

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

// Your exact spot: from the address (?here=lat,lon, e.g. sent from the PC to the TV), from this device's location
// (a phone, or a PC with location switched on), or from what this browser remembered. It never leaves the device.
async function findHere() {
  const param = (new URLSearchParams(location.search).get('here') || '').split(',').map(Number);
  if (param.length === 2 && param.every(Number.isFinite)) return keepHere({ lat: param[0], lon: param[1], accuracy: null, source: 'set from the PC' });
  const live = await new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((pos) => ok({ lat: pos.coords.latitude, lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy, source: 'this device' }), () => ok(null), { timeout: 8000, maximumAge: 10 * 60e3 });
  });
  if (live) return keepHere(live);
  try { return JSON.parse(localStorage.getItem('earthscope.here')); } catch { return null; }
}

function keepHere(h) { try { localStorage.setItem('earthscope.here', JSON.stringify(h)); } catch { /* fine */ } return h; }

// The point the data and the scope are about at a level: your spot at HERE, the city centre elsewhere.
function focus(level = LEVELS[state.level]) {
  return level === 'here' && state.here ? state.here : state.place;
}

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
  return { here: 'Here', city: p.name, state: p.state, country: p.country, continent: p.continent, earth: 'Earth' }[level] || level;
}

// ---------- pictures ----------

// Which weather satellite sees this longitude best, and whether it gives natural colour.
// Which weather satellite sees this longitude best: a colour layer for day and an infrared layer that sees clouds
// at night too.
function geoSource(lon) {
  if (lon >= 10 && lon <= 110) return { kind: 'eumetsat', layer: 'msg_iodc:rgb_naturalenhncd', night: 'msg_iodc:ir108', name: 'EUMETSAT Meteosat (Indian Ocean)' };
  if (lon >= -60 && lon < 10) return { kind: 'eumetsat', layer: 'msg_fes:rgb_naturalenhncd', night: 'msg_fes:ir108', name: 'EUMETSAT Meteosat (0°)' };
  if (lon < -105 || lon > 170) return { kind: 'gibs', layer: 'GOES-West_ABI_GeoColor', night: 'GOES-West_ABI_GeoColor', name: 'NOAA GOES-West', step: 10 };
  if (lon < -60) return { kind: 'gibs', layer: 'GOES-East_ABI_GeoColor', night: 'GOES-East_ABI_GeoColor', name: 'NOAA GOES-East', step: 10 };
  return { kind: 'gibs', layer: 'Himawari_AHI_Band3_Red_Visible_1km', night: 'Himawari_AHI_Band13_Clean_Infrared', name: 'JMA Himawari', step: 10 };
}

// Day or night for a picture: colour only when the sun is up over the whole view (both edges), else infrared, so
// no half-dark sunset pictures.
const isDay = (box, t) => [box[1], box[3]].every((lon) => sunPosition((box[0] + box[2]) / 2, lon, t).el >= 3);

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
// The newest picture times for a box (oldest first): day and night alike, so the loop is always the latest.
async function loopTimes(box, src) {
  const step = (src.step || 15) * 60e3;
  const newest = src.kind === 'eumetsat' ? await newestEumetsat(src.layer)
    : new Date(Math.floor((Date.now() - 50 * 60e3) / step) * step);
  const times = [];
  for (let k = LOOP_FRAMES - 1; k >= 0; k--) times.push(new Date(newest.getTime() - k * step));
  return times;
}

function geoUrl(box, src, time, width, height) {
  const t = time.toISOString().slice(0, 16) + ':00Z', layer = isDay(box, time) ? src.layer : src.night;
  if (src.kind === 'eumetsat') {
    return `${EUMETSAT}?${qs({ service: 'WMS', request: 'GetMap', version: '1.3.0', layers: layer, styles: '', crs: 'EPSG:4326',
      bbox: wmsBox(box), format: 'image/jpeg', width, height, time: t })}`;
  }
  return `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: layer, CRS: 'EPSG:4326',
    BBOX: wmsBox(box), FORMAT: 'image/jpeg', WIDTH: width, HEIGHT: height, TIME: t })}`;
}

const loadImage = (src) => new Promise((ok, fail) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = fail; i.src = src; });

// Share of black pixels: gaps between a satellite's stripes, or night.
function blackShare(img, limit = 24) {
  const c = document.createElement('canvas'); c.width = 96; c.height = 54;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, 96, 54);
  const d = g.getImageData(0, 0, 96, 54).data; let black = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < limit) black++;
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

// NASA's newest night photo of a box (city lights and moonlit land) without big gaps. Night photos are dark,
// so only pixels with no data at all count as gaps.
async function newestNight(box, maxGap) {
  for (let back = 0; back < 4; back++) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    for (const layer of NIGHT) {
      const url = (w, h) => `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: layer, CRS: 'EPSG:4326',
        BBOX: wmsBox(box), FORMAT: 'image/jpeg', WIDTH: w, HEIGHT: h, TIME: day })}`;
      try {
        if (blackShare(await loadImage(url(192, 108)), 2) <= maxGap) return { url: url(W, H), day, layer };
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
  const p = state.place, f = focus(level), world = [-90, -180, 90, 180];
  if (level === 'here') {
    // The closest the map goes (about 450 m from top to bottom) and a little wider, both with live traffic.
    return [{ kind: 'map', name: 'closest map + traffic', box: box16x9(f.lat, f.lon, 0.004), traffic: true },
      { kind: 'map', name: 'neighbourhood + traffic', box: box16x9(f.lat, f.lon, 0.014), traffic: true }];
  }
  if (level === 'earth') {
    return [{ kind: 'map', name: 'satellite map', box: world }, { kind: 'globe', name: 'whole Earth, NASA EPIC' },
      { kind: 'daily', name: 'world today', box: world, gap: 0.3 }];
  }
  const box = centreOn(state.boxes[level], p.lat, p.lon);
  // The sharp map (Esri World Imagery, the same map Trade Eye uses) comes first: very close at the city level.
  const map = { kind: 'map', name: 'satellite map', box: level === 'city' ? box16x9(p.lat, p.lon, 0.045) : box };
  const sharp = level === 'city' ? box16x9(p.lat, p.lon, 1.5) : box;
  const daily = { kind: 'daily', name: 'sharpest daytime', box: sharp, gap: level === 'city' ? 0.01 : 0.08 };
  const night = { kind: 'night', name: 'night lights', box: sharp, gap: level === 'city' ? 0.02 : 0.1 };
  // Then the newest first: the live loop and its newest picture, then the sharp daily photos, the most recent first
  // (NASA's night pass is around 01:30 local time, its day pass around 10:30 to 13:30).
  const hour = new Date().getUTCHours() + p.lon / 15;
  const localHour = ((hour % 24) + 24) % 24;
  const sharpOnes = localHour >= 2 && localHour < 11 ? [night, daily] : [daily, night];
  return [map, { kind: 'loop', name: 'live loop', box }, { kind: 'still', name: 'newest picture', box }, ...sharpOnes];
}

// A whole-world picture with the place's longitude in the middle: two halves (the map services cannot wrap
// around the date line), joined on a canvas. makeUrl(box, width, height) gives the picture of one box.
async function worldCentred(lon, makeUrl) {
  const c = document.createElement('canvas'); c.width = W; c.height = W / 2;
  const g = c.getContext('2d');
  const west = lon - 180, cut = Math.round((180 - west) / 360 * W);   // pixels from the left edge to longitude 180
  const parts = [[[-90, west, 90, 180], 0, cut], [[-90, -180, 90, west], cut, W - cut]];
  if (west < -180) { parts[0][0] = [-90, west + 360, 90, 180]; parts[1][0] = [-90, -180, 90, west + 360]; }
  for (const [box, x, width] of parts) {
    if (width < 2) continue;
    g.drawImage(await loadImage(makeUrl(box, width, W / 2)), x, 0, width, W / 2);
  }
  return c.toDataURL('image/jpeg', 0.9);
}

function mapUrl([s, w, n, e], width, height) {
  return `${ESRI}?${qs({ bbox: `${w},${s},${e},${n}`, bboxSR: 4326, imageSR: 4326, size: `${width},${height}`, format: 'jpg', f: 'image' })}`;
}

let showToken = 0;
async function showView() {
  const token = ++showToken;
  stopLoop();
  const level = LEVELS[state.level], view = state.views[state.view], p = state.place;
  renderViews();
  status('loading pictures …');
  drawWeather(null);
  $('tiles').replaceChildren();
  try {
    if (view.kind === 'map') {
      setSource('Esri World Imagery · sharpest photos, months to years old (not live)');
      setFrameTime(null);
      if (level === 'earth') {
        const url = await worldCentred(p.lon, (b, w, h) => mapUrl(b, w, h));
        if (token !== showToken) return;
        showWorld(url);
      } else {
        setPicture(mapUrl(view.box, W, H));
        drawReticle(CENTRE, level === 'city' || level === 'here' ? 1 : 0.6);
        if (view.traffic) showTraffic(view.box);
      }
    } else if (view.kind === 'night') {
      const d = await newestNight(view.box, view.gap);
      if (token !== showToken) return;
      if (!d) throw new Error('no clear night photo in the last 4 days');
      setSource(`NASA ${d.layer.split('_').slice(0, 2).join(' ')} night camera · night of ${d.day}`);
      setFrameTime(null, `${d.day} night`);
      setPicture(d.url);
      drawReticle(onScreen(view.box, p.lat, p.lon), level === 'city' ? 1 : 0.6);
    } else if (view.kind === 'globe') {
      const g = await newestGlobe(p);
      if (token !== showToken) return;
      // NASA's photos may be shown but not read by a page; the globe is moved so the place is in the middle.
      const target = globeTarget(g.photo, p);
      setPicture(g.url, true, [W / 2 - target.x, H / 2 - target.y]);
      setSource('NASA EPIC camera, 1.5 million km away');
      setFrameTime(new Date(g.photo.date.replace(' ', 'T') + 'Z'));
      drawReticle(CENTRE, 0.35);
    } else if (view.kind === 'daily') {
      const d = await newestDaily(view.box, view.gap);
      if (token !== showToken) return;
      if (!d) throw new Error('no clear daily picture in the last 4 days');
      setSource(`NASA ${d.layer.split('_').slice(0, 2).join(' ')} · ${d.day}`);
      setFrameTime(null, d.day);
      if (level === 'earth') {
        const url = await worldCentred(p.lon, (b, w, h) => `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0',
          LAYERS: d.layer, CRS: 'EPSG:4326', BBOX: wmsBox(b), FORMAT: 'image/jpeg', WIDTH: w, HEIGHT: h, TIME: d.day })}`);
        if (token !== showToken) return;
        showWorld(url);
      } else {
        setPicture(d.url);
        drawReticle(onScreen(view.box, p.lat, p.lon), level === 'city' ? 1 : 0.6);
      }
    } else {
      const src = geoSource((view.box[1] + view.box[3]) / 2);
      const times = await loopTimes(view.box, src);
      if (token !== showToken) return;
      const target = onScreen(view.box, p.lat, p.lon);
      setSource(`${src.name} · every ${src.step || 15} min · colour by day, infrared by night`);
      drawReticle(target, level === 'city' ? 1 : 0.6);
      if (view.kind === 'still') {
        const t = times[times.length - 1];
        setPicture(geoUrl(view.box, src, t, W, H));
        setFrameTime(t, null, isDay(view.box, t) ? '' : ' · infrared');
      } else {
        await startLoop(view.box, src, times, token);
      }
    }
    status('');
    if (state.weather) drawWeather(view);
  } catch (e) {
    console.warn(e);
    status(`picture not available: ${e.message}`);
  }
}

// ---------- map tiles: live traffic (TomTom) and rain radar (RainViewer) ----------

// Web map tiles (the usual 256-pixel squares) laid over a latitude/longitude box. Fine for the small and medium
// areas they are used for; makeUrl(z, x, y) gives one tile.
function tilesOver(box, maxZoom, makeUrl, layer) {
  const [s, w, n, e] = box;
  const z = Math.max(2, Math.min(maxZoom, Math.round(Math.log2(360 / (e - w) * W / 256))));
  const N = 2 ** z, tx = (lon) => (lon + 180) / 360 * N;
  const ty = (lat) => (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * N;
  const lonOf = (x) => x / N * 360 - 180, latOf = (y) => deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))));
  const out = [];
  for (let x = Math.floor(tx(w)); x <= Math.floor(tx(e)); x++) {
    for (let y = Math.floor(ty(Math.min(85, n))); y <= Math.floor(ty(Math.max(-85, s))); y++) {
      if (out.length > 80) break;
      const img = el('img', 'tile');
      const left = (lonOf(x) - w) / (e - w) * W, right = (lonOf(x + 1) - w) / (e - w) * W;
      const top = (n - latOf(y)) / (n - s) * H, bottom = (n - latOf(y + 1)) / (n - s) * H;
      Object.assign(img.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      img.src = makeUrl(z, ((x % N) + N) % N, y);
      out.push(img);
    }
  }
  layer.replaceChildren(...out);
}

function tomtomKey() {
  const param = new URLSearchParams(location.search).get('tomtom');
  try { if (param) localStorage.setItem('earthscope.tomtom', param); return param || localStorage.getItem('earthscope.tomtom'); } catch { return param; }
}

// Live traffic: green flows, orange slows, red jams (TomTom, a free key kept only in this browser).
function showTraffic(box) {
  const key = tomtomKey();
  if (!key) { status('traffic: needs a free TomTom key (see README)'); return; }
  tilesOver(box, 18, (z, x, y) => `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?tileSize=256&key=${encodeURIComponent(key)}`, $('tiles'));
  setSource('Esri World Imagery (sharpest photos, not live) · live traffic © TomTom');
}

// ---------- the weather layer (OK / Enter) ----------

// The weather layer: a heat colour layer, flowing wind streaks and falling rain from a live 12 x 7 grid of
// Open-Meteo points, over NASA IMERG's rain map (the newest half hour it has, a few hours old).
let weatherToken = 0, weatherRun = null;
const TEMP_COLOURS = [[-20, [70, 60, 200]], [0, [60, 170, 255]], [12, [60, 220, 160]], [22, [250, 230, 80]], [32, [255, 140, 40]], [42, [230, 30, 40]]];
function tempColour(t) {
  for (let i = 1; i < TEMP_COLOURS.length; i++) {
    const [t1, c1] = TEMP_COLOURS[i];
    if (t <= t1) { const [t0, c0] = TEMP_COLOURS[i - 1], k = Math.max(0, (t - t0) / (t1 - t0)); return c0.map((v, j) => Math.round(v + (c1[j] - v) * k)); }
  }
  return last(TEMP_COLOURS)[1];
}

async function drawWeather(view) {
  const token = ++weatherToken, rain = $('rain');
  cancelAnimationFrame(weatherRun);
  for (const id of ['weather', 'heat']) $(id).getContext('2d').clearRect(0, 0, W, H);
  rain.classList.remove('on');
  $('radarTiles').replaceChildren();
  $('weatherTag').hidden = !view;
  if (!view) return;
  const level = LEVELS[state.level];
  if (level === 'earth') { $('weatherTag').textContent = 'WEATHER: zoom in (↓) for the weather layer'; return; }
  // The live loop already shows the real clouds moving; the weather layer would only cover them.
  if (view.kind === 'loop') { $('weatherTag').textContent = 'WEATHER: the live loop shows the real clouds (← → for the weather layer)'; return; }
  const box = view.box;
  $('weatherTag').innerHTML = 'WEATHER ON · <b>heat</b> <span class="scale"></span> · wind: live model · rain: <span class="radar">radar …</span> + NASA (hours old)';
  json('https://api.rainviewer.com/public/weather-maps.json').then((rv) => {
    const f = rv?.radar?.past && last(rv.radar.past);
    if (token !== weatherToken || !f) return;
    tilesOver(box, 7, (z, x, y) => `${rv.host}${f.path}/256/${z}/${x}/${y}/2/1_1.png`, $('radarTiles'));
    const at = new Date(f.time * 1000).toLocaleTimeString('en-GB', { timeZone: state.data.tz, hour: '2-digit', minute: '2-digit' });
    $('weatherTag').querySelector('.radar').textContent = `RainViewer radar ${at}`;
  }).catch(() => {});
  rain.onload = () => { if (token === weatherToken) rain.classList.add('on'); };
  rain.src = `${GIBS}?${qs({ SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: '1.3.0', LAYERS: 'IMERG_Precipitation_Rate_30min', CRS: 'EPSG:4326',
    BBOX: wmsBox(box), FORMAT: 'image/png', TRANSPARENT: 'TRUE', WIDTH: W / 2, HEIGHT: H / 2 })}`;
  const [s, w, n, e] = box, cols = 12, rows = 7, lats = [], lons = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    lats.push(Math.max(-89, Math.min(89, n - (n - s) * (i + 0.5) / rows)).toFixed(3));
    lons.push((((w + (e - w) * (j + 0.5) / cols) + 540) % 360 - 180).toFixed(3));
  }
  const r = await json(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: lats.join(','), longitude: lons.join(','),
    current: 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation' })}`).catch(() => null);
  if (token !== weatherToken || !r) return;
  const pts = (Array.isArray(r) ? r : [r]).map((q) => q.current || {});
  const cell = (i, j) => pts[Math.max(0, Math.min(rows - 1, i)) * cols + Math.max(0, Math.min(cols - 1, j))] || {};

  // Heat: one coloured pixel per point, stretched smoothly over the screen.
  const tiny = document.createElement('canvas'); tiny.width = cols; tiny.height = rows;
  const tg = tiny.getContext('2d');
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const [R, G, B] = tempColour(cell(i, j).temperature_2m ?? 20);
    tg.fillStyle = `rgb(${R},${G},${B})`; tg.fillRect(j, i, 1, 1);
  }
  const hg = $('heat').getContext('2d');
  hg.imageSmoothingEnabled = true; hg.globalAlpha = 0.33; hg.drawImage(tiny, 0, 0, W, H); hg.globalAlpha = 1;
  hg.font = '700 20px "Share Tech Mono", monospace'; hg.textAlign = 'center';
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const t = cell(i, j).temperature_2m; if (t == null) continue;
    const x = (j + 0.5) / cols * W, y = (i + 0.5) / rows * H;
    hg.lineWidth = 4; hg.strokeStyle = 'rgba(0,0,0,0.6)'; hg.strokeText(`${Math.round(t)}°`, x, y);
    hg.fillStyle = '#fff'; hg.fillText(`${Math.round(t)}°`, x, y);
  }
  const ramp = TEMP_COLOURS.map(([t, [R, G, B]]) => `<i style="background:rgb(${R},${G},${B})">${t}°</i>`).join('');
  $('weatherTag').querySelector('.scale').innerHTML = ramp;

  // Wind at any screen point, mixed from the four nearest grid points (pixels per frame).
  const wind = (x, y) => {
    const fj = x / W * cols - 0.5, fi = y / H * rows - 0.5, j = Math.floor(fj), i = Math.floor(fi), a = fj - j, b = fi - i;
    let u = 0, v = 0;
    for (const [di, dj, k] of [[0, 0, (1 - a) * (1 - b)], [0, 1, a * (1 - b)], [1, 0, (1 - a) * b], [1, 1, a * b]]) {
      const c = cell(i + di, j + dj), sp = (c.wind_speed_10m || 0) * 0.09, to = rad((c.wind_direction_10m || 0) + 180);
      u += k * sp * Math.sin(to); v -= k * sp * Math.cos(to);
    }
    return [u, v];
  };
  const rainAt = (x, y) => cell(Math.floor(y / H * rows), Math.floor(x / W * cols)).precipitation || 0;
  const g = $('weather').getContext('2d');
  const streaks = Array.from({ length: 900 }, () => ({ x: Math.random() * W, y: Math.random() * H, age: Math.random() * 80 }));
  const drops = [];
  const frame = () => {
    if (token !== weatherToken) return;
    g.globalCompositeOperation = 'destination-out';   // fade the old trails
    g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.8; g.beginPath();
    for (const q of streaks) {
      const [u, v] = wind(q.x, q.y);
      g.moveTo(q.x, q.y); q.x += u; q.y += v; g.lineTo(q.x, q.y);
      if (++q.age > 90 || q.x < 0 || q.x > W || q.y < 0 || q.y > H) { q.x = Math.random() * W; q.y = Math.random() * H; q.age = 0; }
    }
    g.stroke();
    // rain: new drops where it rains now, more for heavier rain
    for (let k = 0; k < 40; k++) {
      const x = Math.random() * W, y = Math.random() * H, mm = rainAt(x, y);
      if (mm > 0 && Math.random() < Math.min(1, mm / 2)) drops.push({ x, y, life: 18 });
    }
    g.strokeStyle = 'rgba(120,190,255,0.85)'; g.lineWidth = 1.5; g.beginPath();
    for (let k = drops.length - 1; k >= 0; k--) {
      const d = drops[k], [u] = wind(d.x, d.y);
      g.moveTo(d.x, d.y); d.x += u * 0.5 - 1; d.y += 14; g.lineTo(d.x, d.y);
      if (--d.life <= 0) drops.splice(k, 1);
    }
    g.stroke();
    weatherRun = requestAnimationFrame(frame);
  };
  frame();
}

function toggleWeather() {
  state.weather = !state.weather;
  drawWeather(state.weather ? state.views[state.view] : null);
}

// The world map is 2:1, shown "contain" in the 16:9 screen.
const CENTRE = { x: W / 2, y: H / 2 };

// A centred world map (2:1) on the 16:9 screen, moved up or down so the place is in the middle too.
function showWorld(url) {
  const mapH = W / 2, y = (H - mapH) / 2 + (90 - state.place.lat) / 180 * mapH;
  setPicture(url, true, [0, H / 2 - y]);
  drawReticle(CENTRE, 0.6);
}

let front = 'imgA', pictureCount = 0;
function setPicture(url, contain = false, [dx, dy] = [0, 0]) {
  const mine = ++pictureCount;   // a slow older picture must not cover a newer one
  const next = front === 'imgA' ? 'imgB' : 'imgA';
  const img = $(next);
  img.classList.toggle('contain', contain);
  img.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
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
  setFrameTime(newest, null, isDay(box, newest) ? '' : ' · infrared');
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
    setFrameTime(f.t, null, isDay(box, f.t) ? '' : ' · infrared');
    i++;
  };
  step();
  state.loop = setInterval(step, LOOP_STEP_MS);
}

function stopLoop() { clearInterval(state.loop); state.loop = null; }

// ---------- the scope ----------

// A thin, see-through rifle-scope reticle on the place, plus a separate bright line straight through it.
function drawReticle(target, scale) {
  state.reticle = [target, scale];   // redrawn when the height above sea level arrives
  const c = $('reticle'), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const { x, y } = target, ring = 300 * scale, gap = 26 * scale;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(57,255,20,0.55)';   // as visible as the "you are here" line
  g.lineWidth = 1;   // inside the ring: thin lines and range marks
  g.beginPath();
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    g.moveTo(x + sx * gap, y + sy * gap); g.lineTo(x + sx * ring, y + sy * ring);
    for (let k = 1; k < 5; k++) {   // range marks
      const r = gap + k * (ring - gap) / 5;
      if (sx) { g.moveTo(x + sx * r, y - 9); g.lineTo(x + sx * r, y + 9); } else { g.moveTo(x - 9, y + sy * r); g.lineTo(x + 9, y + sy * r); }
    }
  }
  g.stroke();
  g.beginPath(); g.arc(x, y, ring, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 0.5;   // outside the ring: half-pixel lines to the edges of the screen
  g.beginPath();
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(x + sx * ring, y + sy * ring); g.lineTo(x + sx * 4000, y + sy * 4000); }
  g.stroke();

  // The "you are here" line: 0.5 px the whole height of the screen, with a soft glow.
  g.save();
  g.shadowColor = NEON; g.shadowBlur = 4;
  g.strokeStyle = 'rgba(57,255,20,0.55)';
  g.lineWidth = 0.5;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 64); g.stroke();
  g.restore();
  g.fillStyle = NEON; g.font = '700 26px Rajdhani, sans-serif'; g.textAlign = 'center';
  const tag = `▼ ${LEVELS[state.level] === 'here' ? 'YOU' : state.place.name.toUpperCase()}`;
  g.fillText(tag, Math.max(120, Math.min(W - 120, x)), 26);

  // The solid centre dot and the coordinates.
  g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = NEON; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
  const p = focus(), digits = LEVELS[state.level] === 'here' ? 5 : 2;
  const lab = `${Math.abs(p.lat).toFixed(digits)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(digits)}°${p.lon >= 0 ? 'E' : 'W'}`
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
  const firstHeight = state.data.elevation == null;
  state.data.elevation = wx.elevation;
  if (firstHeight && state.reticle) drawReticle(...state.reticle);
  state.data.tz = wx.timezone; state.data.tzOffset = wx.utc_offset_seconds;
  const c = wx.current, d = wx.daily, now = new Date();
  const hour = wx.hourly.time.indexOf(c.time.slice(0, 13) + ':00');
  const soil = ['0_to_1cm', '1_to_3cm', '3_to_9cm', '9_to_27cm', '27_to_81cm'].map((k) => [k.replace(/_to_/, '–').replace('cm', ' cm'),
    wx.hourly[`soil_moisture_${k}`][Math.max(0, hour)]]);
  const air = await json(`https://air-quality-api.open-meteo.com/v1/air-quality?${qs({ latitude: p.lat, longitude: p.lon, current: 'us_aqi,pm2_5,pm10' })}`).catch(() => null);
  const quakes = await quakeCount({ latitude: p.lat, longitude: p.lon, maxradiuskm: 300 }, 30, 2.5);
  const iss = await json('https://api.wheretheiss.at/v1/satellites/25544').catch(() => null);
  const sun = sunSky(now, p.lat, p.lon), mn = moonSky(now, p.lat, p.lon);
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
      await kpLine(),
      `Measured for ${c.time.slice(11)} local · weather model (Open-Meteo), 15-minute steps; no station reports here`,
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
      ['SUN', `${skyIcon(sun, '#ffd34d')} az ${String(Math.round(sun.az)).padStart(3, '0')}° · el ${sun.el >= 0 ? '+' : ''}${Math.round(sun.el)}°`],
      ['MOON', `${skyIcon(mn, '#e8f0ff')} az ${String(Math.round(mn.az)).padStart(3, '0')}° · el ${mn.el >= 0 ? '+' : ''}${Math.round(mn.el)}°`],
      ['', moon(now)],
      // ground water: share of water in the soil at each depth (about 50% is soaked)
      ['SOIL H2O', soil.slice(0, 3).map(([depth, v]) => `${depth.replace(' cm', '')} ${v == null ? '—' : Math.round(v * 100) + '%'}`).join(' · ')],
      ['', soil.slice(3).map(([depth, v]) => `${depth.replace(' cm', '')} ${v == null ? '—' : Math.round(v * 100) + '%'}`).join(' · ') + ' cm'],
    ],
  };
}

// Space weather in one line (Kp 0-9: 5 or more is a geomagnetic storm).
async function kpLine() {
  const kp = await json('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json').catch(() => null);
  if (!kp) return '';
  state.data.kp = Number(Array.isArray(last(kp)) ? last(kp)[1] : last(kp).Kp);
  return `Space weather: Kp ${state.data.kp} ${state.data.kp >= 5 ? '(storm, auroras likely)' : '(quiet)'}`;
}

// A tiny sky: the circle is the horizon, the middle is straight overhead, north is up; the dot is the sun or moon
// (hollow when it is below the horizon).
// A tiny sky, turned like the compass: the top is the way you face (▲), or north (N) when that is not set; the
// circle is the horizon, the middle is straight overhead; the dot is the sun or moon (hollow below the horizon).
function skyIcon({ el, az }, colour) {
  const up = state.facing ?? 0, a = rad(az - up);
  const r = 15 * (90 - Math.max(0, el)) / 90, x = 17 + r * Math.sin(a), y = 17 - r * Math.cos(a);
  const dot = el >= 0 ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" fill="${colour}"/>`
    : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="none" stroke="${colour}" stroke-width="1.2"/>`;
  return `<svg class="sky" viewBox="0 0 34 34"><circle cx="17" cy="17" r="15" fill="none" stroke="rgba(57,255,20,0.5)"/>`
    + `<text x="17" y="8" text-anchor="middle">${state.facing == null ? 'N' : '▲'}</text>${dot}</svg>`;
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
  rows.push(`Earthquakes, 7 days: ${await quakeCount(boxArea(box), 7, level === 'continent' ? 4.5 : 3)}`, await kpLine());
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
  const kpNow = kp ? Number(Array.isArray(last(kp)) ? last(kp)[1] : last(kp).Kp) : null;
  const speed = wind ? Number(wind[0]?.proton_speed) : null;
  const flux = xray ? last(xray.filter((r) => r.energy === '0.1-0.8nm'))?.flux : null;
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
  const token = ++dataToken, level = LEVELS[state.level], p = state.place, h = state.here;
  $('levelName').textContent = levelTitle(level).toUpperCase();
  $('where').textContent = level === 'here'
    ? (h ? `your spot in ${p.name}${h.accuracy ? ` · ±${Math.round(h.accuracy)} m` : ''} · ${h.source}` : `your spot is not known yet: showing ${p.name}'s centre`)
    : level === 'city'
      ? `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'} · ${p.state}, ${p.country}`
      : level === 'earth' ? 'the whole planet' : `around ${p.name}`;
  renderLadder();
  renderNews();
  $('rows').replaceChildren(el('div', 'row dim', 'loading …'));
  $('sideRows').replaceChildren();
  try {
    const d = level === 'here' || level === 'city' ? await cityData(focus(level)) : level === 'earth' ? await earthData() : await regionData(level);
    if (token !== dataToken) return;
    $('rows').replaceChildren(...d.rows.map((r) => el('div', 'row', esc(r))));
    $('sideTitle').textContent = d.sideTitle;
    // values may start with a small sky picture (<svg>); everything else is escaped text
    $('sideRows').replaceChildren(...d.side.map(([k, v]) => {
      const m = String(v).match(/^(<svg[^]*<\/svg>)(.*)$/);
      return el('div', 'row', `<b>${esc(k)}</b>${m ? m[1] + esc(m[2]) : esc(v)}`);
    }));
  } catch (e) { console.warn(e); $('rows').textContent = 'data not available right now'; }
}

// ---------- the bottom lines ----------

async function loadNews() {
  try { state.news = await json(`../news.json?${Date.now()}`); } catch { state.news = null; }
  return state.news;
}

let newsX = 0, newsWidth = 0;
function renderNews() {
  const level = LEVELS[state.level], n = state.news || {}, p = state.place;
  // news.json is made for one place; anywhere else only the parts that match are used, the rest is world news
  const matches = { city: n.place === p.name, state: n.state === p.state, country: n.country === p.country };
  const wanted = level === 'here' ? 'city' : level;
  const key = matches[wanted] ? wanted : 'world';
  const stories = n.levels?.[key] || [];
  $('newsLabel').textContent = `${(key === 'world' ? 'WORLD' : levelTitle(wanted)).toUpperCase()} NEWS`;
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

// ---------- the sky compass ----------

// A compass for the room: "up" on the compass is the direction you face when you look at the screen (set once
// with S, or read from the device's own compass on a phone or tablet). It also shows the sun and moon: the edge is
// the horizon, the middle is straight overhead.
function drawCompass() {
  const svg = $('compass'), p = state.place;
  if (!p) return;
  const facing = state.facing ?? 0, now = new Date(), R = 100, C = 120;
  const pos = (az, r) => [C + r * Math.sin(rad(az - facing)), C - r * Math.cos(rad(az - facing))];
  let html = `<circle cx="${C}" cy="${C}" r="${R}" class="ring"/><circle cx="${C}" cy="${C}" r="${R * 2 / 3}" class="faint"/>`
    + `<circle cx="${C}" cy="${C}" r="${R / 3}" class="faint"/>`;
  for (let a = 0; a < 360; a += 10) {
    const [x1, y1] = pos(a, R), [x2, y2] = pos(a, a % 90 ? R - 7 : R - 14);
    html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${a % 90 ? 'tick' : 'major'}"/>`;
  }
  for (const [a, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'], [45, 'NE'], [135, 'SE'], [225, 'SW'], [315, 'NW']]) {
    const [x, y] = pos(a, R + 14);
    html += `<text x="${x}" y="${y + 6}" class="${name.length === 1 ? 'card' : 'inter'}${name === 'N' ? ' north' : ''}">${name}</text>`;
  }
  const [nx, ny] = pos(0, R - 18), [sx, sy] = pos(180, R - 18);   // the needle
  html += `<line x1="${sx}" y1="${sy}" x2="${C}" y2="${C}" class="needleS"/><line x1="${C}" y1="${C}" x2="${nx}" y2="${ny}" class="needleN"/>`;
  for (const [body, colour, label] of [[sunSky(now, p.lat, p.lon), '#ffd34d', 'SUN'], [moonSky(now, p.lat, p.lon), '#e8f0ff', 'MOON']]) {
    const [x, y] = pos(body.az, R * (90 - Math.max(0, body.el)) / 90);
    html += body.el >= 0 ? `<circle cx="${x}" cy="${y}" r="9" fill="${colour}" class="body"/>`
      : `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${colour}" stroke-width="2" stroke-dasharray="3 3"/>`;
    html += `<text x="${x}" y="${y - 13}" class="bodyLabel" fill="${colour}">${label}</text>`;
  }
  html += `<circle cx="${C}" cy="${C}" r="3" class="hub"/>`;
  svg.innerHTML = html;
  $('compassNote').textContent = state.facing == null ? 'press S to set which way you face' : `you face ${Math.round(facing)}° ${compass(facing)}`;
}

function setFacing(deg) {
  if (!Number.isFinite(deg)) return;
  state.facing = ((deg % 360) + 360) % 360;
  try { localStorage.setItem('earthscope.facing', String(state.facing)); } catch { /* fine */ }
  drawCompass();
}

// ---------- clock, ladder, dots ----------

// A calculator digit: only the lit segments of the 7 are drawn.
const SEGMENTS = { a: [10, 1, 20, 8], b: [30, 8, 8, 25], c: [30, 41, 8, 25], d: [10, 65, 20, 8], e: [2, 41, 8, 25], f: [2, 8, 8, 25], g: [10, 33, 20, 8] };
// (each lit segment has a black outline, so the digits stand out on bright pictures)
const DIGITS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function digitSvg(ch) {
  if (ch === ':') return '<svg viewBox="0 0 16 74" class="colon"><circle cx="8" cy="24" r="3.5"/><circle cx="8" cy="52" r="3.5"/></svg>';
  const on = DIGITS[ch] || '';
  return `<svg viewBox="0 0 40 74"><g transform="skewX(-4) translate(3 0)">${Object.entries(SEGMENTS).filter(([k]) => on.includes(k))
    .map(([, [x, y, w, h]]) => `<rect class="on" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`).join('')}</g></svg>`;
}

let lastTime = '';
function tickClock() {
  const tz = state.data.tz, now = new Date();
  const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
  if (time !== lastTime) {
    if ($('time').children.length !== time.length) $('time').replaceChildren(...[...time].map(() => el('span')));
    [...time].forEach((ch, i) => {
      const s = $('time').children[i];
      if (s.dataset.ch !== ch) { s.dataset.ch = ch; s.innerHTML = digitSvg(ch); s.classList.remove('tick'); void s.offsetWidth; s.classList.add('tick'); }
    });
    lastTime = time;
    const day = now.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long' }).toUpperCase();
    const date = now.toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    $('date').innerHTML = `<b>${esc(day)}</b> · ${esc(date)} <span class="utc">${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC</span>`;
    if (now.getSeconds() % 30 === 0) drawCompass();   // the sun and moon move slowly
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
function setFrameTime(t, day, note = '') {
  $('frameTime').textContent = t ? `PICTURE ${t.toLocaleString('en-GB', { timeZone: state.data.tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}${note}`
    : day ? `PICTURE ${day}` : '';
}

// ---------- keys ----------

function goLevel(i) {
  state.level = Math.max(0, Math.min(LEVELS.length - 1, i));
  $('camera').classList.toggle('drift', LEVELS[state.level] !== 'earth');   // a far-away camera, not at the Earth level
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
  else if (k === 'Enter' || k === 'w' || k === 'W') toggleWeather();
  else if (k === 's' || k === 'S') { $('setup').hidden = false; $('setupCity').focus(); }
  else return;
  e.preventDefault();
});

$('setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const facing = parseFloat($('setupFacing').value);
  if (Number.isFinite(facing)) setFacing(facing);
  const city = $('setupCity').value.trim();
  if (!city && state.place) { $('setup').hidden = true; return; }
  try { await start(await searchCity(city)); } catch (err) { status(err.message); }
});
$('setupGps').addEventListener('click', () => navigator.geolocation.getCurrentPosition(
  async (pos) => start(await describe(pos.coords.latitude, pos.coords.longitude)), (err) => status(err.message)));

// ---------- start ----------

// TV browsers can report their real size a moment after the page starts, so this runs on every frame
// and only changes the scale when the size has changed.
let fitted = '';
function fitScreen() {
  const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
  if (`${vw}x${vh}` === fitted) return;
  fitted = `${vw}x${vh}`;
  const s = Math.min(vw / W, vh / H);
  $('screen').style.transform = `translate(${(vw - W * s) / 2}px, ${(vh - H * s) / 2}px) scale(${s})`;
}

async function start(place) {
  $('setup').hidden = true;
  status('finding where you are …');
  state.here = await findHere();
  // Somewhere else than the remembered place (more than 30 km)? Then the city, state and country follow you.
  if (state.here && (!place || distanceKm(place.lat, place.lon, state.here.lat, state.here.lon) > 30)) {
    place = await describe(state.here.lat, state.here.lon).catch(() => place);
  }
  state.place = place;
  status('finding the areas …');
  place.boxes = place.boxes || await levelBoxes(place);   // remembered with the place, so later starts are quick
  state.boxes = place.boxes;
  savePlace(place);
  goLevel(LEVELS.indexOf('city'));
}

async function boot() {
  // which way you face: from the address (?facing=135), from this browser, or from the device's own compass
  const facingParam = parseFloat(new URLSearchParams(location.search).get('facing'));
  try { const saved = parseFloat(localStorage.getItem('earthscope.facing')); if (Number.isFinite(saved)) state.facing = saved; } catch { /* fine */ }
  if (Number.isFinite(facingParam)) setFacing(facingParam);
  addEventListener('deviceorientationabsolute', (ev) => { if (ev.absolute && ev.alpha != null) setFacing(360 - ev.alpha); });
  fitScreen();
  addEventListener('resize', fitScreen);
  let last = performance.now();
  const frame = (now) => { fitScreen(); scrollNews(now - last); last = now; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  setInterval(tickClock, 250);
  setInterval(() => { if (state.place) showData(); }, 10 * 60e3);                 // fresh data every 10 minutes
  setInterval(async () => { await loadNews(); if (state.place) renderNews(); }, 15 * 60e3);
  setInterval(() => {                                                                 // like a screensaver: next picture
    if (state.place && !state.weather && Date.now() - state.lastKey > 2 * 60e3 && state.views[state.view]?.kind !== 'loop') goView(state.view + 1);
  }, AUTO_VIEW_MS);
  if (!state.news) await loadNews();
  try {
    const place = await findPlace();
    if (place || navigator.geolocation) { await start(place); drawCompass(); } else $('setup').hidden = false;
  } catch (e) { status(e.message); $('setup').hidden = false; }
}

boot();
