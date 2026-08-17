//! yamlover, in Rust — the surface languages (yamlover, json5p) over the shared **IR**
//! (`../../../IR.md`).
//!
//! This is the second implementation. It shares no code with `tools/parser/ts` and is
//! written *from* the specs (`IR.md`, `JSON5P.md`, `docs/language/`), per
//! `tools/parser/README.md`'s "top level = implementation language" rule. `PLAN.md:87`
//! records that the TS parser was hand-written rather than built on a stock YAML library
//! precisely so this port would have a spec to follow.
//!
//! Both implementations are gated by the same fixtures — `test-examples/` and the shared
//! conformance corpora under `../conformance/` — so this one is an oracle for the TS one
//! rather than a fork of it.
//!
//! ## Status
//!
//! The WRITER half is landing first: it is what an importer needs (build IR → serialize →
//! materialize a tree), it is a third of the surface, and it is gated byte-for-byte against
//! the existing `out.yo` goldens from day one. The reader half (`yamlover`, `json5p`,
//! `highlight`) follows; the language server designed in `LSP.md` sits on top of that.

pub mod ir;
pub mod number;
pub mod scalar;
pub mod pointer;
pub mod serialize_common;
pub mod serialize_yamlover;

pub use pointer::{key_portion, render_pointer};
pub use serialize_common::{LossyError, dq, flow_key_text, key_text, seq_mark_len};
pub use serialize_yamlover::{SerializeOpts, serialize_yamlover};

pub use ir::{
    Anchor, Comment, CommentStyle, Concrete, Document, EdgeKind, Entry, EntryMeta, KeyConcrete,
    Node, NodeKind, NodeMeta, ParseError, Placement, Plain, PlainError, Pointer, PointerBase,
    ScalarValue, SourceInfo, Span, Step, Value, to_plain,
};
