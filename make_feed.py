"""Build a picture list of real space pictures for the Aerial Views screensaver, in two formats.

  nasa-space.csv  each line is "<picture url>,<caption>".
  entries.json    the same pictures as {"photos": [{"url-1080": ..., "title": ...}]}. Use this one on the TV:
                  Aerial Views 1.8.5 shows the caption of a photo only from entries.json, not from a CSV list.

Aerial Views reads the list again every time the screensaver starts, so running this script once a day
keeps the TV's pictures fresh.

Sources (all free, no key needed):
  Earth  NASA EPIC camera on the DSCOVR satellite, 1.5 million km away: the whole Earth, several photos a day.
  Webb   ESA/Webb picture feed: the newest James Webb Space Telescope pictures (CC BY 4.0, credit ESA/Webb).
  Mars   NASA Image Library, JPL landscapes from the Mars rovers and landers.

Usage: python make_feed.py [output.csv]   (entries.json is written in the same folder)
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

USER_AGENT = "space-feed/1.0 (home TV screensaver)"
EPIC_DAYS = 2          # the newest days of Earth photos to include
MARS_PER_SEARCH = 8    # Mars pictures per search


def get(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read() if method == "GET" else resp.status


def exists(url):
    try:
        return get(url, "HEAD") == 200
    except Exception:
        return False


def clean(text):
    # One line, no quotes at the ends: the app splits each line at its first comma only.
    return re.sub(r"\s+", " ", text).strip().strip('"')


def earth():
    items = []
    days = json.loads(get("https://epic.gsfc.nasa.gov/api/natural/available"))
    for day in sorted(days)[-EPIC_DAYS:]:
        for photo in json.loads(get(f"https://epic.gsfc.nasa.gov/api/natural/date/{day}")):
            taken = datetime.strptime(photo["date"], "%Y-%m-%d %H:%M:%S")
            y, m, d = day.split("-")
            url = f"https://epic.gsfc.nasa.gov/archive/natural/{y}/{m}/{d}/jpg/{photo['image']}.jpg"
            items.append((url, f"Earth from 1.5 million km, {taken:%d %b %Y %H:%M} UTC. NASA EPIC camera, DSCOVR"))
    return items


def webb():
    items = []
    root = ET.fromstring(get("https://esawebb.org/images/feed/"))
    for item in root.iter("item"):
        image_id = item.findtext("link", "").rstrip("/").rsplit("/", 1)[-1]
        if not image_id:
            continue
        url = f"https://cdn.esawebb.org/archives/images/wallpaper4/{image_id}.jpg"
        if not exists(url):
            url = f"https://cdn.esawebb.org/archives/images/screen/{image_id}.jpg"
            if not exists(url):
                continue
        items.append((url, f"{clean(item.findtext('title', ''))}. James Webb Space Telescope, ESA/Webb"))
    return items


MARS_SEARCHES = ("Perseverance panorama", "Perseverance view", "Curiosity panorama", "Curiosity view",
                 "Mars panorama")
# Keep landscapes; drop maps, routes, team photos, rover parts and odd projections.
MARS_KEEP = re.compile(r"panorama|view|vista|landscape|looks|scene|horizon|sunset|selfie|mosaic", re.I)
MARS_DROP = re.compile(r"team|student|map|route|traverse|path|diagram|model|illustration|artist|chart|"
                       r"graph|close-up|closeup|up close|bit\b|cover|projection|false color|stereo|orbit|anaglyph|3d\b", re.I)


def mars():
    items, seen = [], set()
    for search in MARS_SEARCHES:
        query = urllib.parse.urlencode({"q": search, "center": "JPL", "media_type": "image", "page_size": 50})
        found = json.loads(get(f"https://images-api.nasa.gov/search?{query}"))["collection"]["items"]
        found.sort(key=lambda i: i["data"][0].get("date_created", ""), reverse=True)  # newest first
        count = 0
        for it in found:
            data = it["data"][0]
            title, nasa_id = clean(data["title"]), data["nasa_id"]
            if nasa_id in seen or not MARS_KEEP.search(title) or MARS_DROP.search(title):
                continue
            seen.add(nasa_id)
            # Not every picture has every size: read the files it really has, take the best one for a TV.
            files = json.loads(get(it["href"]))
            url = next((f for size in ("~large.jpg", "~medium.jpg") for f in files if f.endswith(size)), None)
            if not url:
                continue
            items.append((url.replace("http://", "https://"), f"{title}. Mars, NASA/JPL-Caltech"))
            count += 1
            if count == MARS_PER_SEARCH:
                break
    return items


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "nasa-space.csv"
    pictures = []
    for name, source in (("Earth", earth), ("Webb", webb), ("Mars", mars)):
        try:
            found = source()
        except Exception as e:  # one broken service must not empty the whole list
            print(f"{name}: failed ({e})")
            continue
        print(f"{name}: {len(found)} pictures")
        pictures += found
    if not pictures:
        sys.exit("no pictures found; the old list is kept")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("".join(f"{url},{caption}\n" for url, caption in pictures))
    entries = os.path.join(os.path.dirname(out), "entries.json")
    with open(entries, "w", encoding="utf-8", newline="\n") as f:
        photos = [{"url-1080": url, "title": caption} for url, caption in pictures]
        json.dump({"photos": photos}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote {len(pictures)} pictures to {out} and {entries}")


if __name__ == "__main__":
    main()
