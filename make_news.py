"""Collect news with short summaries for the Earth Scope app, one list per zoom level.

Bing News RSS gives a summary for every story (Google News adds more headlines without one), but a web page may not read it directly (no CORS), so the
GitHub Action runs this and publishes news.json next to the app.

Environment: PLACE (city), STATE, COUNTRY, and NEWS (optional city search, e.g. 'Bikaner -"Bikaner House"').
Words after a minus sign in a search are also removed from the results here.
Usage: python make_news.py [output folder]
"""

import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

USER_AGENT = "Mozilla/5.0 (space-feed news for a home TV)"
MAX_AGE = timedelta(days=3)
PER_LEVEL = 15
WORLD_FEED = "https://feeds.bbci.co.uk/news/world/rss.xml"  # Bing answers broad searches with a web page, not RSS


def stories(search, now):
    excluded = [w.strip('"').lower() for w in re.findall(r'-("[^"]+"|\S+)', search)]
    words = re.sub(r'-("[^"]+"|\S+)', "", search).strip()  # Bing's own minus filter drops too much
    url = WORLD_FEED if search == "world news" else "https://www.bing.com/news/search?" + urllib.parse.urlencode(
        {"q": words, "format": "rss", "setlang": "en-IN"})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        root = ET.fromstring(resp.read())
    found = []
    for it in root.iter("item"):
        title = html.unescape(re.sub(r"\s+", " ", it.findtext("title", ""))).strip()
        summary = html.unescape(re.sub(r"<[^>]+>|\s+", " ", it.findtext("description", ""))).strip()
        when = parsedate_to_datetime(it.findtext("pubDate"))
        text = f"{title} {summary}".lower()
        if title and now - when < MAX_AGE and not any(w in text for w in excluded):
            found.append({"time": when.isoformat(), "title": title, "summary": summary[:260]})
    if search != "world news":
        found += google_headlines(words, excluded, now, {f["title"].lower()[:40] for f in found})
    found.sort(key=lambda s: s["time"], reverse=True)
    return found[:PER_LEVEL]


def google_headlines(words, excluded, now, seen):
    """More stories from Google News (headline only, no summary), skipping ones Bing already gave."""
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": words, "hl": "en-IN", "gl": "IN", "ceid": "IN:en"})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        root = ET.fromstring(resp.read())
    found = []
    for it in root.iter("item"):
        title = html.unescape(re.sub(r"\s+", " ", it.findtext("title", ""))).strip()
        title = re.sub(r" - [^-]+$", "", title)  # drop " - Newspaper name"
        when = parsedate_to_datetime(it.findtext("pubDate"))
        if (title and now - when < MAX_AGE and title.lower()[:40] not in seen
                and not any(w in title.lower() for w in excluded)):
            seen.add(title.lower()[:40])
            found.append({"time": when.isoformat(), "title": title, "summary": ""})
    return found


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "site"
    now = datetime.now(timezone.utc)
    place, state, country = (os.environ.get(k, "") for k in ("PLACE", "STATE", "COUNTRY"))
    searches = {"city": os.environ.get("NEWS") or place, "state": state, "country": country, "world": "world news"}
    feed = {"updated": now.isoformat(), "place": place, "state": state, "country": country, "levels": {}}
    for level, search in searches.items():
        if not search:
            continue
        try:
            feed["levels"][level] = stories(search, now)
            print(f"{level}: {len(feed['levels'][level])} stories")
        except Exception as e:  # one failed search must not stop the others
            print(f"{level}: failed ({e})")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "news.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(feed, f, ensure_ascii=False, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
