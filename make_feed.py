"""Build a screensaver feed that shows only the Earth over one place, as recent as possible.

Output folder (default "site"), published with GitHub Pages:
  entries.json   the list for the Aerial Views screensaver: one video and several photos.
  *.mp4, *.jpg   the media; every file name holds its time, so the TV never shows an old copy.

What is in it:
  1. Video: time-lapse of the last daylight hours from the EUMETSAT Meteosat satellite over the Indian Ocean
     (a new picture every 15 minutes, about 30 minutes behind real time). No public live video exists.
  2. Photo: the newest of those satellite pictures, as a still.
  3. Photos: the newest sharp daily pictures from NASA's MODIS and VIIRS cameras (250-375 m per pixel).
  4. Photos: NASA EPIC whole-Earth photos taken while the place faces the camera.
Every picture gets a scope crosshair on the place, an info panel (weather, air, sun, moon, earthquakes, the
space station) and the local news along the bottom; in the video the news scrolls.

The place comes from environment variables, so it is not written in the code:
  LAT, LON  the centre (degrees);  PLACE  the name shown on screen;  NEWS  the news search (default: PLACE).

Usage: LAT=.. LON=.. PLACE=.. python make_feed.py [output folder]
Needs: Pillow (pip install pillow) and ffmpeg.
"""

import json
import math
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont, ImageStat

USER_AGENT = "space-feed/3.0 (home TV screensaver)"
IST = timezone(timedelta(hours=5, minutes=30))
SIZE = W, H = 1920, 1080
CENTRE = (W // 2, H // 2)

EUMETSAT_WMS = "https://view.eumetsat.int/geoserver/ows"
EUMETSAT_LAYER = "msg_iodc:rgb_naturalenhncd"   # natural colour, Meteosat over the Indian Ocean, every 15 min
SAT_SPAN = (18.0, 32.0)                          # degrees (lat, lon): wide enough to stay sharp at ~4 km per pixel
SAT_FRAMES = 24                                  # 24 x 15 min = the last 6 daylight hours
SUN_MIN = 8                                      # degrees: below this the colour picture is too dark
HOLD, FADE, FPS = 1.6, 0.6, 25                   # video: seconds per satellite picture, cross-fade, frames per second

GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
# Daily sharp cameras, with their local pass time (hour) to sort the newest first.
GIBS_LAYERS = (("MODIS_Terra_CorrectedReflectance_TrueColor", "NASA Terra MODIS", 10.5),
               ("MODIS_Aqua_CorrectedReflectance_TrueColor", "NASA Aqua MODIS", 13.5),
               ("VIIRS_SNPP_CorrectedReflectance_TrueColor", "NASA/NOAA Suomi NPP VIIRS", 13.5),
               ("VIIRS_NOAA20_CorrectedReflectance_TrueColor", "NASA/NOAA NOAA-20 VIIRS", 13.6),
               ("VIIRS_NOAA21_CorrectedReflectance_TrueColor", "NASA/NOAA NOAA-21 VIIRS", 13.7))
CLOSE_SPANS = ((1.5, 2.67, "close"), (3.5, 6.22, "area"))
DAILY_PHOTOS = 1                                 # only the newest daily picture per zoom

EPIC_MAX_OFFSET = 30                             # degrees of longitude between the photo centre and the place

NEON = (57, 255, 20)                             # neon green: titles, reticle, labels
TEXT = (200, 255, 210)                           # pale green: panel text
PANEL = (0, 0, 0, 150)
TICKER_H, TICKER_SPEED = 64, 150                 # news strip height (px) and scroll speed (px per second)


# ---------- small helpers ----------

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def get_json(url, params=None):
    return json.loads(get(url + ("?" + urllib.parse.urlencode(params) if params else "")))


def wms(base, params):
    return base + "?" + urllib.parse.urlencode(params)


def bbox(lat, lon, span):
    return f"{lat - span[0] / 2},{lon - span[1] / 2},{lat + span[0] / 2},{lon + span[1] / 2}"


def sun_position(lat, lon, when):
    """The sun's height above the horizon and its compass direction, in degrees (good to about one degree)."""
    day = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60
    decl = math.radians(-23.44) * math.cos(2 * math.pi / 365 * (day + 10))
    hour_angle = math.radians(15 * (hour + lon / 15 - 12))
    lat = math.radians(lat)
    elevation = math.asin(math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle))
    azimuth = math.atan2(math.sin(hour_angle), math.cos(hour_angle) * math.sin(lat) - math.tan(decl) * math.cos(lat))
    return math.degrees(elevation), (math.degrees(azimuth) + 180) % 360


def sun_elevation(lat, lon, when):
    return sun_position(lat, lon, when)[0]


def density_altitude(pressure_hpa, temp_c):
    """How high the air "feels" to a bullet or a plane: pressure altitude corrected for heat (metres)."""
    pressure_alt_ft = (1 - (pressure_hpa / 1013.25) ** 0.190284) * 145366.45
    isa_c = 15 - 1.98 * pressure_alt_ft / 1000
    return (pressure_alt_ft + 118.8 * (temp_c - isa_c)) * 0.3048


def distance_km(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return 6371 * math.acos(max(-1.0, min(1.0, c)))


def black_share(img):
    return sum(img.convert("L").histogram()[:8]) / (img.width * img.height)


def font(size, bold=False):
    names = ("DejaVuSans-Bold.ttf", "segoeuib.ttf") if bold else ("DejaVuSans.ttf", "segoeui.ttf")
    for folder in ("/usr/share/fonts/truetype/dejavu/", "C:/Windows/Fonts/"):
        for name in names:
            if os.path.exists(folder + name):
                return ImageFont.truetype(folder + name, size)
    return ImageFont.load_default(size)


def compass(deg):
    return ("N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())[round(deg / 22.5) % 16]


def aqi_name(v):
    for limit, name in ((50, "good"), (100, "moderate"), (150, "unhealthy for some"), (200, "unhealthy"),
                        (300, "very unhealthy")):
        if v <= limit:
            return name
    return "hazardous"


def moon(now):
    """Moon phase from the mean lunar month (good to about half a day)."""
    month = 29.530588
    age = ((now - datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)).total_seconds() / 86400) % month
    lit = (1 - math.cos(2 * math.pi * age / month)) / 2
    names = ("new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon", "waning gibbous",
             "last quarter", "waning crescent")
    return f"{names[int((age / month * 8 + 0.5) % 8)]}, {lit:.0%} lit"


# ---------- facts about the place ----------

def facts(lat, lon, now):
    """Everything the info panel shows. A broken service only blanks its own line."""
    out = {}
    try:
        wx = get_json("https://api.open-meteo.com/v1/forecast", {
            "latitude": lat, "longitude": lon, "timezone": "Asia/Kolkata", "forecast_days": 1, "wind_speed_unit": "kmh",
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,"
                       "cloud_cover,visibility,uv_index,surface_pressure,pressure_msl,dew_point_2m,wind_gusts_10m",
            "daily": "sunrise,sunset,temperature_2m_max,temperature_2m_min,uv_index_max"})
        c, d = wx["current"], wx["daily"]
        out["elevation"] = wx.get("elevation")
        out["weather"] = [
            f"{c['temperature_2m']:.0f}°C, feels {c['apparent_temperature']:.0f}°C  (today {d['temperature_2m_min'][0]:.0f}"
            f"–{d['temperature_2m_max'][0]:.0f}°C)",
            f"Wind {c['wind_speed_10m']:.0f} km/h from {compass(c['wind_direction_10m'])} · humidity {c['relative_humidity_2m']:.0f}%",
            f"Cloud {c['cloud_cover']:.0f}% · visibility {c['visibility'] / 1000:.0f} km",
            f"UV now {c['uv_index']:.0f}, today's peak {d['uv_index_max'][0]:.0f}",
            f"Sunrise {d['sunrise'][0][-5:]} · sunset {d['sunset'][0][-5:]}"]
        elev, azim = sun_position(lat, lon, now)
        out["scope"] = [
            f"WIND   {c['wind_speed_10m'] / 3.6:.1f} m/s · {c['wind_direction_10m']:03.0f}° {compass(c['wind_direction_10m'])}",
            f"GUSTS  {c['wind_gusts_10m'] / 3.6:.1f} m/s",
            f"TEMP   {c['temperature_2m']:.1f}°C · DEW {c['dew_point_2m']:.1f}°C",
            f"HUMID  {c['relative_humidity_2m']:.0f}%",
            f"PRESS  {c['surface_pressure']:.0f} hPa stn · {c['pressure_msl']:.0f} MSL",
            f"DENS ALT  {density_altitude(c['surface_pressure'], c['temperature_2m']):,.0f} m",
            f"VIS    {c['visibility'] / 1000:.1f} km",
            f"SUN    az {azim:03.0f}° · el {elev:+.0f}°",
            f"MOON   {moon(now)}"]
    except Exception as e:
        print(f"  weather failed ({e})")
    try:
        air = get_json("https://air-quality-api.open-meteo.com/v1/air-quality",
                       {"latitude": lat, "longitude": lon, "current": "us_aqi,pm2_5"})["current"]
        out["air"] = f"Air: AQI {air['us_aqi']:.0f} ({aqi_name(air['us_aqi'])}) · PM2.5 {air['pm2_5']:.0f} µg/m³"
    except Exception as e:
        print(f"  air failed ({e})")
    out["moon"] = f"Moon: {moon(now)}"
    try:
        quakes = get_json("https://earthquake.usgs.gov/fdsnws/event/1/query", {
            "format": "geojson", "latitude": lat, "longitude": lon, "maxradiuskm": 500, "minmagnitude": 2.5,
            "starttime": (now - timedelta(days=7)).strftime("%Y-%m-%d")})["features"]
        if quakes:
            big = max(quakes, key=lambda q: q["properties"]["mag"])
            qlon, qlat = big["geometry"]["coordinates"][:2]
            out["quakes"] = (f"Earthquakes, 500 km, 7 days: {len(quakes)} (biggest M{big['properties']['mag']:.1f}, "
                             f"{distance_km(lat, lon, qlat, qlon):.0f} km away)")
        else:
            out["quakes"] = "Earthquakes, 500 km, 7 days: none"
    except Exception as e:
        print(f"  earthquakes failed ({e})")
    try:
        iss = get_json("https://api.wheretheiss.at/v1/satellites/25544")
        out["iss"] = f"Space station: {distance_km(lat, lon, iss['latitude'], iss['longitude']):,.0f} km away"
    except Exception as e:
        print(f"  space station failed ({e})")
    return out


def news(search, now):
    """Newest local headlines from Google News (English, India), last 3 days."""
    try:
        rss = get("https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": search, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"}))
        items = []
        for it in ET.fromstring(rss).iter("item"):
            title = re.sub(r"\s+", " ", it.findtext("title", "")).strip()
            when = parsedate_to_datetime(it.findtext("pubDate"))
            if title and now - when < timedelta(days=3) and all(ord(ch) < 0x2E80 for ch in title):
                items.append((when, title))
        items.sort(reverse=True)
        return [f"{when.astimezone(IST):%d %b %H:%M}  {title}" for when, title in items[:12]]
    except Exception as e:
        print(f"  news failed ({e})")
        return []


# ---------- drawing ----------

def crosshair(layer, x, y, scale=1.0):
    """A duplex rifle-scope reticle: thick posts outside, thin lines inside, a gap and dot in the middle."""
    d = ImageDraw.Draw(layer)
    ring, gap = int(300 * scale), int(26 * scale)
    shadow, neon = (0, 0, 0, 25), NEON + (55,)
    for colour, grow in ((shadow, 1), (neon, 0)):
        thick, thin = 2 + grow, 1 + grow
        for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            far = 2000
            d.line((x + sx * ring, y + sy * ring, x + sx * far, y + sy * far), fill=colour, width=thick)
            d.line((x + sx * gap, y + sy * gap, x + sx * ring, y + sy * ring), fill=colour, width=thin)
            for k in range(1, 5):  # range marks, like mil-dots
                r = gap + k * (ring - gap) // 5
                if sx:
                    d.line((x + sx * r, y - 9 * scale, x + sx * r, y + 9 * scale), fill=colour, width=thin)
                else:
                    d.line((x - 9 * scale, y + sy * r, x + 9 * scale, y + sy * r), fill=colour, width=thin)
        d.ellipse((x - ring, y - ring, x + ring, y + ring), outline=colour, width=thin)
    d.ellipse((x - 6, y - 6, x + 6, y + 6), outline="black", width=2)   # the centre dot stays solid
    d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=NEON + (255,))


def hud(place, lat, lon, info, source, target=CENTRE, scale=1.0):
    """The parts that stay still: crosshair, coordinates and the info panel (one transparent layer)."""
    layer = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    crosshair(layer, *target, scale)
    d = ImageDraw.Draw(layer)
    ns, ew = "N" if lat >= 0 else "S", "E" if lon >= 0 else "W"
    tag = f"{abs(lat):.2f}°{ns} {abs(lon):.2f}°{ew}"
    if info.get("elevation") is not None:
        tag += f" · {info['elevation']:.0f} m"
    d.text((target[0] + 22, target[1] - 52), tag, font=font(28, True), fill=NEON, stroke_width=3, stroke_fill="black")

    lines = [(place.upper(), font(40, True)), (tag, font(26)), (source, font(24))]
    # (the top-right corner stays free for the TV's own clock)
    body = info.get("weather", []) + [info[k] for k in ("air", "moon", "quakes", "iss") if k in info]
    lines += [(text, font(26)) for text in body]
    x0, y0, pad, gap = 40, 36, 22, 10
    height = sum(f.size + gap for _, f in lines) + 2 * pad + 8
    width = max(d.textlength(t, font=f) for t, f in lines) + 2 * pad
    d.rounded_rectangle((x0, y0, x0 + width, y0 + height), radius=14, fill=PANEL)
    d.line((x0 + pad, y0 + pad + 40 + 26 + 24 + 3 * gap + 4, x0 + width - pad, y0 + pad + 40 + 26 + 24 + 3 * gap + 4),
           fill=NEON + (200,), width=2)
    y = y0 + pad
    for i, (text, f) in enumerate(lines):
        if i == 3:
            y += 8
        d.text((x0 + pad, y), text, font=f, fill=NEON if i == 0 else TEXT)
        y += f.size + gap
    layer.time_xy = (x0 + 4, int(y0 + height + 16))

    # Scope data on the right, under the TV's clock, like a ballistic computer.
    if info.get("scope"):
        f, title = font(24), font(26, True)
        rows = info["scope"]
        width = max(d.textlength(t, font=f) for t in rows) + 2 * pad
        height = title.size + 14 + len(rows) * (f.size + 8) + 2 * pad
        x1, y1 = W - 40 - width, 130
        d.rounded_rectangle((x1, y1, x1 + width, y1 + height), radius=14, fill=PANEL, outline=NEON + (90,), width=1)
        d.text((x1 + pad, y1 + pad), "SCOPE DATA", font=title, fill=NEON)
        y = y1 + pad + title.size + 14
        for text in rows:
            d.text((x1 + pad, y), text, font=f, fill=TEXT)
            y += f.size + 8
    return layer


def ticker_strip(headlines):
    """One long image of all headlines, for the scrolling news line in the video."""
    f = font(30)
    text = "      •      ".join(headlines) + "      •      "
    width = int(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(text, font=f)) + 1
    strip = Image.new("RGB", (width, TICKER_H), (12, 12, 12))
    ImageDraw.Draw(strip).text((0, (TICKER_H - 36) // 2), text, font=f, fill="white")
    return strip


def news_label(img, place):
    """The red "<PLACE> NEWS" box at the left of the news line; returns where the headlines may start."""
    d = ImageDraw.Draw(img)
    f = font(28, True)
    label = f"{place.upper()} NEWS"
    width = int(d.textlength(label, font=f)) + 40
    d.rectangle((0, H - TICKER_H, width, H), fill=NEON)
    d.text((20, H - TICKER_H + (TICKER_H - 34) // 2), label, font=f, fill="black")
    return width


def still_news(img, place, headlines):
    """News line for photos: the newest headline (photos cannot scroll)."""
    ImageDraw.Draw(img).rectangle((0, H - TICKER_H, W, H), fill=(12, 12, 12))
    start = news_label(img, place)
    if headlines:
        f = font(30)
        text = headlines[0]
        d = ImageDraw.Draw(img)
        while d.textlength(text, font=f) > W - start - 40 and len(text) > 10:
            text = text[:-2]
        if text != headlines[0]:
            text = text.rstrip() + "…"
        d.text((start + 20, H - TICKER_H + (TICKER_H - 36) // 2), text, font=f, fill="white")


def picture_time(img, text, xy):
    """When the picture was taken, just under the info panel."""
    ImageDraw.Draw(img).text(xy, text, font=font(40, True), fill=NEON, stroke_width=3, stroke_fill="black")


def finish_photo(img, layer, place, headlines, when_text, path):
    img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
    picture_time(img, when_text, layer.time_xy)
    still_news(img, place, headlines)
    img.save(path, quality=92)


# ---------- the pictures ----------

def satellite_times():
    """The 15-minute picture times, newest first, from the server's own list."""
    caps = get(wms(EUMETSAT_WMS, {"service": "WMS", "request": "GetCapabilities", "version": "1.3.0"})).decode()
    block = caps[caps.index(f"<Name>{EUMETSAT_LAYER}</Name>"):]
    last = re.search(r'<Dimension name="time"[^>]*>[^<]*/([0-9T:\-.]+)Z/PT15M', block).group(1)
    newest = datetime.strptime(last[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    return [newest - timedelta(minutes=15 * i) for i in range(4 * 30)]


def satellite(lat, lon, place, info, headlines, out, stamp):
    times = [t for t in satellite_times() if sun_elevation(lat, lon, t) >= SUN_MIN][:SAT_FRAMES]
    times.reverse()  # oldest first, for the video

    def fetch(t):
        try:
            raw = get(wms(EUMETSAT_WMS, {
                "service": "WMS", "request": "GetMap", "version": "1.3.0", "layers": EUMETSAT_LAYER,
                "styles": "", "crs": "EPSG:4326", "bbox": bbox(lat, lon, SAT_SPAN), "format": "image/jpeg",
                "width": W // 2, "height": H // 2, "time": t.strftime("%Y-%m-%dT%H:%M:00Z")}))
            return Image.open(BytesIO(raw)).convert("RGB")
        except Exception as e:
            print(f"  frame {t:%H:%M} UTC failed ({e})")

    with ThreadPoolExecutor(6) as pool:  # the server is slow per picture, so ask for several at once
        pictures = list(pool.map(fetch, times))
    # ~4 km per pixel: upscale smoothly
    frames = [(t, img.resize(SIZE, Image.LANCZOS)) for t, img in zip(times, pictures)
              if img is not None and black_share(img) < 0.2]
    if not frames:
        return []
    source = "EUMETSAT Meteosat, every 15 minutes"
    layer = hud(place, lat, lon, info, source)
    # Each satellite picture with the still parts drawn on, then blended into the next one.
    shown = []
    for t, img in frames:
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        picture_time(img, f"{t.astimezone(IST):%d %b, %H:%M} IST", layer.time_xy)
        shown.append(img)
    strip = ticker_strip(headlines) if headlines else None
    canvas = Image.new("RGB", SIZE)
    start = news_label(canvas, place)
    label = canvas.crop((0, H - TICKER_H, start, H))

    video = f"live-{stamp}.mp4"
    per = int(HOLD * FPS)
    fade = int(FADE * FPS)
    total = per * len(shown) + 3 * FPS  # the newest picture stays 3 seconds longer
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
         "-crf", "21", "-movflags", "+faststart", os.path.join(out, video)], stdin=subprocess.PIPE)
    for n in range(total):
        i, k = divmod(n, per)
        if i >= len(shown) - 1:
            frame = shown[-1].copy()
        elif k >= per - fade:
            frame = Image.blend(shown[i], shown[i + 1], (k - (per - fade) + 1) / (fade + 1))
        else:
            frame = shown[i].copy()
        frame.paste((12, 12, 12), (0, H - TICKER_H, W, H))
        if strip:
            offset = int(n * TICKER_SPEED / FPS) % strip.width
            window = strip.crop((offset, 0, offset + W - start, TICKER_H))
            if offset + W - start > strip.width:  # wrap around to the first headline
                window.paste(strip.crop((0, 0, offset + W - start - strip.width, TICKER_H)), (strip.width - offset, 0))
            frame.paste(window, (start, H - TICKER_H))
        frame.paste(label, (0, H - TICKER_H))
        ffmpeg.stdin.write(frame.tobytes())
    ffmpeg.stdin.close()
    if ffmpeg.wait():
        raise RuntimeError("ffmpeg failed")

    first, end = frames[0][0].astimezone(IST), frames[-1][0].astimezone(IST)
    items = [("video", video, f"{place} from space, {first:%H:%M} to {end:%H:%M} IST {end:%d %b}. EUMETSAT Meteosat")]
    still = f"sat-{stamp}.jpg"
    finish_photo(frames[-1][1], layer, place, headlines, f"{end:%d %b, %H:%M} IST", os.path.join(out, still))
    items.append(("photo", still, f"{place} from space, {end:%d %b %H:%M} IST. EUMETSAT Meteosat, newest picture"))
    return items


def daily(lat, lon, place, info, headlines, out, stamp):
    """Newest sharp daily pictures (MODIS/VIIRS), checked for gaps between the satellite's stripes."""
    today = datetime.now(timezone.utc).date()
    items = []
    for span_lat, span_lon, name in CLOSE_SPANS:
        candidates = sorted(((today - timedelta(days=d), layer, title, hour)
                             for d in range(4) for layer, title, hour in GIBS_LAYERS),
                            key=lambda c: (c[0], c[3]), reverse=True)
        kept = 0
        for day, layer, title, _ in candidates:
            try:
                raw = get(wms(GIBS_WMS, {
                    "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": layer, "CRS": "EPSG:4326",
                    "BBOX": bbox(lat, lon, (span_lat, span_lon)), "FORMAT": "image/jpeg",
                    "WIDTH": W, "HEIGHT": H, "TIME": day.isoformat()}))
                img = Image.open(BytesIO(raw)).convert("RGB")
            except Exception as e:
                print(f"  {layer} {day} failed ({e})")
                continue
            if black_share(img) > 0.01 or ImageStat.Stat(img).mean[0] > 235:  # gap, or all cloud/no data
                continue
            file = f"{name}-{day:%Y%m%d}-{layer.split('_')[0].lower()}-{kept}-{stamp}.jpg"
            finish_photo(img, hud(place, lat, lon, info, f"{title}, {day:%d %b %Y}"), place, headlines,
                         f"{day:%d %b %Y}", os.path.join(out, file))
            items.append(("photo", file, f"{place}, {day:%d %b %Y}. {title}"))
            kept += 1
            if kept == DAILY_PHOTOS:
                break
    return items


def on_globe(img, lat, lon, centre_lat, centre_lon):
    """Where the place is on a whole-Earth photo: find the disc, then project the place onto it."""
    gray = img.convert("L").point(lambda p: 255 if p > 20 else 0)
    left, top, right, bottom = gray.getbbox()
    cx, cy, r = (left + right) / 2, (top + bottom) / 2, max(right - left, bottom - top) / 2
    p, p0, dl = math.radians(lat), math.radians(centre_lat), math.radians(lon - centre_lon)
    x = math.cos(p) * math.sin(dl)
    y = math.cos(p0) * math.sin(p) - math.sin(p0) * math.cos(p) * math.cos(dl)
    return cx + r * x, cy - r * y


def epic(lat, lon, place, info, headlines, out, stamp):
    """NASA EPIC whole-Earth photos from the newest day, taken while the place faced the camera."""
    photos = get_json("https://epic.gsfc.nasa.gov/api/natural")
    offset = lambda p: abs((p["centroid_coordinates"]["lon"] - lon + 180) % 360 - 180)
    near = sorted((p for p in photos if offset(p) <= EPIC_MAX_OFFSET), key=offset)[:1]  # the one facing it most
    items = []
    for n, p in enumerate(near):
        taken = datetime.strptime(p["date"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        url = f"https://epic.gsfc.nasa.gov/archive/natural/{taken:%Y/%m/%d}/jpg/{p['image']}.jpg"
        globe = Image.open(BytesIO(get(url))).convert("RGB")
        # Fit the round photo into the 16:9 screen, on black, with room for the panel on the left.
        side = H - TICKER_H - 20
        globe = globe.resize((side, side), Image.LANCZOS)
        img = Image.new("RGB", SIZE)
        left = W - side - 120
        img.paste(globe, (left, 10))
        x, y = on_globe(globe, lat, lon, p["centroid_coordinates"]["lat"], p["centroid_coordinates"]["lon"])
        file = f"globe-{taken:%Y%m%d%H%M}-{stamp}.jpg"
        layer = hud(place, lat, lon, info, "NASA EPIC camera, 1.5 million km away", (int(left + x), int(10 + y)), 0.35)
        finish_photo(img, layer, place, headlines, f"{taken.astimezone(IST):%d %b, %H:%M} IST", os.path.join(out, file))
        items.append(("photo", file, f"Earth facing {place}, {taken.astimezone(IST):%d %b %H:%M} IST, from "
                                     "1.5 million km. NASA EPIC camera, DSCOVR"))
    return items


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "site"
    lat, lon, place = float(os.environ["LAT"]), float(os.environ["LON"]), os.environ.get("PLACE", "Home")
    base = os.environ.get("BASE_URL", "").rstrip("/")  # where the site will live; empty = relative names
    os.makedirs(out, exist_ok=True)
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%d%H%M")
    info = facts(lat, lon, now)
    headlines = news(os.environ.get("NEWS") or place, now)
    print(f"Facts: {len(info)} groups, news: {len(headlines)} headlines")
    items = []
    for name, source in (("Satellite", satellite), ("Daily", daily), ("EPIC", epic)):
        try:
            found = source(lat, lon, place, info, headlines, out, stamp)
        except Exception as e:  # one broken service must not empty the whole list
            print(f"{name}: failed ({e})")
            continue
        print(f"{name}: {len(found)} items")
        items += found
    if not items:
        sys.exit("nothing found")

    def link(f):
        return f if f.startswith("http") or not base else f"{base}/{f}"

    feed = {
        "assets": [{"id": f, "accessibilityLabel": text, "url-1080-H264": link(f), "url-1080-SDR": link(f)}
                   for kind, f, text in items if kind == "video"],
        "photos": [{"url-1080": link(f), "title": text} for kind, f, text in items if kind == "photo"],
    }
    with open(os.path.join(out, "entries.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(feed, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote {len(feed['assets'])} video(s) and {len(feed['photos'])} photos to {out}")


if __name__ == "__main__":
    main()
