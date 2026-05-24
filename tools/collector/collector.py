#!/usr/bin/env python3
"""collector — assemble a yamlover tree into one Yamlover JSON Schema.

Where `walker` materializes the *values* of a yamlover tree, `collector`
materializes the *schema*. It walks an entity tree and merges every
per-directory `.yamlover/schema.yaml` into a single schema document, inlining
the schema of each nested node and inferring a schema for any plain file or
plain directory that has none. Every node is annotated with its concrete
representation under `x-yamlover.concrete` (`yamlover`, `dir`, `file`,
`file/yaml`, `file/json`, `file/binary`). The result prints as YAML (default)
or JSON.

Usage:
    python collector.py [PATH] [-f yaml|json]
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("collector requires PyYAML — install it with:  pip install pyyaml")

YAMLOVER_DIR = ".yamlover"
SCHEMA_FILE = "schema.yaml"


def collect(path: str, parent_prop=None) -> dict:
    """Build the schema for the entity at *path*.

    parent_prop  the schema fragment the parent used for this child (carrying
                 contextual metadata such as ``description`` and ``file-name``),
                 or ``None`` at the root / for an undescribed entry.
    """
    if os.path.isdir(path):
        schema_path = os.path.join(path, YAMLOVER_DIR, SCHEMA_FILE)
        if os.path.isfile(schema_path):
            with open(schema_path, encoding="utf-8") as fh:
                schema = yaml.safe_load(fh) or {}
            concrete = "yamlover"
        else:  # a plain directory: object of its entries (described or not)
            schema = copy.deepcopy(parent_prop) if isinstance(parent_prop, dict) else {}
            schema.pop("x-yamlover", None)
            schema.setdefault("type", "object")
            schema.setdefault("properties", {})
            concrete = "dir"
        schema = expand_children(schema, path)
        schema.setdefault("x-yamlover", {}).setdefault("concrete", concrete)
        return apply_parent_meta(schema, parent_prop)

    # a plain file: keep the parent's typing if any, else infer from contents
    schema = copy.deepcopy(parent_prop) if isinstance(parent_prop, dict) else {}
    if "type" not in schema and "const" not in schema:
        for key, value in infer_schema(read_value(path)).items():
            schema.setdefault(key, value)
    schema.setdefault("x-yamlover", {}).setdefault("concrete", "file")
    return schema


def expand_children(schema: dict, container: str) -> dict:
    """Recurse into a node's children, inlining their schemas from disk."""
    props = schema.get("properties")
    if isinstance(props, dict):
        consumed = {YAMLOVER_DIR}
        merged = {}
        for key, cprop in props.items():
            name = child_name(cprop, key)
            consumed.add(name)
            child = os.path.join(container, name)
            merged[key] = collect(child, cprop) if os.path.exists(child) else cprop
        if os.path.isdir(container):  # undescribed, non-hidden extras
            for name in sorted(os.listdir(container)):
                if name.startswith(".") or name in consumed or name in merged:
                    continue
                merged[name] = collect(os.path.join(container, name), None)
        schema["properties"] = merged

    items = schema.get("prefixItems")
    if isinstance(items, list):
        out = []
        for idx, cprop in enumerate(items):
            child = os.path.join(container, child_name(cprop, str(idx)))
            out.append(collect(child, cprop) if os.path.exists(child) else cprop)
        schema["prefixItems"] = out

    return schema


def apply_parent_meta(schema: dict, parent_prop) -> dict:
    """Fold the parent's contextual metadata (description, file-name) onto a node."""
    if isinstance(parent_prop, dict):
        pxy = parent_prop.get("x-yamlover") or {}
        if "file-name" in pxy:
            schema.setdefault("x-yamlover", {})["file-name"] = pxy["file-name"]
        if "description" in parent_prop and "description" not in schema:
            schema = {"description": parent_prop["description"], **schema}
    return schema


def child_name(cprop, default: str) -> str:
    xy = (cprop.get("x-yamlover") if isinstance(cprop, dict) else None) or {}
    return xy.get("file-name") or default


def read_value(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except UnicodeDecodeError:
        return None  # binary file with no schema
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return text  # not YAML — treat as a plain text string


def infer_schema(value) -> dict:
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if value is None:
        return {"type": "null"}
    if isinstance(value, dict):
        return {"type": "object", "properties": {k: infer_schema(v) for k, v in value.items()}}
    if isinstance(value, list):
        return {"type": "array"}
    return {}


def main(argv):
    ap = argparse.ArgumentParser(
        description="Assemble a yamlover tree into one Yamlover JSON Schema."
    )
    ap.add_argument("path", nargs="?", default=".", help="entity to collect (default: .)")
    ap.add_argument(
        "-f", "--format", choices=["yaml", "json"], default="yaml",
        help="output format (default: yaml)",
    )
    args = ap.parse_args(argv[1:])
    if not os.path.exists(args.path):
        sys.exit(f"no such path: {args.path}")

    schema = collect(os.path.normpath(args.path))
    if args.format == "json":
        print(json.dumps(schema, indent=2, ensure_ascii=False))
    else:
        print(yaml.safe_dump(schema, sort_keys=False, allow_unicode=True).rstrip())


if __name__ == "__main__":
    main(sys.argv)
