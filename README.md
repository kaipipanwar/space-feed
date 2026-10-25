# Space pictures for the TV screensaver

`nasa-space.csv` is a list of real space pictures for the [Aerial Views](https://github.com/theothernt/AerialViews)
screensaver on Android TV. A GitHub Action runs `make_feed.py` every day, so the list stays fresh.

- **Earth:** whole-Earth photos from NASA's EPIC camera on the DSCOVR satellite, 1.5 million km away.
- **Webb:** the newest James Webb Space Telescope pictures from the ESA/Webb feed (CC BY 4.0, credit ESA/Webb).
- **Mars:** rover and lander landscapes from the NASA Image Library (NASA/JPL-Caltech).

Every caption names its source. The pictures stay on NASA's and ESA's servers; this list only points to them.

## Use it

In Aerial Views: Media Sources → Custom feeds → add the raw link to `nasa-space.csv` (it must end in `.csv`).

## Run it yourself

`python make_feed.py nasa-space.csv` (Python 3, nothing to install).
