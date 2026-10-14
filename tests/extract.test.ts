import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractDocument,
  extractEntities,
  isDocumentFile,
  acceptedExtensions,
} from "../apps/api/src/extract.js";
import { execute } from "../services/executor/src/engine.js";

vi.mock("mammoth", () => ({
  default: {
    extractRawText: async () => ({
      value: "Quarterly revenue grew.\n\nCosts fell in March.",
    }),
  },
}));
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: "PO 1042\nSigned" } }),
    terminate: async () => {},
  }),
}));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "foundry-extract-"));
  await mkdir(join(dir, "incoming", "a"), { recursive: true });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("document upload extraction", () => {
  it("recognizes document and image extensions", () => {
    expect(isDocumentFile("notes.txt")).toBe(true);
    expect(isDocumentFile("REPORT.PDF")).toBe(true);
    expect(isDocumentFile("scan.png")).toBe(true);
    expect(isDocumentFile("data.csv")).toBe(false);
    for (const e of [
      ".csv",
      ".pdf",
      ".docx",
      ".png",
      ".jpeg",
      ".md",
    ])
      expect(acceptedExtensions).toContain(e);
  });

  it("turns a text file into one row per non-empty line", async () => {
    const from = join(dir, "incoming", "a", "notes.txt"),
      to = join(dir, "incoming", "a", "notes.jsonl");
    await writeFile(from, "first line\n\nsecond line\n");
    await extractDocument(from, to);
    expect(await lines(to)).toEqual([
      { page: 1, text: "first line" },
      { page: 2, text: "second line" },
    ]);
  });

  it("extracts PDF pages as rows", async () => {
    const pdf = [
      "%PDF-1.1",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      "4 0 obj<</Length 51>>stream",
      "BT /F1 24 Tf 100 700 Td (Hello PDF world) Tj ET",
      "endstream",
      "endobj",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R>>",
    ].join("\n");
    const from = join(dir, "incoming", "a", "doc.pdf"),
      to = join(dir, "incoming", "a", "doc.jsonl");
    await writeFile(from, pdf);
    await extractDocument(from, to);
    const rows = await lines(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page: 1 });
    expect(rows[0].text).toContain("Hello PDF world");
  });

  it("extracts DOCX paragraphs as rows", async () => {
    const from = join(dir, "incoming", "a", "memo.docx"),
      to = join(dir, "incoming", "a", "memo.jsonl");
    await writeFile(from, "zip bytes are mocked");
    await extractDocument(from, to);
    expect(await lines(to)).toEqual([
      { page: 1, text: "Quarterly revenue grew." },
      { page: 2, text: "Costs fell in March." },
    ]);
  });

  it("OCRs an image into a single row", async () => {
    const from = join(dir, "incoming", "a", "scan.png"),
      to = join(dir, "incoming", "a", "scan.jsonl");
    await writeFile(from, "png bytes are mocked");
    await extractDocument(from, to);
    const rows = await lines(to);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("PO 1042");
  });

  it("rejects a document that yields no text", async () => {
    const from = join(dir, "incoming", "a", "empty.txt"),
      to = join(dir, "incoming", "a", "empty.jsonl");
    await writeFile(from, "\n   \n");
    await expect(extractDocument(from, to)).rejects.toThrow(
      "No readable text",
    );
    await expect(readFile(to)).rejects.toThrow();
  });

  it("ingests extracted rows through the real executor", async () => {
    const from = join(dir, "incoming", "a", "plain.md"),
      to = join(dir, "incoming", "a", "plain.jsonl");
    await writeFile(from, "# Orders\n\nTwo rows\n");
    await extractDocument(from, to);
    const r = await execute(
      { mode: "ingest", scope: "a", version: "vdoc", file: "plain.jsonl" },
      dir,
    );
    expect(r.profile.rows).toBe(2);
    expect(r.profile.columns.map((c: any) => c.name).sort()).toEqual([
      "page",
      "text",
    ]);
  });
});

describe("entity extraction", () => {
  const rows = [
    { page: 1, text: "Acme Corp signed a deal with Globex." },
    { page: 2, text: "Maria Lopez joined Acme in Berlin." },
  ];

  it("collects entities returned by the model", async () => {
    const model = {
      generate: async () => ({
        value: {
          entities: [
            {
              page: 1,
              entity: "Acme Corp",
              type: "organization",
              context: "signed a deal",
            },
            { page: 2, entity: "Maria Lopez", type: "person", context: "joined" },
            { entity: "", type: "other", context: "" },
          ],
        },
      }),
    };
    const { entities } = await extractEntities(rows, model);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      page: 1,
      entity: "Acme Corp",
      type: "organization",
    });
  });

  it("batches rows and tolerates a failed batch", async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({
      page: i + 1,
      text: "x".repeat(1000),
    }));
    let calls = 0;
    const model = {
      generate: async () => {
        calls++;
        if (calls === 1) throw new Error("model unavailable");
        return {
          value: {
            entities: [{ page: 1, entity: "E", type: "concept", context: "c" }],
          },
        };
      },
    };
    const { entities, batches } = await extractEntities(big, model);
    expect(batches).toBeGreaterThan(1);
    expect(entities.length).toBeGreaterThan(0);
  });
});

describe("semantic index round-trip", () => {
  it("ingests embeddings and ranks by cosine similarity", async () => {
    const file = join(dir, "incoming", "a", "vec.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ page: 1, text: "alpha", embedding: [1, 0, 0] }),
        JSON.stringify({ page: 2, text: "beta", embedding: [0, 1, 0] }),
      ].join("\n") + "\n",
    );
    await execute(
      { mode: "ingest", scope: "a", version: "vvec", file: "vec.jsonl" },
      dir,
    );
    const r = await execute(
      {
        mode: "query",
        scope: "a",
        version: "qvec",
        inputs: [{ table: "v", version: "vvec" }],
        sql: `SELECT page, array_cosine_similarity(embedding::FLOAT[3], [0.9, 0.1, 0]::FLOAT[3]) AS score FROM "v" ORDER BY score DESC LIMIT 1`,
      },
      dir,
    );
    expect(r.rows).toHaveLength(1);
    expect(Number((r.rows[0] as any).page)).toBe(1);
  });
});
