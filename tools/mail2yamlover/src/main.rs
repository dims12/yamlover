// mail2yamlover — import a mail archive into a yamlover tree.
//
//   mail2yamlover --source thebat --from <dir> --dest <dir> [options]
//
// See README.md for the output shape and the known fidelity gaps.

mod emit;
mod message;
mod source;
mod tree;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::io::IsTerminal;
use std::process::ExitCode;
use std::time::Instant;

use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};

use emit::{EmitOptions, emit};
use source::{FolderNode, MailSource, RawMessage};
use tree::{Asset, Chapter, Chunk, sanitize, unique};

const USAGE: &str = "\
mail2yamlover — import a mail archive into a yamlover tree

USAGE:
    mail2yamlover --from <dir> --dest <dir> [OPTIONS]

OPTIONS:
    --source <name>     the reader to use (default: thebat)
    --from <dir>        the mail directory to read
    --dest <dir>        where to write the yamlover tree (must not exist, or --force)
    --accounts <a,b>    only these top-level folders / accounts
    --no-raw            do not keep each message's verbatim RFC-822 as message.eml
                        (halves the output; loses the guarantee that nothing was lost
                        to a MIME-parsing bug)
    --limit <n>         stop after n messages per folder — for a quick look
    --force             overwrite an existing destination
    -h, --help          this text
";

struct Args {
    source: String,
    from: PathBuf,
    dest: PathBuf,
    accounts: Option<Vec<String>>,
    keep_raw: bool,
    limit: Option<usize>,
    force: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        source: "thebat".into(),
        from: PathBuf::new(),
        dest: PathBuf::new(),
        accounts: None,
        keep_raw: true,
        limit: None,
        force: false,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv.iter().any(|x| x == "-h" || x == "--help") {
        return Err(String::new()); // print usage, exit 0
    }
    let mut i = 0;
    while i < argv.len() {
        let need = |i: usize, what: &str| -> Result<String, String> {
            argv.get(i + 1).cloned().ok_or_else(|| format!("{what} needs a value"))
        };
        match argv[i].as_str() {
            "--source" => {
                a.source = need(i, "--source")?;
                i += 2;
            }
            "--from" => {
                a.from = PathBuf::from(need(i, "--from")?);
                i += 2;
            }
            "--dest" => {
                a.dest = PathBuf::from(need(i, "--dest")?);
                i += 2;
            }
            "--accounts" => {
                a.accounts =
                    Some(need(i, "--accounts")?.split(',').map(|s| s.trim().to_string()).collect());
                i += 2;
            }
            "--limit" => {
                a.limit = Some(
                    need(i, "--limit")?.parse().map_err(|_| "--limit needs a number".to_string())?,
                );
                i += 2;
            }
            "--no-raw" => {
                a.keep_raw = false;
                i += 1;
            }
            "--force" => {
                a.force = true;
                i += 1;
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    if a.from.as_os_str().is_empty() {
        return Err("--from is required".into());
    }
    if a.dest.as_os_str().is_empty() {
        return Err("--dest is required".into());
    }
    Ok(a)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(msg) => {
            if msg.is_empty() {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            eprintln!("mail2yamlover: {msg}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    };
    match run(&args) {
        Ok(stats) => {
            stats.bar.finish_and_clear();
            stats.report();
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("mail2yamlover: {e}");
            ExitCode::FAILURE
        }
    }
}

struct Stats {
    folders: usize,
    messages: usize,
    unparsable: usize,
    attachments: usize,
    bytes: u64,
    warnings: Vec<String>,
    started: Option<Instant>,
    bar: ProgressBar,
}

impl Default for Stats {
    fn default() -> Self {
        Stats {
            folders: 0,
            messages: 0,
            unparsable: 0,
            attachments: 0,
            bytes: 0,
            warnings: Vec::new(),
            started: None,
            bar: ProgressBar::hidden(),
        }
    }
}

/// An indeterminate spinner for the pre-scan, hidden when stderr is not a terminal.
fn spinner(what: &str) -> ProgressBar {
    if !std::io::stderr().is_terminal() {
        return ProgressBar::hidden();
    }
    let bar = ProgressBar::new_spinner();
    bar.set_style(
        ProgressStyle::with_template("{spinner:.cyan} [{elapsed_precise}] {msg}…")
            .unwrap_or_else(|_| ProgressStyle::default_spinner()),
    );
    bar.set_message(what.to_string());
    bar.set_draw_target(ProgressDrawTarget::stderr_with_hz(10));
    bar
}

/// A bar over the whole archive, or a hidden no-op when stderr is not a terminal.
///
/// Hidden when piped on purpose: a redraw-per-message turns a log file into megabytes of
/// escape codes, and this tool gets run into `tail` as often as into a console.
fn progress_bar(total: usize) -> ProgressBar {
    if !std::io::stderr().is_terminal() {
        return ProgressBar::hidden();
    }
    let bar = ProgressBar::new(total as u64);
    bar.set_style(
        ProgressStyle::with_template(
            "{spinner:.cyan} [{elapsed_precise}] {bar:32.cyan/blue} {human_pos}/{human_len} msgs · {per_sec} · ETA {eta} · {wide_msg}",
        )
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=> "),
    );
    // Redrawing 57k times costs more than the work between ticks; 10/s is smooth to the eye.
    bar.set_draw_target(ProgressDrawTarget::stderr_with_hz(10));
    bar
}

impl Stats {
    fn report(&self) {
        let secs = self.started.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
        println!(
            "\n{} folder(s), {} message(s), {} attachment(s), {:.1} MB written in {secs:.1}s",
            self.folders,
            self.messages,
            self.attachments,
            self.bytes as f64 / 1e6
        );
        if self.unparsable > 0 {
            println!("{} message(s) had no parsable headers and were kept as raw bytes only", self.unparsable);
        }
        // Warnings are SUMMARIZED, never silently dropped: a count with a sample beats both a
        // 20,000-line log and a reassuring silence.
        if !self.warnings.is_empty() {
            println!("\n{} warning(s); first few:", self.warnings.len());
            for w in self.warnings.iter().take(5) {
                println!("  {w}");
            }
            if self.warnings.len() > 5 {
                println!("  … and {} more", self.warnings.len() - 5);
            }
        }
    }
}

fn run(args: &Args) -> Result<Stats, String> {
    let reader = source::by_name(&args.source).ok_or_else(|| {
        format!("unknown --source {:?}; known: {}", args.source, source::KNOWN_SOURCES.join(", "))
    })?;
    if !args.from.is_dir() {
        return Err(format!("--from is not a directory: {}", args.from.display()));
    }
    if args.dest.exists() && !args.force {
        return Err(format!(
            "--dest already exists: {} (pass --force to write into it anyway)",
            args.dest.display()
        ));
    }

    let roots = reader.scan(&args.from).map_err(|e| format!("scanning {}: {e}", args.from.display()))?;
    let roots: Vec<FolderNode> = match &args.accounts {
        None => roots,
        Some(keep) => roots.into_iter().filter(|r| keep.iter().any(|k| k == &r.name)).collect(),
    };
    if roots.is_empty() {
        return Err("no folders matched — check --from and --accounts".into());
    }

    // The total, before any work: cheap in bytes for a reader that can seek its store (TheBat
    // touches ~2 MB of record headers for the whole archive), and simply absent for one that
    // cannot. It is NOT cheap in wall-clock — opening 73 stores past an antivirus takes about
    // fifteen seconds — so the count gets its own spinner rather than fifteen seconds of
    // silence before the bar appears.
    let counting = spinner("scanning message stores");
    let total: usize = roots
        .iter()
        .flat_map(|r| r.walk())
        .map(|f| {
            counting.tick();
            let n = reader.count(f).unwrap_or(0);
            match args.limit {
                Some(limit) => n.min(limit),
                None => n,
            }
        })
        .sum();
    counting.finish_and_clear();

    let opts = EmitOptions { keep_raw: args.keep_raw };
    let mut stats = Stats {
        started: Some(Instant::now()),
        bar: progress_bar(total),
        ..Default::default()
    };
    tree::create_dir_all(&args.dest).map_err(|e| format!("creating --dest: {e}"))?;

    // The destination root's own `.yo/body.yo` is deliberately NOT written: the user may have
    // pointed at an existing yamlover project, and clobbering its overlay would be
    // destructive. The imported accounts are found by the engine's directory scan.
    let mut used_at_root: HashSet<String> = HashSet::new();
    for root in &roots {
        let name = unique(&mut used_at_root, &sanitize(&root.name), "");
        let dir = args.dest.join(&name);
        write_folder(reader.as_ref(), root, &dir, &opts, args, &mut stats)?;
    }
    Ok(stats)
}

/// Write one folder: its messages as members, its subfolders as subdirectories, and a
/// `.yo/body.yo` naming them all in order.
fn write_folder(
    reader: &dyn MailSource,
    folder: &FolderNode,
    dir: &Path,
    opts: &EmitOptions,
    args: &Args,
    stats: &mut Stats,
) -> Result<(), String> {
    tree::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    stats.folders += 1;
    stats.bar.set_message(folder.name.clone());

    // An unreadable store loses that folder, not the import: a locked, quarantined or
    // truncated file should cost exactly what it contains.
    let mut messages = match reader.messages(folder) {
        Ok(m) => m,
        Err(e) => {
            stats.warnings.push(format!("could not read {}: {e} — folder left empty", folder.dir.display()));
            Vec::new()
        }
    };
    if let Some(limit) = args.limit {
        messages.truncate(limit);
    }

    let mut used: HashSet<String> = HashSet::new();
    // The parent's ordered pointer array. Disk has no order; the overlay grants it
    // (docs/language/concretes/01-choosing) — so the numbered names are cosmetic and THIS is
    // the data.
    let mut members: Vec<String> = Vec::new();

    for (i, raw) in messages.iter().enumerate() {
        // A message that will not write is skipped and NOT named in the pointer array —
        // pointing at something absent is the one failure the tree-level sweep hunts for.
        match write_message(raw, i, dir, &mut used, opts, stats) {
            Ok(member) => members.push(member),
            Err(e) => stats.warnings.push(format!("message {} skipped: {e}", i + 1)),
        }
    }

    // TheBat's externally-stored attachments, carried verbatim beside the messages.
    let mut attach_assets: Vec<Asset> = Vec::new();
    for p in &folder.attachments {
        let Ok(bytes) = std::fs::read(tree::long_path(p)) else {
            stats.warnings.push(format!("could not read {}", p.display()));
            continue;
        };
        let raw_name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let safe = sanitize(&raw_name);
        let name = match safe.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => unique(&mut used, stem, &format!(".{ext}")),
            _ => unique(&mut used, &safe, ""),
        };
        stats.bytes += bytes.len() as u64;
        attach_assets.push(Asset {
            name: name.clone(),
            bytes,
            format: guess_format(&name),
        });
        members.push(name);
    }

    for child in &folder.children {
        let name = unique(&mut used, &sanitize(&child.name), "");
        write_folder(reader, child, &dir.join(&name), opts, args, stats)?;
        members.push(name);
    }

    let mut chapter = Chapter::new(&folder.name);
    for m in &members {
        chapter.chunk(Chunk::Pointer { member: m.clone() });
    }
    let warned = tree::write_chapter_dir(dir, &chapter, &attach_assets)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    stats.warnings.extend(warned);
    Ok(())
}

/// Returns the member name the parent should point at.
fn write_message(
    raw: &RawMessage,
    index: usize,
    dir: &Path,
    used: &mut HashSet<String>,
    opts: &EmitOptions,
    stats: &mut Stats,
) -> Result<String, String> {
    let parsed = message::parse(&raw.bytes);
    let mut e = match &parsed {
        Some(m) => emit(m, &raw.bytes, raw.timestamp, opts),
        None => {
            // No parsable headers. Keep the bytes rather than dropping the message: a
            // chapter with the raw member and nothing else is still the message.
            stats.unparsable += 1;
            let mut chapter = Chapter::new("(unparsable message)");
            chapter.chunk(Chunk::Pointer { member: emit::RAW_NAME.to_string() });
            emit::Emitted {
                chapter,
                assets: vec![Asset {
                    name: emit::RAW_NAME.to_string(),
                    bytes: raw.bytes.clone(),
                    format: "message/rfc822".to_string(),
                }],
            }
        }
    };
    if let Some(m) = &parsed {
        stats.warnings.extend(m.warnings.iter().cloned());
        stats.attachments += m.attachments.iter().filter(|a| !a.empty).count();
    }
    e.chapter.field("flags", emit::flags_node(raw.is_read()));
    stats.messages += 1;
    stats.bar.inc(1);

    // NN- prefix + the subject: the numbers give a stable, sortable, collision-free name for
    // what is an ordinal collection, and the parent's pointer array carries the real order.
    let stem = format!("{:05}-{}", index + 1, sanitize(&e.chapter.title));
    let stem = sanitize(&stem);

    for a in &e.assets {
        stats.bytes += a.bytes.len() as u64;
    }

    if e.needs_dir() {
        let name = unique(used, &stem, "");
        let warned = tree::write_chapter_dir(&dir.join(&name), &e.chapter, &e.assets)
            .map_err(|err| format!("{}: {err}", dir.join(&name).display()))?;
        stats.warnings.extend(warned);
        Ok(name)
    } else {
        let name = unique(used, &stem, ".yo");
        tree::write_chapter_file(&dir.join(&name), &e.chapter)
            .map_err(|err| format!("{}: {err}", dir.join(&name).display()))?;
        Ok(name)
    }
}

fn guess_format(name: &str) -> String {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "pjpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "txt" => "text/plain",
        "htm" | "html" => "text/html",
        "doc" => "application/msword",
        "msg" => "application/vnd.ms-outlook",
        "eml" => "message/rfc822",
        _ => "application/octet-stream",
    }
    .to_string()
}
