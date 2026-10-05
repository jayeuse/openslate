import { expect, test } from "@playwright/test";
import { dummyFile } from "../../helpers/dummy-files";

// Mocked HTTP tests never validate bytes, so this checks the structure the
// backend validation needs. The full-stack run proves the backend accepts them.

function zipEntryNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    expect(buffer.readUInt16LE(offset + 8), "stored, not compressed").toBe(0);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString("utf8", offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + size;
  }
  expect(buffer.readUInt32LE(offset), "central directory follows").toBe(
    0x02014b50,
  );
  return names;
}

test("dummy PDF is one page between a PDF header and an end marker", () => {
  const file = dummyFile("Dock 3 loading plan.pdf");
  const text = file.buffer.toString("latin1");
  expect(file).toMatchObject({
    name: "Dock 3 loading plan.pdf",
    mimeType: "application/pdf",
  });
  expect(text.startsWith("%PDF-")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  expect(text).toContain("/Type /Page ");
  const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
  expect(text.slice(startxref, startxref + 4)).toBe("xref");
});

test("dummy images carry their PNG and JPEG signatures", () => {
  const png = dummyFile("Yard layout.png");
  expect(png.mimeType).toBe("image/png");
  expect([...png.buffer.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  for (const name of ["Gate photo.jpg", "Gate photo.JPEG"]) {
    const jpeg = dummyFile(name);
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect([...jpeg.buffer.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...jpeg.buffer.subarray(-2)]).toEqual([0xff, 0xd9]);
  }
});

test("dummy Office files hold only the content types, relationships and root part", () => {
  const cases = [
    ["Year 9 trip consent form.docx", "word/document.xml", "wordprocessingml"],
    ["Forklift inspection checklist.xlsx", "xl/workbook.xml", "spreadsheetml"],
    ["Safety briefing.pptx", "ppt/presentation.xml", "presentationml"],
  ] as const;
  for (const [name, part, family] of cases) {
    const file = dummyFile(name);
    expect(file.mimeType).toContain(family);
    expect(zipEntryNames(file.buffer)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      part,
    ]);
    expect(file.buffer.toString("utf8")).toContain(
      `<Override PartName="/${part}" ContentType="${file.mimeType}.main+xml"/>`,
    );
  }
});

test("dummy files are deterministic, non-empty, and limited to allowed types", () => {
  for (const name of [
    "a.pdf",
    "a.png",
    "a.jpg",
    "a.docx",
    "a.xlsx",
    "a.pptx",
  ]) {
    const first = dummyFile(name).buffer;
    expect(first.length).toBeGreaterThan(0);
    expect(dummyFile(name).buffer.equals(first)).toBe(true);
  }
  expect(() => dummyFile("notes.txt")).toThrow("No dummy file type");
});
