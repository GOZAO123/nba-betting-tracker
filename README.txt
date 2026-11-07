NBA Betting Tracker — Cloud PWA

IMPORTANT: Keep your original JSON backup safe. This ZIP includes a copy at roster-backup.json.

Deployment via GitHub Pages:
1. Create a PUBLIC GitHub repository, e.g. nba-betting-tracker (public source code; private data stays in Firestore).
2. Upload index.html, icon.svg, manifest.webmanifest, sw.js (do NOT upload roster-backup.json; keep it private).
3. Repository Settings > Pages > Deploy from a branch > main / (root) > Save.
4. Once Pages provides your HTTPS address, Firebase Console > Authentication > Settings > Authorized domains > Add domain: YOUR-USERNAME.github.io (no https:// or path).
5. Open your Pages URL, sign in with Google, and import roster-backup.json.
6. Open the same URL on PC and sign in with the SAME Google account.
7. On Android Chrome: browser menu > Add to Home screen / Install app. On PC Chrome: install icon in address bar (if offered).

Security: Firestore rules should permit only /users/{uid}/... to the authenticated matching uid.

NOTES:
- Google sign-in may need popup permissions; use Chrome on Android and PC.
- The app requires Internet to authenticate and synchronize. Cached interface alone does not guarantee offline data.
- The cloud copy is authoritative; keep regular JSON backups.
- The roster is preserved as provided, including duplicates and current team assignments.
- Checking a player marks all roster entries with the same exact name.
- The daily reset follows the local calendar date of the device making the change.
- Avoid editing the checklist on two devices simultaneously; last save wins.
