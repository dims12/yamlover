/** THE chevron mark — the TOC toggle and the data view's fold gutter render this one component,
 *  so the two stay identical by construction. A geometric 2px stroke instead of the `›` glyph:
 *  the thin text glyph came out grayscale-antialiased fuzz beside the ClearType-sharp labels
 *  (and rasterized mid-rotation), while a vector stroke reads crisp at any angle. The wrapping
 *  `.chevron` span still carries the rotate/transition CSS. */
export function Chevron() {
  return (
    <span className="chevron" aria-hidden>
      <svg viewBox="0 0 20 20" width="20" height="20">
        {/* stroke 1.2 ≈ the 13px mono text's own stem weight, so the mark reads as one of the
            letters (1.5 and 2 both read visibly heavier against the light-stemmed mono font) */}
        <path d="M8 5.5 L13 10 L8 14.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
