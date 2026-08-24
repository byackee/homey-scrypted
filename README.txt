Scrypted turns the cameras on your Scrypted server into Homey devices. Each one
arrives with a snapshot on its tile and a live stream you can open at home or
away, and what its detector recognises becomes Homey capabilities and Flow
triggers, so a person at the door can start a Flow while a passing car does not.
The trigger carries the frame that set it off, so a notification arrives with the
picture already attached. Doorbells come through as doorbells, with their own
trigger and snapshot.

You need a Scrypted server on your local network and a Homey Pro; Homey Cloud and
Homey Bridge cannot reach devices on your network, so they cannot reach Scrypted.
Open the app's settings, enter your server's address and your Scrypted account,
then add your cameras. A login token from "npx scrypted login" works in place of
your password and can be revoked on its own. For live video, enable Scrypted's
Rebroadcast plugin on the cameras you want to stream.
