Scrypted turns your cameras into Homey devices.

Every camera on your Scrypted server appears in Homey with a snapshot on its tile
and a live stream you can open from the app, the web app, and from outside your
home. Object detections become real Homey capabilities and Flow triggers, so a
person at the door can start a Flow while a passing car does not.

WHAT YOU GET

- Live video from every camera, and a snapshot on each device tile.
- Detections as separate alarms: person, vehicle, animal, package, face. Each
  camera only shows the ones its own detector can actually report.
- A Flow trigger for detected objects, carrying the frame that triggered it, so a
  notification arrives with the picture already attached.
- A doorbell trigger, with its snapshot.
- Motion, contact, flood, tamper, noise and occupancy alarms.
- Temperature, humidity, light, air quality and battery readings.
- Lights, switches, sockets, fans, sirens, valves and scenes.
- Locks, garage doors and window coverings.
- Thermostats, air purifiers and security systems.

BEFORE YOU START

You need a Scrypted server on your local network and a Homey Pro. Homey Cloud and
Homey Bridge cannot reach devices on your network, so they cannot reach Scrypted.

Open the app's settings, enter your server's address and your Scrypted account,
then add your devices. A login token from "npx scrypted login" works in place of
your password and can be revoked on its own.

For live video, enable Scrypted's Rebroadcast plugin on the cameras you want to
stream.
