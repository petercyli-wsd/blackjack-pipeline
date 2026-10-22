# Dealer Transition Studio - team web app

One hosted URL for teammates on Windows, macOS and Linux. Teammates need only a browser and their own funded fal/KIE account for cloud methods. Provider keys are never included in the source or deployment. Hosting must use the Free plan with no paid resources. Each user still pays their own fal/KIE generation costs; the three FFmpeg methods have no provider charge.

## Deploy to Render for free (no Blueprint required)

This folder is the source root. The app is a Node/FFmpeg web service. Use Render's manual Web Service creation; no Blueprint setup is required. The optional `render.yaml` also explicitly specifies `plan: free`. Do not use older deployment ZIPs that selected `1c-2g`.

1. Put this folder's source into a private GitHub/GitLab repository. Keep `.gitignore` and `.dockerignore`. Do not upload `node_modules`, `dist`, `data`, `output`, `.env`, videos or keys. The latest `npm run package:source` ZIP contains only the intended source files.
2. In Render select **New -> Web Service**, connect the repository, and select **Docker** as the language/runtime. If the repository contains this project inside a subfolder, set that folder as Root Directory. Use the included `Dockerfile`; leave Docker Command empty.
3. Select **Free** as the instance type. Use the default `onrender.com` address. Do not add a paid database, disk, worker, workspace upgrade or compute upgrade. To avoid usage-overage billing, use a workspace with no payment method; Render documents suspension/build disabling instead of charging overages in that case. If the account requires a card or any payment, stop the deployment rather than accepting it. For an existing billed workspace, `plan: free` alone is not a guarantee of zero total charges.
4. Add these environment variables in the service settings:

   | Variable | Value |
   | --- | --- |
   | `STUDIO_HOSTED` | `true` |
   | `TEAM_PASSWORD` | A new random password of at least 16 characters, shared privately with teammates |
   | `MAX_CONCURRENT_JOBS` | `1` |
   | `MAX_SESSIONS` | `10` |

   Do not add fal/KIE keys here. Set Health Check Path to `/health`, and disable automatic deploys so code pushes do not interrupt sessions. The Dockerfile already supplies the port and FFmpeg paths.
5. Create the Free web service. Render builds the Linux image. Open its HTTPS URL; the browser login username is **team**, with the password you set above. Share this URL/password privately. Teammates enter their own provider keys inside the app.
6. Test a short **Linear frame blend** first, then a cloud method using the tester's own credits. Review both joins in the full download. The Linux image passed tests at 1 CPU / 2 GB; this does not establish performance on Render Free. The smaller free instance may be slow or run out of memory for large clips. No paid upgrade is authorized as a fallback.

### Free-tier behavior

Render sleeps free services after 15 idle minutes and may take about a minute to wake them. Sleep, restart and redeploy clear the app's sessions and temporary files. Download results promptly. Keep the page open while processing so normal job-status polling continues; this is not a keep-alive service after work finishes.

The workspace has monthly free-hour, outbound-bandwidth and build limits. Video downloads consume bandwidth, and unusual outbound API/file traffic can also cause suspension. This is a limited trial/team-preview hosting option, not guaranteed unlimited video processing. No persistent disk or database is needed.

The server reads Render's `RENDER_EXTERNAL_URL`. For another host, set `PUBLIC_ORIGIN` to its exact HTTPS origin. Hosted mode refuses to start without an HTTPS origin and a team password of at least 16 characters. The hosting operator controls the server and can access server memory; keys are isolated between app users, not hidden from the operator.

Official references: [Free service setup, limits and overage behavior](https://render.com/docs/free), [Docker deployment](https://render.com/docs/docker), [optional Blueprint configuration](https://render.com/docs/blueprint-spec).

## Teammate workflow

1. Open the shared URL and sign in with the team's access password.
2. Paste **your own** fal or KIE key. Only configure the provider you use. Keys stay in your browser session's server memory, never in disk storage or localStorage. Other users cannot use or retrieve your keys through the app. The hosting operator controls the server, so this is not end-to-end encryption from the operator.
3. Upload A and B. Set A's end and B's start, then choose a method, duration, frame rate, motion instructions and audio setting.
4. Create the transition. FILM, RIFE, Kling and Seedance send the two boundary images to your provider. Full clips pass through the app server for FFmpeg assembly. The three methods labelled local run FFmpeg on the hosting server without provider credits.
5. Compare **With transition** and **No bridge - direct cut**, using either short join previews or full video. Download either output, previews or boundary images.
6. Download results before **End my session**. This clears your keys, cancels your work and removes your temporary files. It does not stop the shared server or affect colleagues. **Clear keys** clears keys but does not cancel an already-running request.

The full transition output is retained A -> generated bridge -> retained B. The direct-cut comparison is retained A -> retained B. Dissolve instead overlaps the retained clips. Source audio surrounds silent inserted bridges; dissolve crossfades audio. Endpoint matching does not guarantee matching motion velocity or an invisible join.

## RIFE and method selection

The method dropdown groups frame interpolation (FILM and RIFE), generative bridges, and methods that need no provider credits. **RIFE uses your fal key** via `fal-ai/rife`, takes the two boundary images and requests a video including both endpoints. It supports 0.1-2 second bridges in this app and needs no text prompt. The result still goes between retained A and retained B, with the direct-cut comparison available as before.

The integration follows the [fal RIFE API schema](https://fal.ai/models/fal-ai/rife/api). No documented RIFE endpoint was found in KIE's public catalogue when this integration was added, so there is no KIE RIFE option. KIE's existing Kling method remains available. Tests mock RIFE requests; no paid RIFE generation was performed.

Credentials stay visible at the top with compact buttons. Longer privacy/limit details are expandable. The selected method shows which key it needs; Create transition becomes available once both clips and the relevant key are present (including a key pasted but not yet applied).

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
- No persistent disk is required: results are intentionally temporary. Free hosting does not make fal/KIE generations free; each person uses their own provider credits.

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

The original pipeline passed 12 tests and all three local-method smoke tests inside the Linux image with a 1 CPU / 2 GB limit. The current Windows suite passes 15 tests, including Render startup and RIFE validation/adapter coverage. The latest UI changes have not been visually verified because browser automation was unavailable. Tests cover real local FFmpeg output, uploads, comparison downloads and seeking, restored results, separate users, credential selection with a mocked cloud renderer, ownership checks, cancellation, cleanup, expiry and hosted access checks. Provider adapters have payload/error tests. No real API keys or paid generations are used by the tests.

Docker can be built with `docker build -t dealer-transition-team .`. Source packaging runs on Windows with PowerShell or on Unix with the `zip` utility. The source ZIP excludes runtime data, environment files, credentials, dependencies and Windows executables.
