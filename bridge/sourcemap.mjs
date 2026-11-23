// Minimal source-map reader: VLQ decode, original<->generated lookups.
// Enough for breakpoints in Angular dev builds (ng serve source maps).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function decodeVlqSegment(str, pos) {
  // returns [values[], newPos]
  const values = [];
  let value = 0, shift = 0;
  while (pos < str.length) {
    const ch = str[pos];
    if (ch === ',' || ch === ';') break;
    const digit = B64_INDEX.get(ch);
    pos++;
    if (digit === undefined) continue;
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) { shift += 5; continue; }
    const neg = value & 1;
    value >>>= 1;
    values.push(neg ? -value : value);
    value = 0; shift = 0;
  }
  return [values, pos];
}

/** Normalise a path for comparison: forward slashes, lower case, no scheme/prefix noise. */
export function normPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^webpack:\/\/\/?/, '')
    .replace(/^file:\/\/\/?/, '')
    .replace(/^\.\//, '')
    .replace(/\?.*$/, '')
    .toLowerCase();
}

export class SourceMap {
  constructor(json, mapUrl) {
    const m = typeof json === 'string' ? JSON.parse(json) : json;
    this.mapUrl = mapUrl;
    const root = m.sourceRoot ? m.sourceRoot.replace(/\/?$/, '/') : '';
    this.sources = (m.sources || []).map((s) => root + s);
    this.contents = m.sourcesContent || [];
    this.normSources = this.sources.map(normPath);
    // generated-ordered segments: [genLine, genCol, srcIdx, srcLine, srcCol]
    this.segments = [];
    const mappings = m.mappings || '';
    let genLine = 0, genCol = 0, src = 0, srcLine = 0, srcCol = 0;
    let pos = 0;
    while (pos < mappings.length) {
      const ch = mappings[pos];
      if (ch === ';') { genLine++; genCol = 0; pos++; continue; }
      if (ch === ',') { pos++; continue; }
      const [v, np] = decodeVlqSegment(mappings, pos);
      pos = np;
      if (v.length === 0) continue;
      genCol += v[0];
      if (v.length >= 4) {
        src += v[1]; srcLine += v[2]; srcCol += v[3];
        this.segments.push([genLine, genCol, src, srcLine, srcCol]);
      }
    }
    // index by source for original->generated
    this.bySource = new Map();
    for (const seg of this.segments) {
      let arr = this.bySource.get(seg[2]);
      if (!arr) this.bySource.set(seg[2], (arr = []));
      arr.push(seg);
    }
    for (const arr of this.bySource.values()) arr.sort((a, b) => a[3] - b[3] || a[4] - b[4]);
  }

  /** Index of the source whose path ends with `file` (normalised suffix match). */
  findSource(file) {
    const want = normPath(file);
    let best = -1, bestLen = Infinity;
    this.normSources.forEach((s, i) => {
      if (s === want || s.endsWith('/' + want) || want.endsWith('/' + s) || s.endsWith(want)) {
        if (s.length < bestLen) { best = i; bestLen = s.length; }
      }
    });
    return best;
  }

  /** Original (0-based line) -> first generated location on that line or the next mapped one. */
  generatedFor(srcIdx, line0) {
    const arr = this.bySource.get(srcIdx);
    if (!arr) return null;
    let cand = null;
    for (const seg of arr) {
      if (seg[3] === line0) { if (!cand || seg[0] < cand[0] || (seg[0] === cand[0] && seg[1] < cand[1])) cand = seg; }
      else if (seg[3] > line0) { if (!cand) cand = seg; break; }
    }
    if (!cand) return null;
    return { line: cand[0], column: cand[1], actualSourceLine: cand[3] };
  }

  /** Generated (0-based) -> original { source, line (0-based), column } */
  originalFor(genLine, genCol) {
    // binary search last segment <= (genLine, genCol)
    const s = this.segments;
    let lo = 0, hi = s.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = s[mid];
      if (seg[0] < genLine || (seg[0] === genLine && seg[1] <= genCol)) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return null;
    const seg = s[found];
    if (seg[0] !== genLine) {
      // allow falling back to the previous line's last mapping
      if (genLine - seg[0] > 2) return null;
    }
    return { source: this.sources[seg[2]], src: seg[2], line: seg[3], column: seg[4] };
  }

  /** The original text of source `src`, when the map embeds it (sourcesContent). */
  contentOf(src) { return typeof this.contents[src] === 'string' ? this.contents[src] : null; }
}

/** Lines around 1-based `line` of `text`, for the pane's source view. */
export function snippet(text, line, path, before = 6, after = 6) {
  if (typeof text !== 'string' || !line) return null;
  const all = text.split(/\r?\n/);
  const startLine = Math.max(1, line - before);
  const lines = all.slice(startLine - 1, Math.min(all.length, line + after)).map((l) => l.replace(/\t/g, '  ').slice(0, 240));
  return lines.length ? { path, line, startLine, lines } : null;
}
