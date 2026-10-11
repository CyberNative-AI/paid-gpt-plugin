// The converted GPT: its instructions ("playbook") and knowledge, bundled into the Worker
// by tools/convert.mjs. Nothing here is shipped in the plugin ZIP.
import content from "./generated/content.json";

export interface Chunk { doc: string; title: string; section: string; text: string }
export interface Content {
  name: string;
  creator: string;
  supportURL: string;
  playbook: string;
  documents: { id: string; title: string }[];
  chunks: Chunk[];
}

export const CONTENT = content as Content;

const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Small BM25 over section-sized chunks: enough for a GPT's knowledge files.
const docs = CONTENT.chunks.map((c) => tokenize(`${c.title} ${c.section} ${c.text}`));
const avgLength = docs.reduce((n, d) => n + d.length, 0) / Math.max(docs.length, 1);
const documentFrequency = new Map<string, number>();
for (const d of docs) for (const term of new Set(d)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);

export function search(query: string, limit = 3): (Chunk & { score: number })[] {
  const terms = [...new Set(tokenize(query))];
  const k1 = 1.2, b = 0.75, n = docs.length;
  return docs
    .map((d, i) => {
      let score = 0;
      for (const term of terms) {
        const tf = d.filter((t) => t === term).length;
        if (!tf) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLength)));
      }
      return { ...CONTENT.chunks[i], score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

export function readSection(doc: string, section?: string): Chunk[] {
  return CONTENT.chunks.filter((c) => c.doc === doc && (!section || c.section.toLowerCase() === section.toLowerCase()));
}
