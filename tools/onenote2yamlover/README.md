# onenote2yamlover

Imports Microsoft **OneNote** notebooks into a yamlover tree. Each OneNote page becomes a
**chapter** (`docs/documents/chapter`) whose positional body is **marklower** prose
(`docs/documents/marklower`), tables, and pointers to attachments/subpages; the notebook's
section/page hierarchy becomes the directory tree (expanded directory concrete).

> **Platform:** Windows + the OneNote **desktop** app (the importer talks to it over COM).
> **.NET 10.** This is a personal migration tool, not a published package.

## What it produces

A page maps to the fully-omni chapter shape (`docs/documents/chapter`): the title is the root's
scalar self-value line, followed by one ordered body of chunks. Concretely:

- **Prose** → marklower block scalars (bold/italic/strike, links, `` `code` ``; the default
  chunk format `text/marklower`).
- **Tables** → `!!<*yamlover: $defs: table>` nodes (`docs/documents/marklower`) — nested tables
  carry the explicit table tag; a cell that mixes prose and tables becomes a chapter cell.
  OneNote has no header rows or merged cells, so none are emitted.
- **Images / attachments / ink** → files written beside the chapter and referenced by `*`
  pointers; handwriting strokes (ISF) are rendered to SVG.
- **Subpages** → subchapter pointers (`- *: name`) appended after the page's own content,
  preserving author order over the engine's alphabetical directory scan.

## Layout (the .NET solution)

`OneNote2Yamlover.sln` has three projects + a test project:

| Project | Framework | Role |
|---|---|---|
| **`OneNote2Yamlover.Core`** | `net10.0` (platform-neutral) | The conversion + serialization core, filesystem- and OneNote-free (dependencies injected). `Convert/PageConverter` (page XML → chunks + assets), `Serialize/Chapter` (chapter + `$defs: table` emission), `Text/{Marklower,Yaml,Mime,Names}` (marklower + yamlover-scalar escaping), `Model/Hierarchy`, `Sync/{Materializer,AncestorReconciler,NamePlan,Fs}` (materialize + reconcile the on-disk tree, renaming-safe). |
| **`OneNote2Yamlover.OneNote`** | `net10.0-windows` | COM interop with the running OneNote app: `OneNoteClient`, plus `OleMessageFilter`/`StaWorker` for the STA-thread COM plumbing. |
| **`OneNote2Yamlover`** | `net10.0-windows`, WPF (`WinExe`) | The desktop app: `MainWindow` + `ViewModels/`, a `--sync` CLI (`Cli.cs`), `Sync/{SyncOrchestrator,Destination,SshDestination,InkRenderer}`, and `Ssh/{SshConfig,SshConnector,KnownHosts}` for shipping the output to a remote host over SSH. |
| **`OneNote2Yamlover.Core.Tests`** | `net10.0` | Core unit tests (`ChapterTests`, `ConvertTests`, `MediaTests`, `TextTests`) — no OneNote or filesystem needed. |

The `Core` is deliberately platform-neutral so its tests run anywhere; only the `.OneNote`
and WPF projects need Windows/COM/WPF.

## Build & run

```console
# from tools/onenote2yamlover
dotnet build OneNote2Yamlover.sln
dotnet test  OneNote2Yamlover.Core.Tests      # Core tests, no OneNote needed

# GUI: pick sections and a destination interactively
dotnet run --project OneNote2Yamlover

# headless-ish CLI (drives the real window, then exits):
dotnet run --project OneNote2Yamlover -- \
  --sync --section "Physics" --section "Notes" \
  --dest D:\notes-yamlover            # or: --remote host:/abs/path  (SSH; host from ~/.ssh/config)
  # [--notebook "Dmitry's Notebook"] [--keep-open]
```

The CLI is *not* a true headless mode — it creates and binds the WPF UI exactly as a user
would (the only way to exercise WPF-thread faults). OneNote must be installed and able to
open the notebook. Browse the imported tree with `npx yamlover <dest>`.

## Status

- **Prose → marklower:** done (`Text/Marklower.cs`).
- **Tables → marklower `$defs: table`:** done in the C# core (`Serialize/Chapter.cs`) —
  matches `docs/documents/marklower/known-divergence`.
- **Images, attachments, ink→SVG, subpages, SSH sync, rename-safe reconcile:** implemented.

### Legacy prototype

`tools/onenote2yamlover.ps1` is the **original PowerShell spike** (Phase 2) that the C#
solution was **ported from** (see the "Ported from `Serialize-Chapter` / `Csv-Field`"
comments in `Core`). It still emits **CSV** tables rather than `$defs: table` marklower
grids, and lacks the ink/asset and reconcile work. It is kept for reference; the .NET
solution supersedes it — prefer the solution.

## See also

- `docs/documents/chapter` — the chapter model pages import into.
- `docs/documents/marklower` — the prose markup + the `$defs: table` grid schema.
- `../README.md` — the tools index; `../../FUTURE.md` §"Prose convergence" places this
  importer in the broader "foreign document → chapter + marklower" direction.
