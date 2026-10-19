# Three minutes on a real phone

The acceptance run already simulates a phone (Chromium's mobile emulation,
390x844, touch): Back on every screen, search and folders by touch, a long
press then a drag, two fingers growing the text, a pinch in the viewer, the
page being installable, the name chosen on this device in its manifest, the
notification permission, the push subscription and a notification shown by
the service worker. What only a real phone shows is below. Once on Android
(Chrome), once on an iPhone (Safari), on the test deployment. Tick each line;
write what differs.

1. [ ] **Install**: Settings -> Screen -> Install, keep or change the name, confirm.
   The name **under the icon** on the home screen is that name; the app opens
   full screen. (iPhone: Share -> Add to Home Screen, the name offered is the instance's.)
2. [ ] **Back gesture** in the installed app: conversation -> Back -> the list;
   Back on the list leaves the app like any app, never a blank page.
3. [ ] **A real notification**: Settings -> Alerts -> On, allow; "Send a test":
   it arrives on the locked phone, with the instance's name; tapping it opens the app.
4. [ ] **Fingers**: a pinch on a picture in the viewer and on the page feels
   right (no jump, no page zoom); a long press then a drag of a conversation
   follows the finger. Android: with Chrome's "Force enable zoom"
   (Settings -> Accessibility) on, the viewer still fits the screen.

Ready: the four lines ticked on both phones, or what differs written down with a reason.
