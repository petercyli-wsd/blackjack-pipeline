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

### Clear results without downloading

If **Session render limit reached** blocks another Kling/Seedance render, use **Review & export -> Clear results** and confirm the discard. Refreshing does not reset the server session's five-attempt allowance. Clearing deletes all of your single-pair render files and history, including failed attempts, and resets that allowance. It keeps your uploaded source clips, API keys, and batch checkpoint/results. You can then choose another method and generate. Downloads are optional: save anything you want to keep before confirming. Other users' results are unaffected. Clearing is refused while your session has an active upload or render; wait for it to finish or cancel it first.

For batch ZIPs, use **Discard buffered outputs** to delete only the current part without a download. Those rows become **discarded**, survive refresh with that status, and are not regenerated by Resume or Retry failed rows. Pending rows and files already saved to disk are kept. Provider charges are not refunded. **More batch actions -> Clear batch checkpoint** discards the entire browser queue and all buffered outputs, for starting a different CSV. Both discard operations ask for confirmation because the files cannot be recovered from this app afterward.

## Exact output frame rates

The **Output frame rate (fps)** field accepts `source` (the default: **Match clip A**), an exact fraction such as `24000/1001`, or a decimal with up to six places such as `23.976` or `29.970001`. Rates must be between 1 and 60 fps. Common rates are available in the field's suggestions.

- For camera footage recorded at `24000/1001`, use **source** or enter **24000/1001**. This is approximately 23.976024 fps. The decimal `23.976` is accepted literally as `2997/125`; it is not silently changed to the camera fraction. Three decimal places are practically sufficient for short transitions, but the fraction removes that small discrepancy entirely.
- The full video, join preview and direct-cut comparison all use the selected constant frame rate. The processing log, result details and server-side `job.json` record the resolved rate; the manifest includes `fpsRational`. Match-source reads clip A's video metadata, not an external manifest. In a CSV batch it resolves separately for each row's first clip. Existing queues keep their saved settings; start a new queue to change them.
- FILM/RIFE's provider API accepts integer container FPS. We request the required number of frames, verify the returned count, then assign each frame a timestamp at the exact output rate. This retimes those frames without dropping them merely because the provider encoded at 24 or 30 fps. Both boundary frames remain included in the bridge, as before. Other generative models' native frame counts may require frame duplication or removal during assembly.
- Durations must fit whole frames: a 0.3-second FILM/RIFE bridge at `24000/1001` becomes 7 frames, approximately 0.291958 seconds. FILM/RIFE need at least 3 frames (two endpoints plus one intermediate). The manifest records the actual bridge frame count and duration. Dissolve overlaps existing footage instead of inserting a bridge.
- Original clips are still re-encoded. Matching their constant rate avoids frame-rate conversion; selecting a different rate resamples them. If B's rate differs from A's, B is converted to the selected rate. Variable-frame-rate input is converted to constant frame rate using A's reported average when `source` is selected. This does not guarantee an invisible join or eliminate model artifacts.

## CSV batch processing

Use **CSV batch** to process up to **10,000 pairs** with one method/settings combination. Each successful row produces **the entire first video -> bridge -> entire second video**, named by the third CSV column. Batch mode uses A's natural end and B's natural start; it ignores the single-pair playhead cuts. Dissolve instead overlaps A and B by the chosen duration. The existing normalization/audio rules still apply; source files are not edited. Batch mode exports the combined MP4 only, skipping the preview and direct-cut comparison encodes to reduce processing time. Single-pair mode still includes those comparisons.

This is a sequential, browser-controlled queue with local checkpoints, not an unattended cloud worker. Only the current pair uploads. Once its output is safely written to the selected folder or checkpointed for ZIP export, its server uploads, render files and job record are deleted. Batch rows do not exhaust the single-pair 8-upload/5-render limits. The server-wide concurrency limit still applies; batches wait when a colleague is rendering. There is no fairness guarantee between users.

### Step-by-step batch instructions

1. Put all source clips under **one common source folder**, including subfolders. For sources on different drives, first copy them into one common folder. Prepare the CSV as specified below. Run a small pilot before a large batch and inspect both joins.
2. Open the shared app URL, enter **your own** provider key, and select **CSV batch** beside **Single clip pair**.
3. In **Build the transition**, choose FILM, RIFE, Kling, Seedance, or a local method; set duration, frame rate, prompt where relevant, and audio. Settings are fixed when the batch first starts. Resuming uses those saved settings, even if you change the single-pair controls. Clear the checkpoint and load a new batch to use different settings.
4. If your CSV uses absolute paths, fill in **Source root in CSV** and, if needed, **Output root in CSV**. Leave both blank for relative paths. Then **Select source folder** using the browser's folder picker. Choosing the folder grants browser read access; entering a path alone cannot do that. The browser does not reveal its absolute location, so you supply the matching root text yourself.
5. **Upload CSV**, then **Validate / match files**. Check the counts and paginated error table. Missing sources, extra columns, duplicate output names and invalid paths are skipped, without a provider request. You can reselect the correct source folder and validate again to fix missing-file rows. Source size/modification time is checked against the earlier selection on resume; deliberately replaced sources require a new batch.
6. Choose a destination:
   - **Save directly to a folder**: recommended for large batches in a supporting desktop browser, normally Chrome/Edge on Windows/macOS/Linux. Click **Choose output folder** and grant write permission. Use a dedicated empty output folder. Each completed MP4 streams directly to it, with CSV subfolders created underneath. Existing files are never overwritten; an existing filename pauses saving so you can move it aside and resume, without another generation. Safari/Firefox users can use ZIP mode. Availability is detected in the app; directory writing requires HTTPS or localhost.
   - **ZIP parts**: works without direct folder-write support. Outputs are buffered in this browser's IndexedDB, not accumulated on the Render server. The queue pauses at **20 files or approximately 250 MB**. Click **Download ZIP part**, verify the download finished and opens correctly, then **ZIP saved: clear part**, and resume. Repeat, including the final part. Extract all parts into one local folder to collect the outputs together. A single output can exceed the 250 MB target, up to **512 MB**; larger individual outputs require folder mode. ZIPs store already-compressed MP4s without recompressing them and include a row report. Browser disk quotas can cause an earlier pause.
7. **Plan your batch** shows estimated remaining time and provider cost as soon as the CSV loads, before any upload or paid request. Changing method/duration updates it until settings lock at first start. Expand **Estimate assumptions & overrides** for the basis and an optional cost-per-row override in USD or credits. The defaults are rough planning assumptions, not a quote, measured benchmark, balance check or spending cap. See the estimate table below.
8. Click **Start / resume batch**. Keep this tab open and the computer awake. **Pause after this row** appears while running and finishes/saves that row. **More batch actions -> Cancel current row & pause** stops the current upload/local work and provider polling; submitted cloud jobs may still finish and be billed. Remaining rows stay pending. Generic row failures are recorded and skipped. Recognized provider authentication, billing or rate-limit errors pause for attention instead of sending the rest with the same problem.
9. ZIP download/confirmation/discard controls appear only when there are buffered files. For continuous saving without confirming every 20 outputs, download/check/confirm the existing ZIP, change the destination to **Save directly to a folder**, choose an output folder, then resume. Keep the tab online and awake; folder mode removes ZIP pauses, not browser/server interruptions.
10. Expand **More batch actions** for the **row report**, retry/skip tools and **Clear batch checkpoint**. Reports list errors, timings, provider request IDs and ZIP part numbers. **Retry failed / interrupted rows** can charge again; check the provider dashboard first. **Skip interrupted rows** leaves them out and lets the remaining queue proceed. Completed/discarded rows are not regenerated. Invalid rows can be revalidated; syntactically broken CSV quoting requires correcting and reimporting the file. Save any outputs/report you want to keep before clearing the checkpoint.

Source folder selection enumerates files; it does **not** upload the entire folder. Matching uses the full relative path, never just the basename. File content is not hashed; size/modification time checks detect common accidental changes, not all changes. One browser profile can hold one batch checkpoint per app origin. A cross-tab lock prevents concurrent batch actions, and a second tab reloads current checkpoint state before running. Single-pair renders cannot take over a batch's active server workspace. Finish/save or explicitly skip/reset a paused row before returning to single-pair processing.

### Upfront estimate assumptions

These are **planning ranges, not limits or guaranteed prices**. Actual totals can fall outside them. Estimates count unfinished rows, including invalid/failed rows if you fix and retry them; saved, buffered, skipped and discarded rows are excluded. They do not include past charges, extra retries, taxes or hosting. No provider request or balance lookup is made to calculate estimates.

| Method | Default provider cost assumption | Speculative time per row before starting |
| --- | --- | --- |
| FILM | $0.005–$0.05 per short HD bridge; **unverified budget allowance** | 30–120 seconds |
| RIFE | $0.003–$0.03 per short HD bridge; **unverified budget allowance** | 20–90 seconds |
| Kling 3.0 Pro / fal, audio off | $0.112–$0.14 per generated second | 2–10 minutes |
| Kling 3.0 Pro / KIE, audio off | $0.09 per generated second, before discounts | 2–10 minutes |
| Seedance 2.5 / fal, 720p | About $0.46224 per generated second at 1280×720, with a ±25% planning allowance for aspect ratio | 2–15 minutes |
| Local motion interpolation | $0 provider charge | 30–300 seconds |
| Local blend / dissolve | $0 provider charge | 15–120 seconds |

Time assumes short HD inputs and sequential processing. Before measurements, these ranges scale up for bridges longer than 0.4 seconds (interpolation/local) or 5 seconds (generative). After successful rows, the app uses 75%–150% of the mean of the last ten saved/buffered row times. Source duration/resolution, uploads, provider queues, server load, pauses and sleep can dominate runtime; the initial ranges are deliberately speculative. FILM/RIFE cost allowances are also speculative: they are not inferred from video seconds or a verified tariff, and longer bridges/more frames/larger images may cost more. Override them using your account's pilot billing when available.

Pricing references checked **24 October 2026**: fal's [image-to-video catalogue](https://fal.ai/explore/image-to-video-apis) lists Kling Pro without audio at $0.112/second, while its [general pricing table](https://fal.ai/pricing) lists $0.14/second; the app spans both figures. [KIE Kling pricing](https://kie.ai/kling-3-0) lists Pro without audio at 18 credits/$0.09 per second. fal's [Seedance workflow/pricing guide](https://fal.ai/learn/tools/seedance-2-5-workflows) describes $0.0214 per 1,000 tokens and `(width × height × duration × 24) / 1024` output tokens; the app derives the 16:9 baseline from that formula. Native provider FPS, not the chosen export FPS, is used for this Seedance estimate. These values are stored in `public/batch-estimates.js`; they are not live pricing and should be rechecked before budgeting a large run. User cost overrides replace the automatic cloud allowance; local methods always show zero provider cost.

### CSV specification for people and CSV-generating agents

**Format:** UTF-8 CSV (BOM optional), comma-delimited, exactly three columns per data row in this order:

| Column | Meaning |
| --- | --- |
| `first_half` | Local path to the first video; its full length is retained. |
| `second_half` | Local path to the second video; its full length is retained. |
| `output` | Desired combined MP4 path/name, relative to the output destination, or absolute beneath the configured output root. |

- The recommended header is exactly `first_half,second_half,output`. It is optional and recognized case-insensitively. Do not invent other column labels or add columns for settings. Row numbers in the app count nonempty data records, excluding the recognized header; they are not physical line numbers.
- Maximum **10,000 data rows / 20 MB CSV**. CRLF and LF line endings work. Empty rows are ignored. Leading/trailing whitespace in fields is trimmed. Do not use filenames that require surrounding whitespace.
- Use ordinary CSV quoting: quote a field containing a comma; write a literal quote as `""` inside a quoted field. Backslashes are literal path separators, **not JSON escape sequences**. `/` and `\` separators are accepted. There is no environment-variable (`%USERPROFILE%`, `$HOME`), `~`, wildcard or URL expansion.
- **Relative source paths are relative to the selected source folder**, excluding that folder's own name. For example, selecting `C:\Videos` makes `dealer-01/a.mp4` refer to `C:\Videos\dealer-01\a.mp4`, not `C:\Videos\Videos\dealer-01\a.mp4`. Matching is exact; Windows absolute-root mappings additionally permit unambiguous case-insensitive file matching. Prefer exact case everywhere for portability.
- Absolute inputs must all be under the **Source root in CSV** with a complete directory-prefix match. Example: root `C:\Videos` accepts `C:\Videos\a.mp4` but rejects `C:\VideosOther\a.mp4`. POSIX root matching is case-sensitive. Windows drive/UNC roots are recognized. The selected folder must correspond to that textual root; the browser cannot verify the original absolute location.
- Outputs must end in `.mp4`. Relative subfolders are supported. Absolute outputs must be beneath **Output root in CSV**; that prefix is removed. The selected output folder, or the extracted ZIP root, is the actual destination. A CSV cannot force the browser to write to an arbitrary absolute computer path. For `D:\Results\dealer-01\joined.mp4` with root `D:\Results`, select `D:\Results` as the destination folder to reproduce that exact location, or choose another destination to relocate the same relative layout.
- No `.`/`..` path components, empty path components, control characters, paths outside either root, or duplicate outputs. Output collision checks are case-insensitive across the whole batch. Output names must also be safe on Windows: no `< > : " | ? *`, trailing dot/space, or reserved names such as `CON.mp4`. Use unique filenames. Invalid rows are skipped rather than silently renamed. Incorrect column counts are row errors; malformed CSV quoting rejects the entire CSV because row boundaries cannot be trusted.
- There are no per-row cuts, methods or prompts in this version. Use a separate batch for another settings combination. The report CSV has additional status columns and is **not** directly importable; extract its first three columns for a new input CSV. Formula-like report cells are prefixed with an apostrophe for spreadsheet safety; account for that if generating a retry CSV from a report.

**Recommended portable example:** select a folder containing `dealer-01` and `dealer-02`; leave root text fields blank.

```csv
first_half,second_half,output
dealer-01/first.mp4,dealer-01/second.mp4,dealer-01/combined.mp4
"dealer-02/take, first.mp4",dealer-02/second.mp4,dealer-02/combined.mp4
```

**Windows absolute example:** Source root `C:\CasinoClips`, Output root `D:\BridgeResults`; select `C:\CasinoClips` for reading and `D:\BridgeResults` for writing (or choose ZIP).

```csv
first_half,second_half,output
C:\CasinoClips\dealer-01\first.mp4,C:\CasinoClips\dealer-01\second.mp4,D:\BridgeResults\dealer-01\combined.mp4
```

**macOS/Linux absolute example:** Source root `/home/alex/clips`, Output root `/home/alex/results`. On macOS, use your actual `/Users/alex/...` paths instead.

```csv
first_half,second_half,output
/home/alex/clips/first.mp4,/home/alex/clips/second.mp4,/home/alex/results/combined.mp4
```

The UI's **Download example CSV** provides a portable template. If you ask another agent to generate CSVs, give it this specification, the actual common source root, the desired output root/layout, and a list of existing file paths; it should pair the correct halves and ensure unique output names.

### Persistence, recovery and free-hosting limits

- Queue rows, settings, statuses, errors, known provider request IDs and ZIP buffers are stored in **IndexedDB in this browser profile for this site**. Source videos, API keys and the team password are not stored in that checkpoint. Local paths/filenames and generated videos can be sensitive: **End my session clears server data only**. Use **Clear batch checkpoint** to remove browser batch data when finished or before handing the computer to someone else. Clearing site storage, private browsing expiry or browser storage eviction can also remove checkpoints/buffers. They are not a backup; save ZIPs/reports promptly.
- Reloading restores the queue but never automatically starts paid work. Reselect source/output folders, enter keys if needed, and click Resume. If the same server job still exists, the client reconnects. If a result is complete but saving failed, it retries saving the same result. Duplicate process submissions for the **same row in the same server workspace** return the original job ID instead of submitting again.
- After a server restart, redeploy, idle-session expiry, or End my session, an in-flight submitted row may be marked **uncertain**. Check its provider request in the dashboard and any already-saved local file before explicitly retrying or skipping. A network failure during provider submission can leave a billable request without a known request ID; check provider history by time as well. This implementation does not automatically recover remote cloud output after server state is lost and does not promise exactly-once billing across crashes. Saved outputs and browser checkpoints survive a normal server restart; the current server job/files do not.
- Closing the tab stops queue progression. The current server job may continue, but no further rows are submitted while the browser is closed. Keys expire after eight hours; re-enter them when prompted. Automatic retries are limited to waiting for the shared server's capacity before submission; failed generation is never automatically resubmitted.
- Each row keeps the same 512 MB/source, 10-minute/source, 4096-pixel/source and one-hour render limits. Only two source files plus current intermediates/results occupy the batch server workspace, but a large single row can still exceed free-server memory/disk/CPU capacity. Thousands of metadata rows are supported; thousands of production renders have **not** been load-tested on Render Free.
- Free Render can restart or lose files and has transfer/usage limits. This implementation adds **no paid worker, database or persistent disk**. It is useful for pilots and supervised queues; guaranteed unattended bulk production needs durable job/storage infrastructure and a separate hosting decision. Running the included web server locally is another way to use your own machine's resources without adding paid hosting.

Browser references: [folder input and relative paths](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory), [directory-write picker availability](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker). Hosting reference: [Render Free limits and ephemeral files](https://render.com/docs/free).

## RIFE and method selection

The method dropdown groups frame interpolation (FILM and RIFE), generative bridges, and methods that need no provider credits. **RIFE uses your fal key** via `fal-ai/rife`, takes the two boundary images and requests a video including both endpoints. It supports 0.1-2 second bridges in this app and needs no text prompt. The result still goes between retained A and retained B, with the direct-cut comparison available as before.

The integration follows the [fal RIFE API schema](https://fal.ai/models/fal-ai/rife/api). No documented RIFE endpoint was found in KIE's public catalogue when this integration was added, so there is no KIE RIFE option. KIE's existing Kling method remains available. Tests mock RIFE requests; no paid RIFE generation was performed.

### Empty response or disconnected render

An `Unexpected end of JSON input` error from the browser does not by itself mean a bad fal key or unsupported RIFE model. It can mean the app received an empty/truncated response from its server or a gateway. The app now reports the operation and HTTP status, retries interrupted **read-only** status requests twice, and offers **Reconnect to render** if the connection still fails. Reconnection polls the existing job; it does not submit another generation. If the submission response itself was lost, a client request reference looks up that exact job, including when it has already finished. If the server/session was lost, check provider history before creating another paid request.

If this persists, expand **Processing log** and inspect Render's logs/events at the same time for a restart, memory-limit event, or terminated FFmpeg process. Provider permission errors remain explicit errors with their stage/HTTP status. The hosted Docker build sets `FFMPEG_THREADS=1` for decoder, encoder and filter pools to reduce resource use; it does not change resolution/frame rate. This reduces memory pressure but cannot guarantee a large render fits Free hosting. Local runs keep FFmpeg defaults unless you set `FFMPEG_THREADS` (1–16). A child process killed by the host now reports termination instead of being mistaken for an empty successful output.

Credentials stay visible at the top with compact buttons. Longer privacy/limit details are expandable. The selected method shows which key it needs; Create transition becomes available once both clips and the relevant key are present (including a key pasted but not yet applied).

### Kling/Seedance prompts and card continuity

The default movement prompt now explicitly asks for persistent cards/chips, fixed positions for untouched cards, continuous hand-controlled motion, consistent grips/shadows, and cards remaining present behind fingers during occlusion. It also constrains extra gestures, camera movement, fading, duplication and last-frame snapping. **Restore card-preserving prompt** replaces the text with this default; switching models keeps your custom text. Previously started batches keep their locked prompt, so a new default does not silently change the rest of a batch.

Add a short action specific to your two frames, for example: “Only the dealer's right hand slides the face-down card toward seat three, keeping contact with the felt; all other cards stay fixed.” Use that instruction only when it matches both endpoints. Specify which card/hand moves, where it ends, and which objects must stay still. Avoid asking for a new deal/shuffle when only a pose adjustment is needed. The prompt cannot guarantee perfect realism, recover an unseen card identity, or enforce physical object tracking. Inspect the entire bridge and both joins; for similar poses, compare FILM/RIFE, which also can warp cards or fingers. No paid generation or visual quality improvement has been verified for the revised prompt.

## Sessions and limits

- Browser profiles are separate sessions. Tabs in the same profile share one session; use End my session when handing a shared computer to someone else. The team access password remains cached by the browser; ending a session clears application data, not the browser's shared access login.
- Session cookies are HttpOnly, SameSite=Strict and Secure in hosted mode. API mutations also require a session token. Downloads, uploads, jobs, cancellation and history are checked against the session owner.
- Keys expire after 8 hours. Sessions and their files expire after 2 hours without requests when no work is running. Closing a tab alone does not immediately clear server memory. Use End my session to clear it explicitly.
- Server sessions are in memory. Restarting or redeploying loses server sessions/results and cancels work. Browser batch checkpoints and saved ZIP buffers are separate, as described above. Temporary instance files left by a crash are removed on a later startup once older than 24 hours; normal shutdown cleans its own files immediately.
- Default limits: 10 browser sessions, one render at a time across the server, 512 MB per clip. Single-pair mode allows 1 GB uploaded, 8 uploads and 5 render attempts between result clearings; **Clear results** removes old renders and resets the render allowance, but not the upload limit. Batch mode has a separate 1 GB/two-input workspace recycled after each saved row, without the single-pair render-count limit. Clips must be self-contained videos, at most 10 minutes and 4096 pixels per side. These are initial small-team limits, not load-tested sizing.
- If another render is running, single-pair mode reports that the server is busy; retry later. CSV batch mode waits for capacity. `MAX_CONCURRENT_JOBS` and `MAX_SESSIONS` can be changed after checking server capacity.
- A render times out after one hour. Uploads time out after ten minutes. Cancellation/timeout stops local processing and provider polling; already submitted cloud work may complete and be billed.
- Refreshing during generation offers **Reconnect to render**. **Open latest completed result** restores only your current session's last completed result. Other users' and earlier desktop results are inaccessible.
- Run exactly one Node process on one hosting instance. In-memory sessions do not support horizontal scaling. For larger deployment, use a job queue and shared session/object storage before scaling.
- No persistent disk is required: results are intentionally temporary. Free hosting does not make fal/KIE generations free; each person uses their own provider credits.

## Local development

Install a current Node LTS release and run (the DOM test dependency requires Node 22.22.2+ on the 22.x line, or 24.15.0+ on the 24.x line):

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

The original pipeline passed 12 tests and all three local-method smoke tests inside the Linux image with a 1 CPU / 2 GB limit. The Windows suite also covers CSV validation at 10,000 rows, ZIP records, bounded batch workspace cleanup, full-video batch assembly, duplicate-submission protection, provider request tracking, and user isolation. DOM/IndexedDB integration tests exercise ZIP rollover, refresh/resume, output-file collision handling, browser storage failure, lost submission responses, uncertain jobs, cross-tab locking, pause/cancel and provider-permission failures. These simulate browser APIs; native folder permissions and visual layout have not been verified in a real browser because browser automation was unavailable. Existing tests cover local FFmpeg output, comparison downloads/seeking, session expiry, hosted access, RIFE adapters and credential isolation. No real API keys or paid generations are used by the tests. Development-only test dependencies are omitted from the production Docker image.

Result-clearing tests exhaust the render allowance (including a failed attempt), refuse clearing an active render, and verify a new Seedance request can run afterward while uploads, keys, a completed batch result and another user's media remain intact. Browser tests cover discard confirmation, persistence across reload, no regeneration of discarded rows, transactional recovery when clearing storage fails, and estimates appearing before any job starts, including delayed server initialization.

Docker can be built with `docker build -t dealer-transition-team .`. Source packaging runs on Windows with PowerShell or on Unix with the `zip` utility. The source ZIP excludes runtime data, environment files, credentials, dependencies and Windows executables.
