# Homey ⇄ Scrypted

A Homey app that brings a [Scrypted](https://scrypted.app) server into Homey: cameras with
live video and snapshots, and object detections as Flow triggers.

**v1 ships cameras and doorbells only.** Drivers for the other families Scrypted exposes —
lights, switches, sensors, locks, thermostats, alarm systems — were written and are in the
git history, but no such device was available to test them against, and an untested driver
does not belong in front of users. The translation layer already covers their interfaces,
so reinstating one is a routing entry plus a driver directory, not a rewrite.

> Requires **Homey Pro** (or Homey Pro mini) running **v12.7.0 or newer**. Homey Cloud and
> Homey Bridge cannot reach devices on your local network, so they cannot talk to Scrypted.

## What it does

| Scrypted | In Homey |
| --- | --- |
| Camera snapshot | Snapshot tile, and an image token on Flow triggers |
| Camera video stream | Live video, served over RTSP and proxied to WebRTC by Homey |
| Object detection | `alarm_person`, `alarm_vehicle`, `alarm_animal`, `alarm_package`, `alarm_face` and an **object detected** Flow trigger |
| Doorbell press | **Doorbell is pressed** Flow trigger, with a snapshot token |
| Motion, contact, flood, tamper, noise, occupancy | The matching Homey alarms |
| Temperature, humidity, luminance, UV, CO₂, PM2.5, PM10, VOC, NOx, air quality, battery | The matching Homey measurements |
| A camera's own switch, floodlight or siren | On/off, dim |

Because Homey proxies video through its own WebRTC layer since v12.12.0, a LAN-only RTSP
stream from Scrypted plays in the Homey mobile app, in the web app, and from outside your
network — without port forwarding and without this app doing any NAT traversal.

## Setup

1. In Scrypted, make sure the **Rebroadcast** plugin is enabled for the cameras you want to
   stream. It is what publishes the RTSP URL this app hands to Homey.
2. In Homey, open **More → Apps → Scrypted → Configure** and enter your server:

   | Field | Example |
   | --- | --- |
   | Host | `192.168.1.50` |
   | Port | `10443` |
   | Username | `admin` |
   | Password | your password, or a login token from `npx scrypted login` |

   A login token is preferable to a password: it can be revoked without changing your
   Scrypted credentials. The page shows the connection status, and reports Scrypted's own
   error verbatim if it fails.
3. Then add devices: **Devices → + → Scrypted → Camera** (or Light, Sensor…). The list
   shows everything on the server that this driver can adopt.

Configuration deliberately lives in the settings page rather than in the pairing flow. A
custom pairing view followed by a system template could not be navigated into: both
`Homey.showView()` and `Homey.nextView()` fail inside Homey's pairing frontend with
`null is not an object (evaluating '$(otherView).html')`, which leaves the pairing screen
blank. Pairing therefore uses the plain template flow with no navigation code of its own.

Scrypted's self-signed certificate is accepted automatically. The server can be changed
later from the same settings page, or by repairing any device.

## How it is built

Scrypted devices advertise a free-form set of interfaces, and two cameras from different
plugins routinely expose different ones. Fixed Homey driver manifests cannot express that,
so this app derives capabilities at runtime:

```
app.mts                       owns the single RPC connection to Scrypted
lib/ScryptedHub.mts           login, reconnect with backoff, device lookup
lib/capabilityMap.mts         Scrypted interface → Homey capability, declaratively
lib/deviceTypeMap.mts         Scrypted device type → driver + Homey device class
lib/BaseScryptedDevice.mts    reconciles a Homey device against live Scrypted state
lib/BaseScryptedDriver.mts    shared pairing and repair
lib/homeyVideos.mts           typings for Homey's Videos API, absent from the published types
lib/streamUrl.mts             rewrites Scrypted's loopback stream URLs
drivers/camera/
```

`CAPABILITY_BINDINGS` is deliberately kept complete rather than trimmed to what a camera
uses. Cameras are not only cameras: a floodlight cam exposes `OnOff` and `Brightness`, a
doorbell exposes `BinarySensor`, battery cameras expose `Battery` and `Charger`. Keeping
the table whole means those work without special-casing, and it is what makes reinstating
a device family cheap. Supporting a new Scrypted interface is one entry in it — no
driver or manifest change. `BaseScryptedDevice` re-runs the reconciliation after every
reconnect, so a device that gains an interface (a motion mixin being switched on, say)
picks it up without being re-paired.

One connection is shared by every device. Scrypted's RPC is multiplexed, so this keeps both
the app's memory use and the server's session count flat no matter how many devices you add.

## Development

```sh
npm install
npm run typecheck     # tsc over the app and the tests
npm test              # unit tests for the conversion and routing logic
npm run app:build     # generate driver views, run Homey Compose, compile, validate
npm run validate:publish
homey app run         # run against a Homey Pro on your network
```

The npm `build` script must stay a plain `tsc`: the Homey CLI runs it itself as its
TypeScript step, so putting `homey app build` there makes the CLI recurse into itself and
fork indefinitely. The composite command lives under `app:build` for that reason.

`drivers/*/{pair,repair}/*.html` are **generated** from `assets/views/` by
`tools/build-driver-views.mjs`; edit the source, not the copies. Homey Compose has no way to
share a custom view between drivers, so the copies are checked in to keep `homey app run`
working without a build step.

**The destination folder is not interchangeable.** A view resolves from
`drivers/<id>/pair/<viewId>.html` when pairing declares it and from
`drivers/<id>/repair/<viewId>.html` when repair does, so the generator reads each
`driver.compose.json` and writes into the folder that driver's declaration implies. It used
to write everything into `pair/` regardless, which left repair with no file anywhere Homey
looks: tapping Repair failed with `error_unknown_getting_file`. Nothing caught it, because
`repair` is absent from Homey's app manifest schema and `homey app validate` walks
`drivers[].pair[]` only — `test/repairViews.test.mts` exists to assert what the validator
will not.

### App Store images

The app image is a dusk shot of a house entrance with a camera under the eave; the driver
image is a camera on white. Both were generated, then cut to size with the tool below.

There is no reusable image catalogue. Homey publishes a Sketch template from the guidelines
page, but opening it shows four empty artboards at the required sizes and no bitmaps at all
— it scaffolds dimensions, nothing more. Scrypted's repository has no blanket licence, and
no code licence grants logo rights in any case, so using its artwork means asking its
author. A commercially licensed photo (Unsplash, Pexels) avoids that.

**The app image and the driver image are not the same picture**, and using one for the other
is called out explicitly in the guidelines:

| | Wanted | Rejected |
| --- | --- | --- |
| App image, 10:7 | A lively lifestyle or brand photo | A logo, an icon, a flat shape on a plain background |
| Driver image, square | The device itself on a **white background** | The app image, the app icon |

Once both pictures are chosen, this produces every required size, centre-cropping to the
target aspect before resizing so nothing is stretched:

```sh
node tools/build-images.mjs app    path/to/lifestyle-photo.jpg   # 250x175, 500x350, 1000x700
node tools/build-images.mjs camera path/to/camera-on-white.jpg   # 75x75, 500x500, 1000x1000
```

It warns when the source is too small to fill the largest size. Requires `sips`, which
ships with macOS.

If the pictures are generated rather than photographed, ask for 1536x1024 for the app image
and 1024x1024 for the driver image, so downscaling keeps detail. Prompts that encode the
guidelines' constraints:

<details>
<summary>App image prompt</summary>

```
A warm, photorealistic wide shot of a modern home entrance at dusk. A small,
discreet white security camera is mounted under the eave in the upper left,
slightly out of focus. The front door is softly lit from inside, warm light
spilling onto stone steps and a few plants. Shallow depth of field, cinematic
natural lighting, deep blues in the sky contrasting with warm interior light,
a subtle violet cast in the shadows.

No people, no faces, no text, no letters, no watermarks, no logos, no brand
names, no user interface elements, no phone or tablet screens. Nothing
centered or symmetrical — leave the middle of the frame calm and uncluttered.
Landscape orientation.
```
</details>

<details>
<summary>Driver image prompt</summary>

```
A clean product photograph of a modern white indoor IP security camera on a
pure white seamless background. Three-quarter view from the right to give the
body depth. Soft, even studio lighting with a very subtle contact shadow
beneath it. The camera is centered with generous even margins around it.
Photorealistic, sharp, high detail.

Background must be pure white (#FFFFFF), completely plain. No text, no
letters, no watermarks, no logos, no brand names, no LED indicators showing
symbols, no cables, no props, no gradient, no reflections on the floor.
Square format.
```
</details>

Inspect a generated image at full size before using it. Image models routinely add garbled
lettering or invented logos to a device body, which is the first thing a reviewer notices.
Check too that the driver background is pure white rather than near-white, and that nothing
important sits in the centre of the app image.

`app.json` is likewise generated by Homey Compose from `.homeycompose/` and the
`*.compose.json` files. Do not edit it by hand.

### Installing on a Homey Pro

```sh
npx homey login
npx homey select                      # or --id <homey-id>
npx homey app install                 # builds, uploads, installs; no Docker needed
```

`homey app run` is the alternative and streams logs, but it runs the app in a Docker
container on your machine, so it needs a Docker daemon. `homey app install` does not.

### Diagnostics

If a camera plays at home but not away, work through it in this order — each step is
cheaper than the next:

1. Set that camera's **Video stream** setting to `Remote` (the default).
2. In Scrypted, set the stream's **RTSP Parser** to `FFmpeg (TCP)`.
3. In Scrypted, transcode the stream into a synthetic stream and assign it to
   **Remote (Medium Resolution) Stream**.

```sh
npx homey api diagnose                # which discovery strategies reach the Homey
npx homey api apps get-app --id com.dataweavelabs.scrypted --json   # state, crashed, memory

# What the app sees on the Scrypted server: system-state contents, device types, the
# pairing result per driver, the capabilities of each paired device, and a trace buffer.
npx homey api raw --method GET \
  --path /api/app/com.dataweavelabs.scrypted/diagnostics --json

# Add ?video=1 to also resolve each camera's stream URL, credentials masked. It is opt-in
# because resolving a URL asks Scrypted to start the stream.
```

`get-app` reporting `"state": "running", "crashed": false` is the quickest confirmation
that the app booted on the Homey.

**There is no way to read the logs of a CLI-installed app.** `homey app manage` opens
Homey Developer Tools, which only lists apps submitted to the App Store — an app installed
with `homey app install` has `origin: devkit_install` and never appears there. The CLI has
no `app log` command either, and `homey api devkit get-app-std-out` only serves a live
`homey app run` session. Streaming logs therefore means `homey app run`, which needs
Docker.

For diagnosing the Scrypted connection specifically you do not need logs: the app's
settings page (Homey app → More → Apps → Scrypted → Configure) shows the live connection
status and renders the exact error Scrypted returned on a failed connect. The pairing
form does the same inline.

## A note on credentials

The Scrypted password (or login token) is stored in Homey's app settings on your Homey,
which is where every Homey app keeps its credentials. It is never written to the logs, and
neither the settings page nor the repair view can read it back — they can only replace it.
Prefer a login token from `npx scrypted login` over your account password: it can be
revoked on its own.

Scrypted normally serves HTTPS with a self-signed certificate, so the connection is
encrypted but the certificate is not verified. This is inherent to `@scrypted/client`,
which sets `rejectUnauthorized: false` itself, and applies only to this app's own requests.

## Limitations

- **Homey Pro only.** Local network access is a hard requirement.
- **No two-way audio.** Scrypted's `Intercom` interface has no Homey equivalent.
- **No PTZ.** Scrypted exposes `PanTiltZoom`; Homey has no capability for it.
- **Video is RTSP, not direct WebRTC.** Homey's `registerOfferListener` exchanges a single
  offer for a single answer with no trickle ICE, which Scrypted's signalling expects. Going
  through RTSP plus Homey's own WebRTC proxy is both simpler and more robust.
- **Detections clear on a timer.** Scrypted reports that an object was detected but never
  that it went away, so each detection alarm clears a configurable number of seconds after
  the last detection (30 by default, per camera).
- **Snapshots are capped at 5 MB** by Homey. Larger frames are reported as an error rather
  than silently truncated.
- **Rebroadcast URLs are rewritten.** Scrypted advertises its RTSP endpoints on `127.0.0.1`,
  because the consumers it was built for run inside the Scrypted process. From Homey that
  address is the Homey itself, and the player fails with "unable to open the MRL". The app
  substitutes the configured Scrypted host, keeping the port and path, which identify the
  rebroadcast session. See `lib/streamUrl.mts`.
- **The stream is chosen, not defaulted.** A camera publishes several streams, and
  Scrypted tags each with the destinations it suits. The default is usually the
  full-resolution stream tagged `local`, which many cameras will not serve to a viewer
  outside the network — the symptom is "unable to open the MRL" away from home while
  everything works at home. The app requests the stream tagged for the destination chosen
  in the camera's settings, `remote` by default, selecting it by id because `destination`
  is only a hint Scrypted does not always honour. Set it to `local` per camera if you only
  ever watch from home and want the sharper picture.
- **Resolving a stream URL starts a stream.** Cameras accept only a handful of concurrent
  RTSP clients, so opening several streams from one camera at once is enough to make a
  healthy camera start failing. This is why the `/diagnostics` video probe is opt-in and
  opens exactly one stream per camera.
- **The audio track cannot be dropped from this side.** Scrypted's rebroadcast plugin
  serves the session it already holds and ignores `audio: null` on the request — measured
  against a real server, the SDP came back byte-identical with the audio track still
  present. A camera whose audio codec a player will not accept has to be fixed in Scrypted,
  by transcoding it into a synthetic stream, or on the camera itself.
- **A camera whose stream Homey will not play may need a different RTSP parser.** Scrypted
  relays a stream with its own parser by default. Some cameras produce a stream that
  survives this on the local network but that Homey's player refuses when it is proxied —
  the symptom is again "unable to open the MRL" away from home, on that camera only, with
  every other camera on the same server working. Switching that stream's **RTSP Parser** to
  **FFmpeg (TCP)** in Scrypted fixes it: ffmpeg rebuilds the container and the
  packetisation, and reconstructs missing timestamps, without re-encoding the video. This
  was needed for a Tapo C210 whose stream was otherwise healthy — h264, correct SDP, media
  flowing, verified with a direct RTSP handshake.
- **A camera whose credentials are wrong in Scrypted** fails with `auth failed` from
  Scrypted's prebuffer plugin. That is a Scrypted-side configuration problem; the same
  camera fails in Scrypted's own UI and in HomeKit.
- Scrypted's thermostat modes are richer than Homey's four: `Eco`, `Dry`, `FanOnly` and
  `Purifier` are shown as `auto`, and only modes with an exact match are written back.
- **Detection classes come from the camera's own detector.** A camera whose model reports
  only `person`, `animal`, `face` and `motion` gets exactly those alarms and no
  `alarm_vehicle`, rather than a tile that would never become true. The Flow trigger still
  offers every class; the ones a camera cannot detect simply never fire for it.

## Two things worth knowing if you extend this

Both cost real debugging time, and neither is caught by the compiler.

**Event subscriptions must name the interface.** `device.listen({ watch: true }, cb)`
type-checks, returns a valid `EventListenerRegister`, throws nothing — and delivers no
events at all. Use the form Scrypted's own examples use, one listener per interface:

```ts
device.listen(ScryptedInterface.ObjectDetector, (source, details, data) => { … });
```

**Homey's SDK types are permissive where the runtime is strict.** Pairing results are typed
`Promise<any[]>` but Homey silently drops an entry carrying a key outside its accepted set.
A CLI-installed app has no readable log, so failures like these surface as an empty list or
a blank screen with nothing anywhere to explain them. That is what `/diagnostics` and the
trace buffer are for: they located every defect found on real hardware here, after several
plausible readings of the documentation had pointed at the wrong cause.

## Support ❤️

This app is free, and built on my own time — evenings spent making cameras, snapshots and
detections behave the same way whatever is behind them. If it puts a live picture on your
Homey when it matters, you can support the work:

- ☕ Buy me a coffee: https://buymeacoffee.com/byackee
- 🔗 All my links: https://linktr.ee/byackee

Opening an issue with your camera, your Scrypted plugin and the diagnostics output helps
just as much — every setup that lands here makes the next one work out of the box. Thank
you for using it, and for every bit of support 🙏

## Licence

MIT
