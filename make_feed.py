"""Build a screensaver feed that shows only the Earth over one place, as recent as possible.

Output folder (default "site"), published with GitHub Pages:
  entries.json   the list for the Aerial Views screensaver: one video and several photos.
  *.mp4, *.jpg   the media; every file name holds its time, so the TV never shows an old copy.

What is in it (newest first in priority):
  1. Video: time-lapse of the last daylight hours from the EUMETSAT Meteosat satellite over the Indian Ocean
     (a new picture every 15 minutes, about 30 minutes behind real time). No public live video exists.
  2. Photo: the newest of those satellite pictures, as a still.
  3. Photos: the newest sharp daily pictures from NASA's MODIS and VIIRS cameras (250-375 m per pixel).
  4. Photos: NASA EPIC whole-Earth photos taken while the place faces the camera.

The place comes from environment variables, so the exact spot is not written in the code:
  LAT, LON  the centre (degrees);  PLACE  the name shown in the captions.

Usage: LAT=.. LON=.. PLACE=.. python make_feed.py [output folder]
Needs: Pillow (pip install pillow) and ffmpeg.
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont, ImageStat

USER_AGENT = "space-feed/2.0 (home TV screensaver)"
IST = timezone(timedelta(hours=5, minutes=30))
SIZE = (1920, 1080)

EUMETSAT_WMS = "https://view.eumetsat.int/geoserver/ows"
EUMETSAT_LAYER = "msg_iodc:rgb_naturalenhncd"   # natural colour, Meteosat over the Indian Ocean, every 15 min
SAT_SPAN = (7.0, 12.5)                           # degrees (lat, lon) of the satellite view: sharp enough at 3 km
SAT_FRAMES = 24                                  # 24 x 15 min = the last 6 daylight hours
SUN_MIN = 8                                      # degrees: below this the colour picture is too dark

GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
# Daily sharp cameras, with their local pass time (hour) to sort the newest first.
GIBS_LAYERS = (("MODIS_Terra_CorrectedReflectance_TrueColor", "NASA Terra MODIS", 10.5),
               ("MODIS_Aqua_CorrectedReflectance_TrueColor", "NASA Aqua MODIS", 13.5),
               ("VIIRS_SNPP_CorrectedReflectance_TrueColor", "NASA/NOAA Suomi NPP VIIRS", 13.5),
               ("VIIRS_NOAA20_CorrectedReflectance_TrueColor", "NASA/NOAA NOAA-20 VIIRS", 13.6),
               ("VIIRS_NOAA21_CorrectedReflectance_TrueColor", "NASA/NOAA NOAA-21 VIIRS", 13.7))
CLOSE_SPANS = ((1.5, 2.67, "close"), (3.5, 6.22, "area"))
DAILY_PHOTOS = 2                                 # newest daily pictures kept per zoom

EPIC_MAX_OFFSET = 30                             # degrees of longitude between the photo centre and the place


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def wms(base, params):
    return base + "?" + urllib.parse.urlencode(params)


def bbox(lat, lon, span):
    return f"{lat - span[0] / 2},{lon - span[1] / 2},{lat + span[0] / 2},{lon + span[1] / 2}"


def sun_elevation(lat, lon, when):
    """Height of the sun above the horizon in degrees (good to about one degree)."""
    day = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60
    decl = math.radians(-23.44) * math.cos(2 * math.pi / 365 * (day + 10))
    hour_angle = math.radians(15 * (hour + lon / 15 - 12))
    lat = math.radians(lat)
    return math.degrees(math.asin(math.sin(lat) * math.sin(decl)
                                  + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)))


def black_share(img):
    return sum(img.convert("L").histogram()[:8]) / (img.width * img.height)


def font(size):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/segoeui.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def label(img, text, marker=None):
    """Write the time in the top-right corner and draw a small ring on the place."""
    draw = ImageDraw.Draw(img)
    f = font(40)
    w = draw.textlength(text, font=f)
    draw.text((SIZE[0] - w - 50, 40), text, font=f, fill="white", stroke_width=3, stroke_fill="black")
    if marker:
        x, y = marker
        for r, colour in ((16, "black"), (14, "white")):
            draw.ellipse((x - r, y - r, x + r, y + r), outline=colour, width=3)
    return img


def satellite_times():
    """The 15-minute picture times, newest first, from the server's own list."""
    caps = get(wms(EUMETSAT_WMS, {"service": "WMS", "request": "GetCapabilities", "version": "1.3.0"})).decode()
    block = caps[caps.index(f"<Name>{EUMETSAT_LAYER}</Name>"):]
    last = re.search(r'<Dimension name="time"[^>]*>[^<]*/([0-9T:\-.]+)Z/PT15M', block).group(1)
    newest = datetime.strptime(last[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    return [newest - timedelta(minutes=15 * i) for i in range(4 * 30)]


def satellite(lat, lon, place, out, stamp):
    times = [t for t in satellite_times() if sun_elevation(lat, lon, t) >= SUN_MIN][:SAT_FRAMES]
    times.reverse()  # oldest first, for the video
    if not times:
        return []
    frames = tempfile.mkdtemp()
    centre = (SIZE[0] // 2, SIZE[1] // 2)
    count = 0
    for t in times:
        try:
            raw = get(wms(EUMETSAT_WMS, {
                "service": "WMS", "request": "GetMap", "version": "1.3.0", "layers": EUMETSAT_LAYER,
                "styles": "", "crs": "EPSG:4326", "bbox": bbox(lat, lon, SAT_SPAN), "format": "image/jpeg",
                "width": 640, "height": 360, "time": t.strftime("%Y-%m-%dT%H:%M:00Z")}))
            img = Image.open(BytesIO(raw)).convert("RGB")
        except Exception as e:
            print(f"  frame {t:%H:%M} UTC failed ({e})")
            continue
        if black_share(img) > 0.2:
            continue
        # The satellite sees about 3 km per pixel: upscale smoothly instead of showing blocks.
        img = label(img.resize(SIZE, Image.LANCZOS), f"{t.astimezone(IST):%d %b, %H:%M} IST", centre)
        img.save(os.path.join(frames, f"f{count:03d}.jpg"), quality=92)
        count += 1
        last_time, last_img = t, img
    if count == 0:
        return []
    items = []
    first = times[0].astimezone(IST)
    end = last_time.astimezone(IST)
    video = f"live-{stamp}.mp4"
    # One satellite picture per second, blended into each other, then the newest held for 3 seconds.
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "1", "-i", os.path.join(frames, "f%03d.jpg"),
                    "-vf", "tpad=stop_mode=clone:stop_duration=3,minterpolate=fps=25:mi_mode=blend",
                    "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
                    "-crf", "20", "-movflags", "+faststart", os.path.join(out, video)], check=True)
    items.append(("video", video,
                  f"{place} from space, {first:%H:%M} to {end:%H:%M} IST {end:%d %b}. EUMETSAT Meteosat"))
    still = f"sat-{stamp}.jpg"
    last_img.save(os.path.join(out, still), quality=92)
    items.append(("photo", still, f"{place} from space, {end:%d %b %H:%M} IST. EUMETSAT Meteosat, newest picture"))
    shutil.rmtree(frames)
    return items


def daily(lat, lon, place, out, stamp):
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
                    "WIDTH": SIZE[0], "HEIGHT": SIZE[1], "TIME": day.isoformat()}))
                img = Image.open(BytesIO(raw)).convert("RGB")
            except Exception as e:
                print(f"  {layer} {day} failed ({e})")
                continue
            if black_share(img) > 0.01 or ImageStat.Stat(img).mean[0] > 235:  # gap, or all cloud/no data
                continue
            file = f"{name}-{day:%Y%m%d}-{layer.split('_')[0].lower()}-{kept}-{stamp}.jpg"
            label(img, f"{day:%d %b %Y}", (SIZE[0] // 2, SIZE[1] // 2)).save(os.path.join(out, file), quality=92)
            items.append(("photo", file, f"{place}, {day:%d %b %Y}. {title}"))
            kept += 1
            if kept == DAILY_PHOTOS:
                break
    return items


def epic(lat, lon, place):
    """NASA EPIC whole-Earth photos from the newest day, taken while the place faced the camera."""
    photos = json.loads(get("https://epic.gsfc.nasa.gov/api/natural"))
    near = [p for p in photos if abs((p["centroid_coordinates"]["lon"] - lon + 180) % 360 - 180) <= EPIC_MAX_OFFSET]
    items = []
    for p in near:
        taken = datetime.strptime(p["date"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        url = f"https://epic.gsfc.nasa.gov/archive/natural/{taken:%Y/%m/%d}/jpg/{p['image']}.jpg"
        items.append(("photo", url, f"Earth facing {place}, {taken.astimezone(IST):%d %b %H:%M} IST, from "
                                    "1.5 million km. NASA EPIC camera, DSCOVR"))
    return items


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "site"
    lat, lon, place = float(os.environ["LAT"]), float(os.environ["LON"]), os.environ.get("PLACE", "Home")
    base = os.environ.get("BASE_URL", "").rstrip("/")  # where the site will live; empty = relative names
    os.makedirs(out, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    items = []
    for name, source in (("Satellite", lambda: satellite(lat, lon, place, out, stamp)),
                         ("Daily", lambda: daily(lat, lon, place, out, stamp)),
                         ("EPIC", lambda: epic(lat, lon, place))):
        try:
            found = source()
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
