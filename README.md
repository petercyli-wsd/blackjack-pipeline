# Dealer Transition Studio - team web app

One hosted URL for teammates on Windows, macOS and Linux. Teammates need only a browser and their own funded fal/KIE account for cloud methods. Provider keys are never included in the source or deployment. The hosting owner pays server costs; each user pays their own provider generation costs.

## Deploy to Render

This folder is the source root. `render.yaml` and `Dockerfile` define the deployment. It is a Node/FFmpeg web service, not a static site or standalone HTML artifact.

1. Put this folder's source into a private GitHub/GitLab repository. Keep `.gitignore` and `.dockerignore`. Do not upload `node_modules`, `dist`, `data`, `output`, `.env`, user videos or keys. The `npm run package:source` ZIP contains only the intended source files.
2. In Render, create a **Blueprint** and connect that repository. Select its `render.yaml`. Review the hosting cost before deploying. The configuration requests one `1c-2g` instance in Frankfurt, with automatic redeploy disabled so a code push does not interrupt sessions. This is a starting configuration, not a measured capacity guarantee.
3. Deploy. Render builds the Docker image, which includes Node and Linux FFmpeg/FFprobe. No setup is needed on teammates' computers. The health endpoint is `/health`.
4. In the Render service environment settings, retrieve the generated `TEAM_PASSWORD`. Share it privately with your team along with the service's HTTPS URL. The browser login username is **team**. This is a shared access gate, separate from everyone's provider keys. Do not put provider keys in Render environment variables.
5. Open the URL. Each teammate enters their own fal/KIE keys in **Provider credentials** and clicks **Use keys for this session**. They can now upload clips, generate, compare and download.
6. Test a short free **Linear frame blend** first, then a cloud method with that person's credentials. Verify both joins in the downloaded full output. The Linux Docker image and all automated tests passed locally. A real Render deployment, browser appearance and paid cloud generation still need live verification.

The server reads Render's `RENDER_EXTERNAL_URL`. For a custom domain, set `PUBLIC_ORIGIN` to its exact HTTPS origin (for example `https://studio.example.com`); use only that canonical URL. TLS must terminate at a trusted reverse proxy. Hosted mode refuses to start without an HTTPS origin and a team password of at least 16 characters.

Official references: [Docker deployment](https://render.com/docs/docker), [Blueprint fields and compute plans](https://render.com/docs/blueprint-spec), [default environment variables](https://render.com/docs/environment-variables).

## Teammate workflow

1. Open the shared URL and sign in with the team's access password.
2. Paste **your own** fal or KIE key. Only configure the provider you use. Keys stay in your browser session's server memory, never in disk storage or localStorage. Other users cannot use or retrieve your keys through the app. The hosting operator controls the server, so this is not end-to-end encryption from the operator.
3. Upload A and B. Set A's end and B's start, then choose a method, duration, frame rate, motion instructions and audio setting.
4. Create the transition. FILM, Kling and Seedance send the two boundary images to your provider. Full clips pass through the app server for FFmpeg assembly. The three methods labelled local run FFmpeg on the hosting server without provider credits.
5. Compare **With transition** and **No bridge - direct cut**, using either short join previews or full video. Download either output, previews or boundary images.
6. Download results before **End my session**. This clears your keys, cancels your work and removes your temporary files. It does not stop the shared server or affect colleagues. **Clear keys** clears keys but does not cancel an already-running request.

The full transition output is retained A -> generated bridge -> retained B. The direct-cut comparison is retained A -> retained B. Dissolve instead overlaps the retained clips. Source audio surrounds silent inserted bridges; dissolve crossfades audio. Endpoint matching does not guarantee matching motion velocity or an invisible join.

## Sessions and limits

- Browser profiles are separate sessions. Tabs in the same profile share one session; use End my session when handing a shared computer to someone else. The team access password remains cached by the browser; ending a session clears application data, not the browser's shared access login.
- Session cookies are HttpOnly, SameSite=Strict and Secure in hosted mode. API mutations also require a session token. Downloads, uploads, jobs, cancellation and history are checked against the session owner.
- Keys expire after 8 hours. Sessions and their files expire after 2 hours without requests when no work is running. Closing a tab alone does not immediately clear server memory. Use End my session to clear it explicitly.
- Sessions are in memory. Restarting or redeploying loses all sessions/results and cancels work. There is no persistent user history. Temporary instance files left by a crash are removed on a later startup once older than 24 hours; normal shutdown cleans its own files immediately.
- Default limits: 10 browser sessions, one render at a time across the server, 512 MB per clip, 1 GB uploaded per session, 8 uploads and 5 render attempts per session. Clips must be self-contained videos, at most 10 minutes and 4096 pixels per side. Download and end a session to start fresh. These are initial small-team limits, not load-tested sizing.
- If another render is running, the app reports that the server is busy; retry later. This initial version has no queue. `MAX_CONCURRENT_JOBS` and `MAX_SESSIONS` can be changed after checking server capacity.
- A render times out after one hour. Uploads time out after ten minutes. Cancellation/timeout stops local processing and provider polling; already submitted cloud work may complete and be billed.
- Refreshing during generation offers **Resume render**. **Open latest completed result** restores only your current session's last completed result. Other users' and earlier desktop results are inaccessible.
- Run exactly one Node process on one hosting instance. In-memory sessions do not support horizontal scaling. For larger deployment, use a job queue and shared session/object storage before scaling.
- No persistent disk is required: results are intentionally temporary. Hosting billing and provider billing are separate.

## Local development

Install Node 22+ and run:

```sh
npm ci
npm start
```

The default binds only to localhost with no team login and opens your browser. Hosted mode requires `STUDIO_HOSTED=true`, `TEAM_PASSWORD` and an HTTPS public origin. The Docker image sets `FFMPEG_PATH` and `FFPROBE_PATH` to OS binaries. Outside Docker the npm dependencies supply platform binaries; native macOS and Linux execution has not been tested here.

The older Windows portable ZIP still works independently, but is not the shared hosted deployment. The desktop Electron project is unchanged. `DESKTOP-REFERENCE.md` preserves prior model research; its desktop launch and saved-key instructions do not apply to this web app.

## Validation and packaging

```sh
npm test
npm run smoke
npm run package:source
```

Validated on Windows and inside the Linux Docker image with a 1 CPU / 2 GB limit: 12 automated tests and all three local-method smoke tests. Tests cover real local FFmpeg output, uploads, comparison downloads and seeking, restored results, separate users, credential selection with a mocked cloud renderer, ownership checks, cancellation, cleanup, expiry and hosted access checks. Provider adapters have payload/error tests. No real API keys or paid generations are used by the tests.

Docker can be built with `docker build -t dealer-transition-team .`. Source packaging runs on Windows with PowerShell or on Unix with the `zip` utility. The source ZIP excludes runtime data, environment files, credentials, dependencies and Windows executables.
