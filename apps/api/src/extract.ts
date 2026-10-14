// Document and image uploads become datasets as extracted text: one row per
// page, paragraph or line, so the normal ingest path can profile and snapshot
// them like a table. Extraction runs in the app, not the sandboxed executor.
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { extname } from "node:path";
import { z } from "zod";
import { AppError, assert } from "./security.js";

export const documentExtensions = [
  ".txt",
  ".md",
  ".pdf",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".tif",
  ".tiff",
  ".bmp",
  ".gif",
];
export const isDocumentFile = (name: string) =>
  documentExtensions.includes(extname(name).toLowerCase());
export const acceptedExtensions = [
  ".csv",
  ".json",
  ".jsonl",
  ".parquet",
  ...documentExtensions,
];
export const acceptedFileTypes =
  "CSV, JSON, JSONL, Parquet, PDF, DOCX, TXT, MD or an image (PNG, JPG, WEBP, TIFF, BMP, GIF)";

type Row = { page: number; text: string };
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

async function* textFileRows(path: string): AsyncIterable<Row> {
  let page = 0;
  for await (const line of createInterface({ input: createReadStream(path) })) {
    const text = clean(line);
    if (text) yield { page: ++page, text };
  }
}
async function* pdfRows(path: string): AsyncIterable<Row> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: true,
  });
  const doc = await task.promise;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const text = clean(
        items.map((i) => ("str" in i ? i.str : "")).join(" "),
      );
      if (text) yield { page: p, text };
    }
  } finally {
    await task.destroy();
  }
}
async function* docxRows(path: string): AsyncIterable<Row> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ path });
  let page = 0;
  for (const para of value.split(/\n+/)) {
    const text = clean(para);
    if (text) yield { page: ++page, text };
  }
}
async function* imageRows(path: string): AsyncIterable<Row> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(path);
    const text = clean(data.text);
    if (text) yield { page: 1, text };
  } finally {
    await worker.terminate();
  }
}
// Writes JSONL rows {page, text} to `to`; `page` is the PDF page, paragraph or
// line number, or 1 for an image. Throws a user-readable error when the file
// yields no text (scanned PDF, unreadable image, empty document).
export async function extractDocument(from: string, to: string) {
  const ext = extname(from).toLowerCase();
  const rows =
    ext === ".pdf"
      ? pdfRows(from)
      : ext === ".docx"
        ? docxRows(from)
        : ext === ".txt" || ext === ".md"
          ? textFileRows(from)
          : imageRows(from);
  const out = createWriteStream(to);
  try {
    let count = 0;
    for await (const r of rows) {
      if (!out.write(JSON.stringify(r) + "\n")) await once(out, "drain");
      count++;
    }
    assert(
      count > 0,
      "No readable text found. Scanned documents need a text layer — try a text PDF or a plain-text export.",
    );
    await new Promise<void>((ok, fail) =>
      out.end((e: Error | null | undefined) => (e ? fail(e) : ok())),
    );
  } catch (e) {
    out.destroy();
    await rm(to, { force: true }).catch(() => {});
    if (e instanceof AppError) throw e;
    throw new AppError(
      400,
      `Could not read the ${ext} file: ${e instanceof Error ? e.message : e}`,
    );
  }
}

const entitySchema = z.toJSONSchema(
  z.object({
    entities: z
      .array(
        z.object({
          page: z.number().int(),
          entity: z.string(),
          type: z.enum([
            "person",
            "organization",
            "place",
            "product",
            "concept",
            "date",
            "amount",
            "other",
          ]),
          context: z.string(),
        }),
      )
      .max(60),
  }),
);

// Entities are extracted in ~6k-char batches of {page,text} rows so prompts
// stay well inside small local models' context windows. MAX_BATCHES bounds
// model calls per document; a failed batch is skipped, not fatal.
const ENTITY_BATCH_CHARS = 6000,
  ENTITY_MAX_BATCHES = 50;

export interface EntityRow {
  page: number;
  entity: string;
  type: string;
  context: string;
}

// Reads extracted {page,text} rows and asks the configured model for named
// entities. Entities are the bridge between documents and the ontology: they
// become a tabular dataset that link types can join on. `model` is anything
// with a Provider-shaped generate() (used directly in tests).
export async function extractEntities(
  rows: Row[],
  model: {
    generate(
      system: string,
      ctx: unknown,
      schema: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ value: unknown; tokens?: number }>;
  },
): Promise<{ entities: EntityRow[]; batches: number; tokens: number }> {
  const entities: EntityRow[] = [];
  let batch: Row[] = [],
    chars = 0,
    calls = 0,
    tokens = 0;
  const flush = async () => {
    const current = batch;
    (batch = []), (chars = 0);
    if (!current.length || calls >= ENTITY_MAX_BATCHES) return;
    calls++;
    try {
      const r = await model.generate(
        "You extract named entities and key topics from document rows. For each entity return the page it appears on (use a page number from the input), its name, a type, and a short context phrase copied from the text. Prefer canonical forms so the same real-world entity is spelled the same way across pages. Return JSON only.",
        { rows: current },
        entitySchema,
      );
      tokens += r.tokens || 0;
      const list = (r.value as { entities?: unknown[] })?.entities;
      if (!Array.isArray(list)) return;
      for (const e of list.slice(0, 60)) {
        const row = e as Record<string, unknown>;
        if (!row || typeof row.entity !== "string" || !row.entity.trim())
          continue;
        entities.push({
          page: Number.isInteger(row.page)
            ? (row.page as number)
            : (current[0]?.page ?? 1),
          entity: row.entity.trim().slice(0, 200),
          type: String(row.type || "other").slice(0, 40),
          context: String(row.context || "").slice(0, 400),
        });
      }
    } catch {
      // Skip a failed batch: partial entities are better than none.
    }
  };
  for (const r of rows) {
    batch.push(r);
    chars += r.text.length;
    if (chars >= ENTITY_BATCH_CHARS) await flush();
  }
  await flush();
  return { entities, batches: calls, tokens };
}
