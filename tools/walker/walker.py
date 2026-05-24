#!/usr/bin/env python3
"""walker — explore a yamlover tree with shell-style ``cd`` and ``ls``.

A yamlover entity has several *concrete representations* — a plain file, a plain
directory, or a directory carrying a ``.yamlover/schema.yaml`` — but they all
describe the same *logical* node (an object, an array, or a scalar). walker
reads the schema, resolves where every value actually lives (inline ``const``,
a ``file/yaml`` / ``file/json`` / ``file/binary`` child, a collapsed file, an
expanded subdirectory, …) and presents the single logical tree, so you can move
around it as if it were an ordinary filesystem.

``ls`` shows each child's JSON-Schema **type** (object, array, string, integer,
boolean, …) and its **concrete** representation (how/where it is stored).

Usage:
    python walker.py [PATH]        # PATH defaults to the current directory

Then, at the prompt:
    ls [path]      list a node's children (name, type, concrete)
    cd <path>      move to a node — JSON-path style:  ..  /a/b  a[0]/b
    pwd            show the current logical path
    cat [path]     print the value at a node
    tree [path]    print the subtree
    help           show this help
    exit | quit    leave
"""

from __future__ import annotations

import json
import os
import re
import struct
import sys

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("walker requires PyYAML — install it with:  pip install pyyaml")

YAMLOVER_DIR = ".yamlover"
SCHEMA_FILE = "schema.yaml"


# --------------------------------------------------------------------------- #
# Value model
# --------------------------------------------------------------------------- #
class Binary:
    """A binary leaf value (a ``file/binary`` child) we do not expand inline."""

    def __init__(self, data: bytes, fmt: str | None = None, decoded=None):
        self.data = data
        self.fmt = fmt
        self.decoded = decoded

    def __repr__(self) -> str:
        info = f"<binary {self.fmt or 'bytes'}, {len(self.data)} bytes"
        if self.decoded is not None:
            info += f", = {self.decoded!r}"
        return info + ">"


class Node:
    """A logical node: a value plus the concrete representation it came from.

    ``value`` is a ``dict[str, Node]`` (object), a ``list[Node]`` (array), or a
    scalar / :class:`Binary` (leaf). ``concrete`` records how the node is stored:
    ``yamlover`` · ``dir`` · ``file`` · ``file/yaml`` · ``file/json`` ·
    ``file/binary`` · ``const`` (pinned in the schema) · ``inline`` (defined in
    the schema or inside a parent's collapsed file).
    """

    def __init__(self, value, concrete: str | None = None):
        self.value = value
        self.concrete = concrete


# --------------------------------------------------------------------------- #
# Loading / materialization
# --------------------------------------------------------------------------- #
def load_entity(path: str) -> Node:
    """Materialize the logical node of the yamlover entity at *path*."""
    if os.path.isdir(path):
        schema_path = os.path.join(path, YAMLOVER_DIR, SCHEMA_FILE)
        if os.path.isfile(schema_path):
            with open(schema_path, encoding="utf-8") as fh:
                schema = yaml.safe_load(fh)
            node = resolve(schema, path, default_name=None)
            node.concrete = "yamlover"  # this directory is itself a yamlover node
            return node
        # plain directory (no .yamlover/): an object of its visible entries
        return Node(extra_entries(path, consumed=set(), existing={}), "dir")
    # a plain file
    node = from_file(path, "file/yaml", None)
    node.concrete = "file"
    return node


def resolve(schema, container: str, default_name: str | None) -> Node:
    """Resolve a JSON-Schema fragment to a logical :class:`Node`.

    container     directory holding this node's file(s)
    default_name  file/subdir name when ``x-yamlover.file-name`` is absent
                  (the property key or array index); ``None`` at the root
    """
    if schema is None:
        return Node(None, None)
    if "const" in schema:
        return wrap(schema["const"], "const")

    xy = schema.get("x-yamlover") or {}
    concrete = xy.get("concrete")
    name = xy.get("file-name") or default_name
    is_file = bool(concrete) and concrete.startswith("file/")

    stype = schema.get("type")
    is_object = stype == "object" or "properties" in schema
    is_array = stype == "array" or "prefixItems" in schema

    # A structured node collapsed into a single file (e.g. entity07).
    if (is_object or is_array) and is_file and name:
        return from_file(os.path.join(container, name), concrete, schema)

    # A child expanded as its own subdirectory (e.g. the spec's address/).
    if name and os.path.isdir(os.path.join(container, name)):
        return load_entity(os.path.join(container, name))

    if is_object:
        children = {}
        consumed = {YAMLOVER_DIR}
        for key, child in (schema.get("properties") or {}).items():
            children[key] = resolve(child, container, key)
            cxy = (child.get("x-yamlover") if isinstance(child, dict) else None) or {}
            consumed.add(cxy.get("file-name") or key)
        # also surface undescribed files/dirs that are physically present
        children.update(extra_entries(container, consumed, children))
        return Node(children, concrete or "inline")

    if is_array:
        items = [
            resolve(child, container, str(idx))
            for idx, child in enumerate(schema.get("prefixItems") or [])
        ]
        return Node(items, concrete or "inline")

    # A scalar stored in its own file (e.g. entity05 / entity06 / entity09).
    if is_file and name:
        return from_file(os.path.join(container, name), concrete, schema)

    return Node(None, concrete)  # underspecified node


def from_file(path: str, concrete: str, schema) -> Node:
    """Decode a file and wrap it; the node is the file, its contents are inline."""
    value = decode_file(path, concrete, schema)
    node = wrap(value, "inline")
    node.concrete = concrete
    return node


def wrap(value, concrete: str) -> Node:
    """Wrap a plain Python value into Nodes, tagging every level with *concrete*."""
    if isinstance(value, dict):
        return Node({k: wrap(v, concrete) for k, v in value.items()}, concrete)
    if isinstance(value, list):
        return Node([wrap(v, concrete) for v in value], concrete)
    return Node(value, concrete)


def extra_entries(container: str, consumed: set, existing: dict) -> dict:
    """Undescribed, non-hidden files/dirs physically present in *container*.

    These are surfaced as children even though the schema does not mention them,
    so ``ls`` shows ordinary files (e.g. a README) that simply live in the
    directory. Hidden entries (``.git``, ``.yamlover``, …) and names already
    claimed by a schema property are skipped.
    """
    out = {}
    if os.path.isdir(container):
        for name in sorted(os.listdir(container)):
            if name.startswith(".") or name in consumed or name in existing:
                continue
            out[name] = load_entity(os.path.join(container, name))
    return out


def decode_file(path: str, concrete: str, schema):
    """Read *path* and decode it according to its ``concrete`` encoding."""
    if not os.path.exists(path):
        return f"<missing: {os.path.basename(path)}>"
    try:
        if concrete == "file/binary":
            data = open(path, "rb").read()
            fmt = (schema or {}).get("format")
            decoded = None
            if fmt == "int32/le" and len(data) == 4:
                decoded = struct.unpack("<i", data)[0]
            return Binary(data, fmt, decoded)
        text = open(path, encoding="utf-8").read()
        if concrete == "file/json":
            return json.loads(text)
        return yaml.safe_load(text)  # file/yaml (default)
    except (UnicodeDecodeError, yaml.YAMLError, json.JSONDecodeError) as exc:
        return f"<unparseable {os.path.basename(path)}: {exc.__class__.__name__}>"


# --------------------------------------------------------------------------- #
# Navigation helpers
# --------------------------------------------------------------------------- #
def is_container(node: Node) -> bool:
    return isinstance(node.value, (dict, list))


def type_label(node: Node) -> str:
    v = node.value
    if isinstance(v, dict):
        return "object"
    if isinstance(v, list):
        return "array"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, Binary):
        return "binary"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if v is None:
        return "null"
    return type(v).__name__


def child_key(node: Node, part: str):
    """Translate a path segment into a real key/index for *node*."""
    v = node.value
    if isinstance(v, dict):
        if part in v:
            return part
        raise KeyError(f"no such child: {part}")
    if isinstance(v, list):
        token = part[1:-1] if part.startswith("[") and part.endswith("]") else part
        try:
            idx = int(token)
        except ValueError:
            raise KeyError(f"not an index: {part}")
        if 0 <= idx < len(v):
            return idx
        raise KeyError(f"index out of range: {idx}")
    raise KeyError(f"{type_label(node)} has no children")


def get_node(root: Node, segments) -> Node:
    node = root
    for seg in segments:
        node = node.value[seg]
    return node


# A path token is either a bracketed array index ([0]) or a key name.
_PATH_TOKEN = re.compile(r"\[\d+\]|[^/\[\]]+")


def navigate(root: Node, current, arg: str | None):
    """Return the new path segments for ``cd arg`` from *current*.

    Accepts JSON-path-style arguments — ``/a/b[0]``, ``b[0]/c``, ``..`` — where
    ``[n]`` is an array index and slash-separated names are object keys.
    """
    if not arg:
        return []  # bare `cd` → root
    segs = [] if arg.startswith("/") else list(current)
    for token in _PATH_TOKEN.findall(arg):
        if token == ".":
            continue
        if token == "..":
            if segs:
                segs.pop()
            continue
        segs.append(child_key(get_node(root, segs), token))
    get_node(root, segs)  # validate
    return segs


def format_path(segments) -> str:
    """Render path segments JSON-path style: ``/key[0]/other`` (root → ``/``)."""
    out = "".join(f"[{s}]" if isinstance(s, int) else f"/{s}" for s in segments)
    return out or "/"


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def to_plain(node: Node):
    v = node.value
    if isinstance(v, dict):
        return {k: to_plain(c) for k, c in v.items()}
    if isinstance(v, list):
        return [to_plain(c) for c in v]
    if isinstance(v, Binary):
        return repr(v)
    return v


def render(node: Node) -> str:
    """Pretty-print a value (YAML for containers, plain for scalars)."""
    v = node.value
    if isinstance(v, Binary):
        return repr(v)
    if not isinstance(v, (dict, list)):
        if v is True:
            return "true"
        if v is False:
            return "false"
        if v is None:
            return "null"
        return str(v)
    return yaml.safe_dump(to_plain(node), sort_keys=False, allow_unicode=True).rstrip()


def list_children(node: Node) -> str:
    v = node.value
    if isinstance(v, dict):
        rows = [(str(k), c) for k, c in v.items()]
    elif isinstance(v, list):
        rows = [(f"[{i}]", c) for i, c in enumerate(v)]
    else:
        return render(node)  # a scalar leaf: just show its value
    if not rows:
        return "(empty)"
    disp = [(name, type_label(child), child.concrete or "-") for name, child in rows]
    nw = max(len("NAME"), *(len(d[0]) for d in disp))
    tw = max(len("TYPE"), *(len(d[1]) for d in disp))
    lines = [f"{'NAME':<{nw}}  {'TYPE':<{tw}}  CONCRETE"]
    lines += [f"{name:<{nw}}  {typ:<{tw}}  {conc}" for name, typ, conc in disp]
    return "\n".join(lines)


def render_tree(node: Node, prefix: str = "") -> str:
    v = node.value
    if isinstance(v, dict):
        items = list(v.items())
    elif isinstance(v, list):
        items = [(f"[{i}]", c) for i, c in enumerate(v)]
    else:
        return f"{render(node)}  ({type_label(node)}) [{node.concrete or '-'}]"
    lines = []
    for i, (name, child) in enumerate(items):
        last = i == len(items) - 1
        branch = "└── " if last else "├── "
        tag = f"  [{child.concrete or '-'}]"
        if is_container(child):
            lines.append(f"{prefix}{branch}{name}{tag}")
            sub = render_tree(child, prefix + ("    " if last else "│   "))
            if sub:
                lines.append(sub)
        else:
            lines.append(f"{prefix}{branch}{name}: {render(child)}{tag}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Shell
# --------------------------------------------------------------------------- #
class Shell:
    def __init__(self, root: Node, name: str):
        self.root = root
        self.name = name
        self.path: list = []

    def prompt(self) -> str:
        return f"{self.name}:{format_path(self.path)}> "

    def node_at(self, arg: str | None) -> Node:
        segs = self.path if not arg else navigate(self.root, self.path, arg)
        return get_node(self.root, segs)

    def run(self):
        print(f"walking {self.name!r}  ({self.root.concrete or '-'}, {type_label(self.root)})")
        print("type 'help' for commands, 'exit' to quit")
        while True:
            try:
                line = input(self.prompt()).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return
            if not line:
                continue
            cmd, _, arg = line.partition(" ")
            arg = arg.strip() or None
            try:
                self.dispatch(cmd, arg)
            except (KeyError, IndexError) as exc:
                print(f"error: {exc}".replace('"', ""))

    def dispatch(self, cmd: str, arg: str | None):
        if cmd in ("exit", "quit"):
            raise SystemExit(0)
        if cmd == "help":
            print(__doc__.split("Then, at the prompt:")[1].rstrip())
        elif cmd == "pwd":
            print(format_path(self.path))
        elif cmd == "ls":
            print(list_children(self.node_at(arg)))
        elif cmd == "cd":
            self.path = navigate(self.root, self.path, arg)
        elif cmd == "cat":
            print(render(self.node_at(arg)))
        elif cmd == "tree":
            node = self.node_at(arg)
            print(render_tree(node) if is_container(node) else render(node))
        else:
            print(f"unknown command: {cmd} (try 'help')")


def main(argv):
    path = argv[1] if len(argv) > 1 else "."
    if not os.path.exists(path):
        sys.exit(f"no such path: {path}")
    root = load_entity(os.path.normpath(path))
    name = os.path.basename(os.path.abspath(os.path.normpath(path)))
    try:
        Shell(root, name).run()
    except SystemExit:
        pass


if __name__ == "__main__":
    main(sys.argv)
