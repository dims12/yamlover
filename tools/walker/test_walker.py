#!/usr/bin/env python3
"""Automated tests for walker, exercised against every entity in ``examples/``.

Run from anywhere:

    python -m unittest discover -s tools/walker      # from the repo root
    python tools/walker/test_walker.py               # directly
    pytest tools/walker/test_walker.py               # pytest also runs these

The tests are data-driven: the dictionaries below describe what each example
should materialize to, the concrete each node should report, and the schema it
should instantiate from — so adding an example means adding a row, not a test.
"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
EXAMPLES = os.path.normpath(os.path.join(HERE, "..", "..", "examples"))

import yaml  # noqa: E402  (after sys.path tweak)

import walker  # noqa: E402
from walker import Binary, Node  # noqa: E402

# --------------------------------------------------------------------------- #
# Expected data, keyed by example directory name
# --------------------------------------------------------------------------- #
OBJ = {"name": "Alice", "age": 30, "isAdmin": True}      # 01-04 hold this object
INT32_30 = (30).to_bytes(4, "little")                    # 09's binary age
with open(os.path.join(EXAMPLES, "12-image-with-markup",
                       "object_detection.png"), "rb") as _fh:
    PNG = _fh.read()
with open(os.path.join(EXAMPLES, "13-defs-and-refs",
                       "object_detection.png"), "rb") as _fh:
    PNG13 = _fh.read()                                    # 13's 1x1 placeholder
BOX = {"x": 25, "y": 40, "dx": 25, "dy": 40}
SWITCH = {                                                # 11's mid-tree switch
    "user": {"name": "Alice",
             "contact": {"email": "alice@example.com", "phone": "123-456-7890"}},
    "settings": {"theme": "dark", "notifications": True},
}

# Value of each example, as produced by ``to_plain(node, binary="bytes")``.
EXPECTED_INSTANCE = {
    "01-object-in-schema": OBJ,
    "02-object-in-yaml": OBJ,
    "03-object-in-json": OBJ,
    "04-object-in-dir": OBJ,
    "05-scalar-as-file": 30,
    "06-plain-dir": {"age": 30},
    "07-scalar-in-schema": 30,
    "08-scalar-file-overlay": 30,
    "09-scalar-as-binary": {"age": INT32_30},
    "10-array-of-files": ["Alice", 42, True],
    "11-switch-schema-file-yaml": SWITCH,
    "12-image-with-markup": {"object_detection.png": PNG, "markup": [BOX, BOX]},
    "13-defs-and-refs": {"object_detection.png": PNG13, "markup": [BOX, BOX]},
}

# The concrete reported at each example's root node (its filesystem-node kind).
EXPECTED_ROOT_CONCRETE = {
    "01-object-in-schema": "yamlover",
    "02-object-in-yaml": "yamlover",
    "03-object-in-json": "yamlover",
    "04-object-in-dir": "yamlover",
    "05-scalar-as-file": "file",
    "06-plain-dir": "dir",
    "07-scalar-in-schema": "yamlover",
    "08-scalar-file-overlay": "yamlover",
    "09-scalar-as-binary": "yamlover",
    "10-array-of-files": "yamlover",
    "11-switch-schema-file-yaml": "yamlover",
    "12-image-with-markup": "yamlover",
    "13-defs-and-refs": "yamlover",
}

# The concrete reported at a specific nested node (the value-location axis).
EXPECTED_CHILD_CONCRETE = [
    ("01-object-in-schema", ["name"], "yaml-schema/instantiate"),
    ("02-object-in-yaml", ["name"], "yaml"),
    ("03-object-in-json", ["name"], "json"),
    ("04-object-in-dir", ["name"], "file/yaml"),
    ("06-plain-dir", ["age"], "file"),
    ("09-scalar-as-binary", ["age"], "file/binary"),
    ("10-array-of-files", [0], "file/yaml"),
    ("10-array-of-files", [2], "file/json"),
    ("11-switch-schema-file-yaml", ["user", "name"], "yaml-schema/instantiate"),
    ("11-switch-schema-file-yaml", ["user", "contact"], "file/yaml"),
    ("12-image-with-markup", ["object_detection.png"], "file/binary"),
    ("12-image-with-markup", ["markup"], "yaml-schema/instantiate"),
    ("12-image-with-markup", ["markup", 0], "yaml-schema/instantiate"),
    ("12-image-with-markup", ["markup", 0, "x"], "yaml-schema/instantiate"),
    ("13-defs-and-refs", ["markup", 0, "x"], "yaml-schema/instantiate"),
]

# Examples whose subtree contains a binary leaf (no JSON form).
BINARY_EXAMPLES = {"09-scalar-as-binary", "12-image-with-markup", "13-defs-and-refs"}

# A couple of fully spelled-out instantiate schemas.
OBJ_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"const": "Alice"},
        "age": {"const": 30},
        "isAdmin": {"const": True},
    },
}
ARRAY_SCHEMA = {
    "type": "array",
    "prefixItems": [{"const": "Alice"}, {"const": 42}, {"const": True}],
    "items": False,
}


def load(name):
    return walker.load_entity(os.path.join(EXAMPLES, name))


def strip_xy(schema):
    """Recursively drop ``x-yamlover`` blocks, leaving the const/type skeleton."""
    if isinstance(schema, dict):
        return {k: strip_xy(v) for k, v in schema.items() if k != "x-yamlover"}
    if isinstance(schema, list):
        return [strip_xy(x) for x in schema]
    return schema


# --------------------------------------------------------------------------- #
# Materialization: the value each example resolves to
# --------------------------------------------------------------------------- #
class TestMaterialization(unittest.TestCase):
    def test_examples_dir_present(self):
        self.assertTrue(os.path.isdir(EXAMPLES), EXAMPLES)
        for name in EXPECTED_INSTANCE:
            self.assertTrue(os.path.exists(os.path.join(EXAMPLES, name)), name)

    def test_value(self):
        for name, expected in EXPECTED_INSTANCE.items():
            with self.subTest(example=name):
                got = walker.to_plain(load(name), binary="bytes")
                self.assertEqual(got, expected)

    def test_binary_leaf_int32(self):
        age = load("09-scalar-as-binary").value["age"].value
        self.assertIsInstance(age, Binary)
        self.assertEqual(age.fmt, "int32/le")
        self.assertEqual(age.decoded, 30)
        self.assertEqual(len(age.data), 4)

    def test_binary_leaf_png(self):
        img = load("12-image-with-markup").value["object_detection.png"].value
        self.assertIsInstance(img, Binary)
        self.assertEqual(img.fmt, "image/png")
        self.assertEqual(img.data, PNG)

    def test_storage_independent_value(self):
        # 01-04 store the same object four ways; all materialize identically.
        same = [walker.to_plain(load(n)) for n in
                ("01-object-in-schema", "02-object-in-yaml",
                 "03-object-in-json", "04-object-in-dir")]
        self.assertEqual(same[1:], same[:-1])


# --------------------------------------------------------------------------- #
# Concrete taxonomy
# --------------------------------------------------------------------------- #
class TestConcrete(unittest.TestCase):
    def test_root_concrete(self):
        for name, expected in EXPECTED_ROOT_CONCRETE.items():
            with self.subTest(example=name):
                self.assertEqual(load(name).concrete, expected)

    def test_child_concrete(self):
        for name, segs, expected in EXPECTED_CHILD_CONCRETE:
            with self.subTest(example=name, path=segs):
                node = walker.get_node(load(name), segs)
                self.assertEqual(node.concrete, expected)

    def test_interior_helper(self):
        self.assertEqual(walker.interior("file/json"), "json")
        self.assertEqual(walker.interior("file/yaml"), "yaml")
        self.assertEqual(walker.interior("file/binary"), "yaml")
        self.assertEqual(walker.interior(None), "yaml")


# --------------------------------------------------------------------------- #
# Extra (undescribed) entries / the inline-object leak fix
# --------------------------------------------------------------------------- #
class TestExtras(unittest.TestCase):
    def test_inline_object_does_not_adopt_siblings(self):
        # A markup item is an inline schema object; it must NOT pick up the
        # directory's object_detection.png as a stray child.
        box = walker.get_node(load("12-image-with-markup"), ["markup", 0])
        self.assertEqual(set(box.value), {"x", "y", "dx", "dy"})

    def test_undescribed_file_surfaced_at_dir_root(self):
        # examples/ has no .yamlover, so it is a plain dir; README.md shows up.
        root = walker.load_entity(EXAMPLES)
        self.assertEqual(root.concrete, "dir")
        self.assertIn("README.md", root.value)
        self.assertEqual(root.value["README.md"].concrete, "file")

    def test_nested_claimed_file_not_surfaced(self):
        # continuation.yaml is claimed by user.contact (a mid-tree switch to
        # file/yaml); it must not also appear as a stray root key.
        root = load("11-switch-schema-file-yaml")
        self.assertEqual(set(root.value), {"user", "settings"})
        self.assertNotIn("continuation.yaml", root.value)


# --------------------------------------------------------------------------- #
# Serialization: json / yaml commands
# --------------------------------------------------------------------------- #
class TestSerialization(unittest.TestCase):
    def test_yaml_roundtrips_to_value(self):
        for name, expected in EXPECTED_INSTANCE.items():
            with self.subTest(example=name):
                self.assertEqual(yaml.safe_load(walker.to_yaml(load(name))),
                                 expected)

    def test_json_roundtrips_to_value(self):
        for name, expected in EXPECTED_INSTANCE.items():
            if name in BINARY_EXAMPLES:
                continue
            with self.subTest(example=name):
                self.assertEqual(json.loads(walker.to_json(load(name))),
                                 expected)

    def test_json_on_binary_raises(self):
        for name in BINARY_EXAMPLES:
            with self.subTest(example=name):
                with self.assertRaises(ValueError) as ctx:
                    walker.to_json(load(name))
                self.assertIn("binary", str(ctx.exception))

    def test_scalar_yaml_has_no_document_marker(self):
        self.assertEqual(walker.to_yaml(load("05-scalar-as-file")), "30")
        self.assertNotIn("...", walker.to_yaml(load("05-scalar-as-file")))

    def test_yaml_scalar_leaf_types(self):
        root = load("04-object-in-dir")
        self.assertEqual(walker.to_yaml(root.value["name"]), "Alice")
        self.assertEqual(walker.to_yaml(root.value["isAdmin"]), "true")
        self.assertEqual(walker.to_yaml(root.value["age"]), "30")


# --------------------------------------------------------------------------- #
# Serialization: the instantiate-schema commands
# --------------------------------------------------------------------------- #
class TestSchemaInstantiate(unittest.TestCase):
    # The const/type *skeleton* (x-yamlover stripped) is what these assert; the
    # x-yamlover provenance is checked separately in TestProvenance.
    def test_object_schema(self):
        self.assertEqual(strip_xy(walker.to_schema(load("04-object-in-dir"))),
                         OBJ_SCHEMA)

    def test_array_schema(self):
        self.assertEqual(strip_xy(walker.to_schema(load("10-array-of-files"))),
                         ARRAY_SCHEMA)

    def test_skeleton_is_storage_independent(self):
        # 01-04 store the same object four ways; the skeleton is identical even
        # though the x-yamlover provenance differs (that is the point).
        for name in ("01-object-in-schema", "02-object-in-yaml",
                     "03-object-in-json", "04-object-in-dir"):
            with self.subTest(example=name):
                self.assertEqual(strip_xy(walker.to_schema(load(name))), OBJ_SCHEMA)

    def test_yaml_schema_parses_back(self):
        for name in EXPECTED_INSTANCE:
            with self.subTest(example=name):
                text = walker.to_yaml_schema(load(name))
                self.assertEqual(yaml.safe_load(text),
                                 walker.to_schema(load(name)))

    def test_json_schema_on_binary_raises(self):
        for name in BINARY_EXAMPLES:
            with self.subTest(example=name):
                with self.assertRaises(ValueError):
                    walker.to_json_schema(load(name))

    def test_json_schema_object(self):
        self.assertEqual(
            strip_xy(json.loads(walker.to_json_schema(load("04-object-in-dir")))),
            OBJ_SCHEMA)

    def test_binary_pins_as_const_in_yaml_schema(self):
        age = walker.to_schema(load("09-scalar-as-binary"))["properties"]["age"]
        self.assertEqual(age["const"], INT32_30)
        self.assertEqual(age["x-yamlover"]["concrete"], "file/binary")


# --------------------------------------------------------------------------- #
# x-yamlover provenance (concrete + os) in the instantiate schema
# --------------------------------------------------------------------------- #
class TestProvenance(unittest.TestCase):
    def test_file_node_records_os(self):
        name = walker.to_schema(load("04-object-in-dir"))["properties"]["name"]
        self.assertEqual(name["x-yamlover"]["concrete"], "file/yaml")
        self.assertEqual(
            name["x-yamlover"]["os"],
            walker.os_info(os.path.join(EXAMPLES, "04-object-in-dir", "name")))
        # os carries path, size, mtime for a file
        self.assertEqual(name["x-yamlover"]["os"]["path"], "name")
        self.assertEqual(name["x-yamlover"]["os"]["size"], 7)
        self.assertIn("mtime", name["x-yamlover"]["os"])

    def test_dir_node_os_has_no_size(self):
        xy = walker.to_schema(load("04-object-in-dir"))["x-yamlover"]
        self.assertEqual(xy["concrete"], "yamlover")
        self.assertEqual(xy["os"]["path"], "04-object-in-dir")
        self.assertNotIn("size", xy["os"])

    def test_pinned_node_has_no_xy(self):
        # values pinned in the schema have no filesystem provenance
        name = walker.to_schema(load("01-object-in-schema"))["properties"]["name"]
        self.assertNotIn("x-yamlover", name)

    def test_collapsed_file_interior_has_no_xy(self):
        # children living inside a collapsed yaml file have no own path
        name = walker.to_schema(load("02-object-in-yaml"))["properties"]["name"]
        self.assertNotIn("x-yamlover", name)

    def test_elided_dir_still_reports_os(self):
        # at the depth cutoff a dir degrades to {type: object} but keeps x-yamlover
        schema = walker.to_schema(load("04-object-in-dir"), depth=0)
        self.assertEqual(schema["type"], "object")
        self.assertNotIn("properties", schema)
        self.assertEqual(schema["x-yamlover"]["concrete"], "yamlover")

    def test_xy_path_helper(self):
        self.assertEqual(walker.xy_path({"os": {"path": "f.yaml"}}), "f.yaml")
        self.assertIsNone(walker.xy_path({"os": {}}))
        self.assertIsNone(walker.xy_path({}))

    def test_os_info_fields(self):
        f = walker.os_info(os.path.join(EXAMPLES, "04-object-in-dir", "age"))
        self.assertEqual(f["path"], "age")
        self.assertEqual(f["size"], 2)
        self.assertRegex(f["mtime"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        d = walker.os_info(os.path.join(EXAMPLES, "04-object-in-dir"))
        self.assertNotIn("size", d)


# --------------------------------------------------------------------------- #
# $defs / $ref resolution (schema coordinates)
# --------------------------------------------------------------------------- #
class TestRefs(unittest.TestCase):
    def test_example12_matches_example11(self):
        # 12 pulls each region in via $ref; it resolves to the same value as 11.
        m11 = walker.to_plain(load("12-image-with-markup").value["markup"])
        m12 = walker.to_plain(load("13-defs-and-refs").value["markup"])
        self.assertEqual(m12, m11)
        self.assertEqual(m12, [BOX, BOX])

    def test_ref_merges_shape_and_inlined_const(self):
        # the referenced rectangular-area shape + inlined consts both apply
        box = walker.get_node(load("13-defs-and-refs"), ["markup", 0])
        self.assertEqual(walker.to_plain(box), BOX)

    def test_defs_not_materialized(self):
        # $defs is a sibling of properties, never surfaced as data
        self.assertEqual(set(load("13-defs-and-refs").value),
                         {"object_detection.png", "markup"})

    def test_resolve_ref_to_defs(self):
        root = {"$defs": {"r": {"type": "object"}}}
        self.assertEqual(walker.resolve_ref("#/$defs/r", root), {"type": "object"})

    def test_resolve_ref_to_any_location(self):
        # not limited to #/$defs/... — any JSON Pointer into the document
        root = {"properties": {"a": {"const": 1}}, "prefixItems": [{"const": 9}]}
        self.assertEqual(walker.resolve_ref("#/properties/a", root), {"const": 1})
        self.assertEqual(walker.resolve_ref("#/prefixItems/0", root), {"const": 9})
        self.assertEqual(walker.resolve_ref("#", root), root)

    def test_resolve_ref_errors(self):
        with self.assertRaises(KeyError):
            walker.resolve_ref("#/$defs/missing", {"$defs": {}})
        with self.assertRaises(ValueError):
            walker.resolve_ref("other.json#/x", {})

    def test_merge_schema_deep(self):
        merged = walker.merge_schema(
            {"type": "object", "properties": {"x": {"type": "integer"}}},
            {"description": "bus", "properties": {"x": {"const": 25}}})
        self.assertEqual(merged, {
            "type": "object", "description": "bus",
            "properties": {"x": {"type": "integer", "const": 25}}})


# --------------------------------------------------------------------------- #
# The dual property: instantiate schema -> instance round-trips
# --------------------------------------------------------------------------- #
class TestRoundTrip(unittest.TestCase):
    def test_schema_materializes_back_to_instance(self):
        # The schema↔instance invariant is about the const *skeleton*; the
        # x-yamlover.os block is provenance (and for a collapsed-file node would
        # point resolve back at a file absent from the temp dir), so strip it.
        for name in EXPECTED_INSTANCE:
            with self.subTest(example=name):
                orig = load(name)
                schema = strip_xy(walker.to_schema(orig))
                with tempfile.TemporaryDirectory() as d:
                    os.makedirs(os.path.join(d, "x", ".yamlover"))
                    with open(os.path.join(d, "x", ".yamlover", "schema.yaml"),
                              "w", encoding="utf-8") as fh:
                        yaml.safe_dump(schema, fh, sort_keys=False,
                                       allow_unicode=True)
                    rebuilt = walker.load_entity(os.path.join(d, "x"))
                self.assertEqual(walker.to_plain(rebuilt, binary="bytes"),
                                 walker.to_plain(orig, binary="bytes"))


# --------------------------------------------------------------------------- #
# Navigation: navigate / child_key / format_path / get_node
# --------------------------------------------------------------------------- #
class TestNavigation(unittest.TestCase):
    def setUp(self):
        self.root = load("12-image-with-markup")

    def test_relative_path_with_index(self):
        self.assertEqual(walker.navigate(self.root, [], "markup[0]/x"),
                         ["markup", 0, "x"])

    def test_index_token_from_array(self):
        self.assertEqual(walker.navigate(self.root, ["markup"], "[0]"),
                         ["markup", 0])
        self.assertEqual(walker.navigate(self.root, ["markup"], "0"),
                         ["markup", 0])

    def test_parent_and_root(self):
        self.assertEqual(walker.navigate(self.root, ["markup", 0], ".."),
                         ["markup"])
        self.assertEqual(walker.navigate(self.root, ["markup", 0], "/"), [])
        self.assertEqual(walker.navigate(self.root, ["markup", 0], None), [])

    def test_bad_key_raises(self):
        with self.assertRaises(KeyError):
            walker.navigate(self.root, [], "nope")

    def test_index_out_of_range_raises(self):
        with self.assertRaises((KeyError, IndexError)):
            walker.navigate(self.root, ["markup"], "[9]")

    def test_format_path(self):
        self.assertEqual(walker.format_path([]), "/")
        self.assertEqual(walker.format_path(["markup", 0, "x"]), "/markup[0]/x")
        self.assertEqual(walker.format_path(["a", "b"]), "/a/b")

    def test_child_key(self):
        markup = self.root.value["markup"]
        self.assertEqual(walker.child_key(markup, "[1]"), 1)
        self.assertEqual(walker.child_key(markup, "1"), 1)
        self.assertEqual(walker.child_key(self.root, "markup"), "markup")
        with self.assertRaises(KeyError):
            walker.child_key(self.root, "missing")
        with self.assertRaises(KeyError):
            walker.child_key(markup, "[9]")


# --------------------------------------------------------------------------- #
# Depth limiting
# --------------------------------------------------------------------------- #
class TestDepth(unittest.TestCase):
    def test_instance_elides_containers_beyond_depth(self):
        node = load("12-image-with-markup").value["markup"]   # an array of objects
        # depth 1: the array is shown, its object items elided
        self.assertEqual(walker.to_plain(node, depth=1), ["{...}", "{...}"])
        # depth 2: items fully expanded
        self.assertEqual(walker.to_plain(node, depth=2), [BOX, BOX])
        # depth 0: the array itself elided
        self.assertEqual(walker.to_plain(node, depth=0), "[...]")

    def test_object_elides_to_brace_placeholder(self):
        node = load("01-object-in-schema")
        self.assertEqual(walker.to_plain(node, depth=0), "{...}")
        self.assertEqual(walker.to_plain(node, depth=1), OBJ)  # scalars at level 1

    def test_none_depth_is_unlimited(self):
        node = load("12-image-with-markup").value["markup"]
        self.assertEqual(walker.to_plain(node, depth=None),
                         walker.to_plain(node))

    def test_schema_degrades_to_type_only(self):
        node = load("12-image-with-markup").value["markup"]
        self.assertEqual(walker.to_schema(node, depth=0), {"type": "array"})
        self.assertEqual(
            walker.to_schema(node, depth=1),
            {"type": "array", "prefixItems": [{"type": "object"},
                                              {"type": "object"}], "items": False})

    def test_json_yaml_wrappers_pass_depth(self):
        node = load("12-image-with-markup").value["markup"]
        self.assertEqual(json.loads(walker.to_json(node, depth=1)),
                         ["{...}", "{...}"])
        self.assertEqual(yaml.safe_load(walker.to_yaml(node, depth=0)), "[...]")
        self.assertEqual(
            yaml.safe_load(walker.to_yaml_schema(node, depth=0)), {"type": "array"})
        self.assertEqual(
            json.loads(walker.to_json_schema(node, depth=0)), {"type": "array"})


class TestParseSerializeArg(unittest.TestCase):
    def test_path_only(self):
        self.assertEqual(walker.parse_serialize_arg("markup[0]"), ("markup[0]", None))

    def test_no_arg(self):
        self.assertEqual(walker.parse_serialize_arg(None), (None, None))

    def test_depth_flag_forms(self):
        for arg in ("--depth 2", "--depth=2", "-d 2", "-d2"):
            with self.subTest(arg=arg):
                self.assertEqual(walker.parse_serialize_arg(arg), (None, 2))

    def test_path_and_depth(self):
        self.assertEqual(walker.parse_serialize_arg("markup --depth 1"),
                         ("markup", 1))
        self.assertEqual(walker.parse_serialize_arg("-d 1 markup"), ("markup", 1))

    def test_errors(self):
        for bad in ("--depth two", "--depth", "--bogus", "a b", "-d -1"):
            with self.subTest(arg=bad):
                with self.assertRaises(ValueError):
                    walker.parse_serialize_arg(bad)


# --------------------------------------------------------------------------- #
# Small unit helpers
# --------------------------------------------------------------------------- #
class TestHelpers(unittest.TestCase):
    def test_type_label(self):
        self.assertEqual(walker.type_label(Node({})), "object")
        self.assertEqual(walker.type_label(Node([])), "array")
        self.assertEqual(walker.type_label(Node(True)), "boolean")
        self.assertEqual(walker.type_label(Node(7)), "integer")
        self.assertEqual(walker.type_label(Node(1.5)), "number")
        self.assertEqual(walker.type_label(Node("s")), "string")
        self.assertEqual(walker.type_label(Node(None)), "null")
        self.assertEqual(walker.type_label(Node(Binary(b"\x00"))), "binary")

    def test_wrap_tags_every_level(self):
        node = walker.wrap({"a": [1, 2]}, "yaml")
        self.assertEqual(node.concrete, "yaml")
        self.assertEqual(node.value["a"].concrete, "yaml")
        self.assertEqual(node.value["a"].value[0].concrete, "yaml")


if __name__ == "__main__":
    unittest.main(verbosity=2)
