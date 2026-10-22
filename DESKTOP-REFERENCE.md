# Dealer Transition Studio

A Windows desktop workbench for joining two dealer clips with a selectable transition method. Built with Electron, a reusable Node video pipeline, fal's official client and KIE's REST API. No local GPU required.

## Run

Double-click `start.cmd`, or use Node.js 22+:

```powershell
cd C:\Users\chengyuan.li_whitesw\Dev\video-interpolation
npm.cmd ci
npm.cmd start
```

Dependencies include FFmpeg and FFprobe. If Electron asks to finish installing its runtime, run `npx.cmd install-electron --no`. For a portable Windows application folder, run `npm.cmd run package`; the executable is inside `dist/DealerTransitionStudio-win32-x64`.

Select two videos, set the outgoing and incoming cut points, select a method, and click **Create transition**. Each successful render also creates a local **No bridge ? direct cut** comparison using the same selected portions of A and B, with no overlap or inserted footage. Use **Compare versions** to switch, then **Join preview** or **Full video**. **Export** saves the selected version. This comparison makes no extra AI requests. **Open latest completed result** restores your most recent finished render and builds its comparison locally, without another AI generation. Use the video playheads to find similar, low-motion poses. Review the join preview, switch to the full video, then export an MP4. **Show files** opens the render folder, which also contains boundary PNGs, bridge files and `job.json` (including cloud request IDs).

Paste a provider key in the credentials panel, or set `FAL_KEY` / `KIE_API_KEY` before launch. Keys stay in main-process memory by default. To persist them, check **Remember keys on this device** and click **Apply keys**. They are encrypted using Electron safeStorage (Windows DPAPI) in the app user-data directory and restored at startup. Saved keys take precedence over environment variables. **Forget saved keys** removes stored and session keys; configured environment variables remain available. Only the two normalized boundary images are uploaded. Pressing Create with a cloud method submits a paid provider request; the app does not quote prices or retry generation submissions automatically.

## Which method to try

Research checked 22 October 2026. The order below is an engineering recommendation for this use case, not a measured quality ranking on your footage.

| Method | Best use | Main limitation | In this app |
|---|---|---|---|
| FILM | Similar poses, a short missing interval; start around 0.2–0.6 seconds | Occlusion and large pose changes can smear or warp | fal |
| Kling 3.0 Pro first/last frame | A plausible new movement between different poses | Generates content; 3-second minimum | fal and KIE |
| Seedance 2.5 first/last frame | A second generative candidate to compare with Kling | 4-second minimum; no guarantee of exact object continuity | fal |
| Motion-compensated interpolation | Small displacement, offline baseline | Block motion cannot resolve semantic changes | Local FFmpeg |
| Linear frame blend | Very close boundaries, quick baseline | Ghosting/double features | Local |
| Moving-clip dissolve | A short editorial overlap, including sound | Visible dissolve rather than a reconstructed movement | Local |

For your dealer footage, first optimize the cut points: pick nearby poses with similar hand positions and compatible motion directions. Try FILM on a short gap. If the required movement cannot be explained by interpolation, compare Kling and Seedance on the same anchors. Prefer generating a naturally paced bridge over making a 3–4 second generation run in 0.3 seconds. This app retains the chosen duration rather than silently speeding up a minimum-length generation.

First/last conditioning constrains appearance at the endpoints, but does not supply the motion velocity from either adjacent clip. Even a visually good bridge may start or stop abruptly. None of these methods guarantees unchanged fingers, cards, chips, table text, or game state. For production, review both joins at full speed and frame by frame, and include clips with occluded hands in your evaluation. The original footage is re-encoded but is not regenerated outside the bridge.

Other models worth evaluating separately:

- **RIFE** is a practical self-hosted neural interpolation candidate for throughput and short gaps; it needs a separate model runtime and checkpoint deployment. It is not bundled here. [Official implementation](https://github.com/hzwer/ECCV2022-RIFE).
- **MiniMax H3** supports first/last-frame generation and multimodal reference workflows; it belongs on a larger-gap evaluation shortlist. Its reference workflow may help explore motion context, but should not be assumed to enforce both boundary frames at once. Not wired into this build. [Provider overview](https://fal.ai/minimax-h3).
- **Veo 3.1** has a first/last-frame endpoint, but its current fal page announces deprecation on 17 November 2026. I excluded that endpoint from a new integration rather than making it the default. [Endpoint documentation](https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video/api).

## Timing, image and audio behavior

- Bridge methods keep A from zero to the selected end, insert the bridge, then keep B from the selected start. Total length is approximately `A kept + bridge + B kept`, rounded to output frames. Endpoint frames can repeat for a frame at the joins; this is not velocity-conditioned interpolation.
- Dissolve overlaps the moving clips, so total length is `A kept + B kept − dissolve`.
- All sources normalize to a constant selected FPS and clip A's display aspect ratio, capped at 1920 pixels wide. B is letterboxed when necessary. Standard SDR H.264/AAC output; HDR color management is not implemented.
- Source audio is retained, with short edge fades around inserted bridges. Bridges are silent even if the provider returns generated audio. Dissolve uses an audio crossfade. Missing audio gets silence. There is an optional full mute.
- Generative output is resampled to the selected duration and FPS to accommodate provider differences. No guarantee of sample-exact original audio or lossless source video.
- Cancel stops local FFmpeg and polling. fal queue cancellation is best effort; KIE has no cancellation implementation here. Submitted work may still finish and be billed. Check the saved request ID before starting another paid job.
- Renders remain in the app's user-data `renders` directory until manually removed. No automatic retention cleanup. Partial jobs retain intermediates and request IDs.

## Integration and verification

`src/media.js` exports `processVideos(options, {dir, key, signal, log})`. It works independently of Electron. `src/models.js` defines the dropdown, validation and fal payload mapping; `src/providers.js` handles uploads, queue polling, errors and result retrieval. The desktop main process owns file access and credentials; the renderer has a narrow preload bridge, no Node access and no network access.

```js
const { processVideos } = require('./src/media');
const result = await processVideos({
  a: '/absolute/a.mp4', b: '/absolute/b.mp4',
  aEnd: 4.2, bStart: 0.3, method: 'film', duration: 0.4,
  fps: 30, prompt: 'One small continuous movement.', mute: false
}, {
  dir: '/absolute/new-render-directory', key: process.env.FAL_KEY,
  signal: new AbortController().signal, log: console.log
});
console.log(result.output);
```

Use a fresh output directory per job. Production integration should persist job state in your own job system and resume polling by request ID after a process restart. This desktop prototype records IDs but does not resume interrupted jobs automatically. Do not distribute a shared service API key in a packaged desktop app; use per-user keys or a backend proxy.

```powershell
npm.cmd test
npm.cmd run smoke
```

Tests validate adapter inputs and exercise actual FFmpeg processing for all three local methods using clips with different resolutions, frame rates and audio availability. Cloud generation needs a valid funded account and representative dealer footage to validate end-to-end quality; local tests cannot establish model quality.

API references used for the implemented adapters:

- [fal FILM schema](https://fal.ai/models/fal-ai/film/api)
- [fal Kling 3.0 Pro schema](https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api)
- [fal Seedance 2.5 schema](https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api)
- [KIE Kling 3.0](https://docs.kie.ai/market/kling/kling-3-0), [uploads](https://docs.kie.ai/file-upload-api/upload-file-base-64), [job polling](https://docs.kie.ai/market/common/get-task-detail)

The lockfile pins installed dependency versions. Review FFmpeg distribution licensing and model/provider terms before redistributing a commercial build.
