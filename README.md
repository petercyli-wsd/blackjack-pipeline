# Blackjack Pipeline

Dealer footage in, playable blackjack table out. Add one dealer take and the server does the rest. It cuts the take into the game's clips, generates the transitions between clips that weren't filmed back to back, and builds the game with everything inserted. You then play it in your browser or download it.

The app has two tabs:

| Tab | What it's for |
|---|---|
| **Pipelines** | Full runs from a take to a game: **3-seat blackjack** (live) and **7-seat blackjack** (disabled until it's produced). |
| **Transition Studio** | The original interpolation app, unchanged: single clip pairs, CSV batches, AI review and repairs. See [docs/STUDIO.md](docs/STUDIO.md). |

```
take.mp4 ─▶ 1 Set up ─▶ 2 Clips ─▶ 3 Scene masks ─▶ 4 Dealer mattes ─▶ 5 Transitions ─▶ 6 Game ─▶ ▶ play / ⬇ download
            game code    cut, track    optional,        optional, paid     FILM/Kling,       build the
            + tools      cards, plan   free             (RunningHub)       asks before        table
                         transitions                                       spending
```

## Run it on this computer

You need **Node.js 22+**, **[uv](https://docs.astral.sh/uv/getting-started/installation/)** and **Git**, plus the [3-seat-blackjack](https://github.com/petercyli-wsd/3-seat-blackjack) repo next to this one (`../3-seat-blackjack`).

```sh
npm ci
npm start                     # http://127.0.0.1:5199, opens your browser
```

On Windows you can double-click **`Start Blackjack Pipeline.vbs`** instead. It starts the server in the background with no window, logs to `data/server.log`, and opens the page. Starting it again just opens the copy that's already running. Use **Stop local app** in the page to stop it.

The first run installs the game's Python tools (OpenCV, PyTorch and SAM 2) and Node packages, which takes a few minutes. Later runs reuse them.

## Using it

1. **Pipelines › + New run.** Drop in the take, or paste the path to a file on this computer. It's checked straight away against what the pipeline needs. For 3-seat, that's 1440×810 at 23.976 fps, 2–60 minutes, and a decodable file at both ends. A take that doesn't fit is refused with what's wrong and how to fix it. Nothing runs, and nothing is charged.
2. **Choose the options** (the defaults are sensible):
   - **Game code:** your local folder, *including uncommitted changes*, or a GitHub branch or commit.
   - **Optional stages:** Scene masks (on), Dealer mattes (off, paid).
   - **AI review:** generative rows only (default), all rows, or off.
   - **Parallel generation:** how many transitions generate at once.
   - **Auto-approve up to $X:** blank means ask first.
   - **Pause before building:** if you want to review the transitions first.
3. **Start run.** You can close the tab now. The run continues on the server and is saved at every step.

Each stage shows its steps, live log, elapsed time and (after the first run) typical duration. When a run needs you it's marked **Needs you**, with a banner that says what happened and offers the actions you need right there:

| Banner | What it offers |
|---|---|
| **Approve spending** | The estimate per method, then **Approve & generate**, or **Skip: use free stand-ins**. |
| **Add a key** | A key field right in the banner. Generation starts as soon as the key is added. |
| **Some transitions failed** | **Retry them**, **Continue without them** (stand-ins play), or **See them**. |
| **A stage stopped** | A plain-language reason, how to fix it, the tool's own error, then **Retry this stage**, **Redo…**, or **Open log**. |

You can turn on desktop alerts in the runs list.

### Run actions

- **Pause / Resume.** A command stage stops at once; its unfinished step is redone on resume and finished steps are reused. Transitions pause after the ones in progress finish (**Stop now** stops them too).
- **Redo… (per stage).** Wipes that stage, or the stage from a chosen step, plus every later stage, then runs again. The dialog lists exactly what is deleted and what is kept. Paid transitions whose clips come out the same are reused for free; tick **Regenerate them all anyway** to pay for fresh ones.
- **More › Update game code.** Copies your latest game code (and this app's latest pipeline definition) into the run without deleting anything. Then redo the stage your change affects. For a game-code-only change, redo **Game**.
- **More › Start over.** Keeps the take and redoes everything.
- **More › Delete run.** Removes all of the run's files. Its paid transitions stay in the library.
- **Transitions table.** Filter by flagged, failed, running and so on. **Watch** any transition (the clip it leaves, the move, the clip it lands in; at 1×, 0.5× or 0.25×). You can then **Reject** it so a stand-in plays, accept it again, **Regenerate** it, or **Retry** a failed one. Changing a transition marks the game for a rebuild, so make all your changes and rebuild once.
- **Game.** **▶ Play the game** serves the build on its own localhost port in a new tab. **Download game (ZIP)** gives you a static site you can host anywhere, such as Vercel or Render. **Download clips only** gives you the `game_assets` folder.

### What it guarantees

- **Runs keep going with the browser closed.** They also resume by themselves after the server restarts or crashes, from the last finished step.
- **A step interrupted halfway is redone from scratch.** Its partial output is deleted, so the game's own caching can't trust a half-written file.
- **Nothing is paid for twice.** Each transition is checkpointed. After a restart, the server reconnects to provider requests that were still in flight instead of submitting new ones. Every finished transition is also filed in a library under a fingerprint of what it was made from (both clips' bytes, method, length, prompt). A redo of an earlier stage, or a new run of the same take, reuses every transition whose clips come out identical, so only changed ones are charged. Regenerating a transition, or rejecting it, removes it from the library.
- **Provider hiccups don't stop the run.** A provider server error (HTTP 5xx) or a dropped connection is retried by itself, twice at most, reconnecting to the request if it was already submitted. Only a transition that keeps failing is reported. A rejected key, empty credits or rate limiting pauses generation instead.
- **No orphaned processes.** Every stage process runs under a watchdog, so it can't outlive a crashed server. Only one server can own the data folder at a time.
- **Your game repo is never written to.** Each run works on its own copy under `data/pipeline/runs/<id>/game/`.
- **Keys stay in memory only.** They're never written to disk, and they expire after 8 hours. For unattended runs that should survive restarts, set `FAL_KEY`, `KIE_API_KEY` or `RUNNINGHUB_API_KEY` in the server's environment instead.

## Changing how the game is built

The game and the way its clips are cut will keep changing, so this app holds no 3-seat knowledge in code. Each pipeline is a JSON definition in [`pipelines/`](pipelines/). It's the whole contract with a game repo: where the code lives, what a valid take is, and each stage's command, outputs and checks. To change the method, change the definition (or the game's own pipeline). No app code changes are needed.

**The game repo can own its contract.** If the game repo contains `blackjack-pipeline.json`, it replaces the definition's `stages` and `toolchains`. That way the stages change in the same commit as the code that implements them. Paths, the input rules and the repo location stay with this app, so a contract can't widen what a run may read or delete. The run header shows *game contract* when one is in use.

### Definition reference

| Field | Meaning |
|---|---|
| `enabled`, `disabledReason` | `false` shows the pipeline as *Coming soon* with this reason (that's how **7-seat** is set up). |
| `game.localPath`, `game.repo`, `game.ref` | Where the game code comes from: a local folder (default, including uncommitted files) or a GitHub repo and branch. |
| `game.exclude` | Folders not copied into a run, such as its outputs and dependencies. |
| `game.carry` | Files reused from your game folder if present, such as studio sets or SAM weights. |
| `input` | `width`, `height`, `fps` (exact fraction), `minSeconds`, `maxSeconds`, `maxBytes`, and `opencvCheck` (also open the take with the game's OpenCV). |
| `toolchains.python` | `dir`, `lock` files and `extras`. Installed with `uv sync --frozen`, once per lockfile, and shared by runs. Extras the game doesn't declare are skipped. |
| `toolchains.node` | `dir` and `lock` files. Installed with `npm ci` once per lockfile and linked into each run. |
| `stages[].kind` | `command` runs a process in the run's copy of the game. `transitions` is the built-in generation stage. |
| `stages[].run`, `cwd`, `env` | The command, which can use `{python}`, `{npm}`, `{node}`, `{input}`, `{workspace}` and `{run}`. Keys only go through `env` (`"{key:runninghub}"`). |
| `stages[].markers` | Patterns for `start`, `done` and `cached` lines that drive the step list. bj3 prints `[run ] name`, `[done] name` and `[skip] name`. |
| `stages[].steps[]` | `id`, `title`, `detail`, and the `outputs` deleted when that step is redone or was interrupted. `gallery` shows images, such as contact sheets. |
| `stages[].outputs` | Everything else the stage writes. It's deleted on redo. |
| `stages[].verify` | Checks after the stage. `{"exists": path}`, or `{"json": path, "field", "requireKeys"}` (for example, every clip the game needs). |
| `stages[].errorHints` | Regex `match` → plain `message` (`$1`…) and `fix`, shown instead of a raw exit code. |
| `stages[].optional`, `default`, `keys` | Optional stages can be toggled per run. `keys` makes the stage wait for those keys. |
| `stages[].onReset` | Commands run after a redo of this stage (for example, re-resolving which bridges play). |
| `stages[].artifacts` | `site` (playable build) and `assets` (clips only), offered for play and download. |

**Transitions stage.** The game writes its plan as a CSV in the Studio's batch format (`first_half,second_half,output,method,duration`; see [docs/STUDIO.md](docs/STUDIO.md#csv-specification-for-people-and-csv-generating-agents)), with clips under `sourceRoot`. Each row is generated as *whole first clip → bridge → whole second clip*, with the Studio's engine and AI review. Results go into `outputs/` with a `batch-report.csv`, then the game's `ingest` command takes them in. Its `failed`, `flagged` and `summary` patterns feed the table. `verdict`, `quality`, `verdicts` and `registry` let the table show flags and what plays, and let you reject or approve transitions.

**Turning on 7-seat** is a matter of writing its stages in `pipelines/7-seat.json` (or a contract in its repo) and setting `"enabled": true`.

## Hosting on Render (later, if you want)

The **free** deployment (`render.yaml` + `Dockerfile`) stays **Studio-only**. Render Free sleeps, has 512 MB of RAM and no disk, so it can't run pipelines. Vercel can't either (short functions, no disk), but it is a good home for a finished game ZIP.

To host pipelines too, use [`Dockerfile.pipeline`](Dockerfile.pipeline). [`render.pipeline.yaml`](render.pipeline.yaml) shows the settings:

- **Instance:** a paid always-on instance. Standard (2 GB) is recommended for SAM 2 on the CPU.
- **Disk:** a persistent disk at `/data`, about 25 GB.
- **Environment:**
  - `STUDIO_HOSTED=true`, `TEAM_PASSWORD`, `PIPELINES_ENABLED=true`
  - `GITHUB_TOKEN`: read access to the private game repo. Runs on a host use the GitHub source.
  - Optionally `FAL_KEY`.

This costs money, so nothing is deployed until you choose to. On a host, **Play** is replaced by **Download**, and keys entered by Studio users never fund pipelines.

## Where things are

```
pipelines/*.json           pipeline definitions (3-seat, 7-seat)
src/pipeline/              engine.js (runs, stages, recovery), workspace.js (Set up), command.js + watchdog.js,
                           transitions.js, input.js (take checks), routes.js, preview.js, zip.js
src/ (rest), public/       the Studio engine and UI; public/pipeline.js + shell.js are the Pipelines tab
data/pipeline/runs/<id>/   run.json, input/, game/ (the run's copy of the game), transitions/, logs/
data/pipeline/toolchains/  Python and Node environments, shared by runs with the same lockfiles
data/pipeline/library/     paid transitions by fingerprint (<hash>.mp4 + .json), reused across redos and runs
```

## Development

```sh
npm test        # Studio + pipeline tests; no keys or provider charges
npm run smoke   # local-method renders through FFmpeg
```

The pipeline tests drive real processes through a fake game ([`test/fixtures/fake-game/tool.js`](test/fixtures/fake-game/tool.js)) that mimics bj3's markers, caching, partial writes and failures. They cover pause, crash and restart recovery, redo, spend and key gates, row retry and skip, verdicts, invalid takes, the HTTP API, ZIPs, the orphan watchdog, overlapping actions, Windows path limits, reconnecting to in-flight provider requests, and reusing paid transitions across redos and runs (no double charges).

**Windows path limit.** Windows caps paths at 260 characters unless long paths are switched on. PyTorch and SAM 2 put files about 120 characters deep inside the Python tools. So if this folder sits very deep (for example inside OneDrive), Set up stops and explains the two fixes: turn on long paths, or set `DATA_DIR` to a short folder such as `C:\bp-data`.
