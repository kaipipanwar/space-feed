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

## Use it

In Aerial Views: Media Sources → Custom feeds → add `https://kaipipanwar.github.io/space-feed/entries.json`.

## Run it yourself

`LAT=.. LON=.. PLACE=.. python make_feed.py site` (Python 3, `pip install pillow`, and ffmpeg).
