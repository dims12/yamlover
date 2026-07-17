using OneNote2Yamlover.Core.Text;
using Xunit;

namespace OneNote2Yamlover.Core.Tests;

/// <summary>
/// These assertions are ported from the PowerShell harness that validated the prototype. Each one
/// corresponds to a bug that actually shipped and was caught against the live yamlover engine.
/// </summary>
public class MarklowerTests
{
    // OneNote puts the separating space INSIDE the <a>; Trim()-ing it produced "](url)plus the [".
    [Fact]
    public void TrailingSpaceInsideAnchorIsHoistedOut() => Assert.Equal(
        "your [proof of identity](https://rdw.nl/x) plus the [import document](https://bd.nl/y) on which",
        Marklower.FromHtml(
            "your <a href=\"https://rdw.nl/x\">proof of identity </a>plus the " +
            "<a href=\"https://bd.nl/y\">import document </a>on which"));

    [Fact]
    public void LeadingSpaceInsideAnchorIsHoistedOut() =>
        Assert.Equal("see [the docs](u).", Marklower.FromHtml("see<a href=\"u\"> the docs</a>."));

    [Fact]
    public void NoSurroundingSpaceIsPreservedAsIs() =>
        Assert.Equal("a [link](u) b", Marklower.FromHtml("a <a href=\"u\">link</a> b"));

    [Fact]
    public void WhitespaceOnlyAnchorEmitsNoLabel() =>
        Assert.Equal("a b", Marklower.FromHtml("a<a href=\"u\"> </a>b"));

    // Trim() also strips U+00A0; hoisting must preserve it.
    [Fact]
    public void NonBreakingSpaceInsideAnchorSurvives() =>
        Assert.Equal("x [label](u) y", Marklower.FromHtml("x <a href=\"u\">label&nbsp;</a>y"));

    [Fact]
    public void LinkAndBoldCompose() => Assert.Equal("[l](u) **B**",
        Marklower.FromHtml("<a href=\"u\">l </a><span style=\"font-weight:bold\">B</span>"));

    [Fact]
    public void ItalicAndStrikeAndBreak() => Assert.Equal("*i* ~~s~~\nnext",
        Marklower.FromHtml("<span style=\"font-style:italic\">i</span> " +
                           "<span style=\"text-decoration:line-through\">s</span><br/>next"));

    [Fact]
    public void EmptyInputYieldsEmpty() => Assert.Equal("", Marklower.FromHtml(null));
}

public class NamesTests
{
    // A `[` in a child name makes the yamlover engine resolve it to null and 400 the whole parent.
    [Theory]
    [InlineData("Teamviewer - ve[kzirf77 (x)", "Teamviewer - ve-kzirf77 (x)")]
    [InlineData("a]b", "a-b")]
    [InlineData("e[1]f", "e-1-f")]
    public void BracketsAreReplaced(string input, string expected) =>
        Assert.Equal(expected, Names.Sanitize(input));

    [Theory]
    [InlineData("a<b>c:d\"e/f\\g|h?i*j", "a-b-c-d-e-f-g-h-i-j")]
    [InlineData("  spaced   out  ", "spaced out")]
    [InlineData("trailing dots...", "trailing dots")]
    [InlineData("", "Untitled")]
    [InlineData("   ", "Untitled")]
    [InlineData("CON", "_CON")]
    [InlineData("LPT3", "_LPT3")]
    public void SanitizeRules(string input, string expected) => Assert.Equal(expected, Names.Sanitize(input));

    [Fact]
    public void ControlCharactersBecomeSpaces() => Assert.Equal("a b", Names.Sanitize("a\tb"));

    [Fact]
    public void CapsAtSixtyChars() => Assert.Equal(60, Names.Sanitize(new string('a', 95)).Length);

    // A page title's trailing ".2 notes" is NOT an extension.
    [Fact]
    public void TitleDotsAreNotTreatedAsExtension() => Assert.Equal(
        "Version 1.2 notes about the thing that goes on and on and on",
        Names.Sanitize("Version 1.2 notes about the thing that goes on and on and on and on forever"));

    [Fact]
    public void AttachmentExtensionIsPreservedWhenTruncating()
    {
        string s = Names.Sanitize(new string('a', 90) + ".3gp", keepExtension: true);
        Assert.EndsWith(".3gp", s);
        Assert.Equal(60, s.Length);
    }

    [Fact]
    public void CyrillicAttachmentNameSurvives() =>
        Assert.Equal("Звукозапись.3gp", Names.Sanitize("Звукозапись.3gp", keepExtension: true));

    [Fact]
    public void UniqueDedupesCaseInsensitivelyWithSuffix()
    {
        var used = Names.NewUsedSet();
        Assert.Equal("Untitled.yamlover", Names.Unique(used, "Untitled", ".yamlover"));
        Assert.Equal("Untitled (2).yamlover", Names.Unique(used, "Untitled", ".yamlover"));
        // Collision detection is case-insensitive, but the caller's casing is preserved verbatim.
        Assert.Equal("untitled (3).yamlover", Names.Unique(used, "untitled", ".yamlover"));
    }

    /// <summary>A page-dir and a leaf page file share the used-set, but not the same key.</summary>
    [Fact]
    public void DirectoryAndFileNamesDedupeIndependently()
    {
        var used = Names.NewUsedSet();
        Assert.Equal("Untitled", Names.Unique(used, "Untitled", ""));
        Assert.Equal("Untitled.yamlover", Names.Unique(used, "Untitled", ".yamlover"));
    }
}

public class YamlTests
{
    [Theory]
    [InlineData("Untitled.yamlover", "Untitled.yamlover")]
    [InlineData("dogs", "dogs")]
    [InlineData("image-1a2b3c4d.png", "image-1a2b3c4d.png")]
    [InlineData("brace{x}.yamlover", "brace{x}.yamlover")]
    [InlineData("comma,name.yamlover", "comma,name.yamlover")]
    [InlineData("dollar$defs.yamlover", "dollar$defs.yamlover")]
    public void BareKeysStayBare(string input, string expected) =>
        Assert.Equal(expected, Yaml.EscapePointer(input));

    // Verified against the real parser: all of these round-trip byte-for-byte.
    [Theory]
    [InlineData("Change license plates Netherlands.yamlover", "\"Change license plates Netherlands.yamlover\"")]
    [InlineData("Untitled (2).yamlover", "\"Untitled (2).yamlover\"")]
    [InlineData("Номер машины R960XK.yamlover", "\"Номер машины R960XK.yamlover\"")]
    [InlineData("a#b.yamlover", "\"a#b.yamlover\"")]
    [InlineData("weird [1] name.yamlover", "\"weird [1] name.yamlover\"")]
    [InlineData("colon:name.yamlover", "\"colon:name.yamlover\"")]
    [InlineData("back\\slash.yamlover", "\"back\\\\slash.yamlover\"")]
    [InlineData("quote\"dq.yamlover", "\"quote\\\"dq.yamlover\"")]
    [InlineData("star*name.yamlover", "\"star*name.yamlover\"")]
    public void UnsafeKeysAreQuoted(string input, string expected) =>
        Assert.Equal(expected, Yaml.EscapePointer(input));

    // A bare `..` is the parent selector, so an all-dots key must be quoted.
    [Theory]
    [InlineData("..", "\"..\"")]
    [InlineData(".", "\".\"")]
    [InlineData("...", "\"...\"")]
    public void AllDotsKeysAreQuoted(string input, string expected) =>
        Assert.Equal(expected, Yaml.EscapePointer(input));

    [Theory]
    [InlineData("Автомобиль", "Автомобиль")]
    [InlineData("Change license plates", "Change license plates")]
    [InlineData("has: colon", "\"has: colon\"")]
    [InlineData("has # hash", "\"has # hash\"")]
    [InlineData("*starts-with-star", "\"*starts-with-star\"")]
    [InlineData(" leading space", "\" leading space\"")]
    public void ScalarQuoting(string input, string expected) => Assert.Equal(expected, Yaml.Scalar(input));

    [Fact]
    public void NullScalarIsEmptyQuoted() => Assert.Equal("\"\"", Yaml.Scalar(null));

    /// <summary>Flow-cell quoting (MARKLOWER.md): plain only when the flow lexer takes the token
    /// whole; else single-quoted, <c>''</c> doubling (the one escape the parser reads).</summary>
    [Theory]
    [InlineData("Alice", "Alice")]
    [InlineData("Designer, UX", "'Designer, UX'")]
    [InlineData("say \"hi\"", "'say \"hi\"'")]
    [InlineData("it's", "'it''s'")]
    [InlineData("", "''")]
    [InlineData("**Motor** vehicle", "'**Motor** vehicle'")] // opens with the deref sigil `*`
    [InlineData("a:b", "'a:b'")]
    [InlineData("[.-1]", "'[.-1]'")]
    [InlineData(" pad ", "' pad '")]
    public void FlowCellQuoting(string input, string expected) => Assert.Equal(expected, Yaml.FlowCell(input));
}

public class MimeTests
{
    [Theory]
    [InlineData("Zvukozapis.3gp", "audio/3gpp")]
    [InlineData("image-aa.png", "image/png")]
    [InlineData("Doc.PDF", "application/pdf")]
    [InlineData("rec.m4a", "audio/mp4")]
    [InlineData("thing.xyzzy", "application/octet-stream")]
    [InlineData("noext", "application/octet-stream")]
    public void FromName(string name, string expected) => Assert.Equal(expected, Mime.FromName(name));

    [Theory]
    [InlineData("image/png", ".png")]
    [InlineData("image/jpeg", ".jpg")]
    [InlineData(null, ".png")]
    public void ExtFromFormat(string? fmt, string expected) => Assert.Equal(expected, Mime.ExtFromFormat(fmt));

    [Fact]
    public void ShortHashIsEightHexChars()
    {
        string h = Mime.ShortHash([1, 2, 3]);
        Assert.Equal(8, h.Length);
        Assert.Matches("^[0-9a-f]{8}$", h);
    }
}
