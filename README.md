# Earth over home, for the TV screensaver

A feed for the [Aerial Views](https://github.com/theothernt/AerialViews) screensaver on Android TV that shows only
the Earth over one place, as recent as possible. A GitHub Action runs `make_feed.py` every 30 minutes and publishes
the result with GitHub Pages.

- **Video:** a time-lapse of the last daylight hours from the EUMETSAT Meteosat satellite over the Indian Ocean
  (a new picture every 15 minutes, about 30 minutes behind real time). At night it shows the last daylight hours.
- **Photos:** the newest of those satellite pictures; the newest sharp daily pictures from NASA MODIS and VIIRS
  (via NASA GIBS); NASA EPIC whole-Earth photos taken while the place faces the camera.

Every picture has a scope crosshair on the place, an info panel (weather, air quality, UV, sun, Moon, nearby
earthquakes, the space station; from Open-Meteo, USGS and wheretheiss.at) and the local news from Google News along
the bottom (scrolling in the video). The place is set with the repository secrets `LAT`, `LON`, `PLACE` and
`NEWS` (the news search).

## Earth Scope app

`scope/` is a web page that shows the same place through a scope, from the city out to the whole Earth:
https://kaipipanwar.github.io/space-feed/scope/

- Keys (keyboard or TV remote): ← → switch pictures, ↑ zoom out (city → state → country → continent → Earth),
  ↓ zoom in, OK / Enter weather layer (rain, wind, temperature), S choose another place. Anyone can use their own place: press S, or open
  `scope/?lat=..&lon=..&name=..`. The place is kept only in that browser.
- Data, all fetched live by the page: Open-Meteo (weather, soil moisture, air), USGS (earthquakes), NASA EONET
  (natural events), NOAA SWPC (space weather), wheretheiss.at,
  Esri World Imagery (sharp map, not live), EUMETSAT / NOAA GOES / JMA Himawari / NASA GIBS (incl. IMERG rain) and NASA EPIC (pictures), BigDataCloud and Nominatim (place names
  and areas). `news.json` (Bing News with summaries, Google News, BBC World) is made by `make_news.py` in the Action,
  for the place in the secrets `PLACE`, `STATE`, `COUNTRY` and `NEWS`.

- Levels: HERE (your exact spot: the closest map and live traffic) → city → state → country → continent → Earth. The
  names follow where the device really is (its own location, or `?here=<lat>,<lon>`), kept only in that browser.
- Pictures are always the newest: the live loop uses colour by day and infrared by night; NASA's sharp day photo and
  its night photo (city lights) come in the order they were taken.
- Live traffic needs a free TomTom key (developer.tomtom.com → "Maps and Traffic" key). Open the page once with
  `?tomtom=<key>`: it is kept only in that browser, never in this project.

## Use it

In Aerial Views: Media Sources → Custom feeds → add `https://kaipipanwar.github.io/space-feed/entries.json`.

## Run it yourself

`LAT=.. LON=.. PLACE=.. python make_feed.py site` (Python 3, `pip install pillow`, and ffmpeg).
