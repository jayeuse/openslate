import { crc32, deflateSync } from "node:zlib";

// Blank-but-valid upload files for Board attachment tests. Each builder is
// deterministic: the same name always gives the same bytes, so a test can
// rebuild the expected bytes after a download. The backend validation
// (backend/app/systems/platform/files/validation.py) accepts every output;
// backend/operations/sample/dummy_files.py is the matching backend builder.

export type DummyFile = { name: string; mimeType: string; buffer: Buffer };

const OFFICE_MAIN = "application/vnd.openxmlformats-officedocument";

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".docx": `${OFFICE_MAIN}.wordprocessingml.document`,
  ".xlsx": `${OFFICE_MAIN}.spreadsheetml.sheet`,
  ".pptx": `${OFFICE_MAIN}.presentationml.presentation`,
};

function pdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

function png(): Buffer {
  // One white pixel: 8-bit RGB, filter byte 0, then 255 255 255.
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(): Buffer {
  // One white grayscale pixel, baseline. With a quantization table of ones,
  // the only coefficient is DC 1016 (category 10). Each Huffman table holds
  // one one-bit code: DC category 10, and AC end-of-block. The scan bits are
  // 0, 1111111000, 0, padded with ones: 0x7f 0x0f.
  const huffman = (tableClass: number, symbol: number) => [
    0xff,
    0xc4,
    0x00,
    0x14,
    tableClass,
    1,
    ...Array<number>(15).fill(0),
    symbol,
  ];
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...Array<number>(64).fill(1),
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x01,
    0x00,
    0x01,
    0x01,
    0x01,
    0x11,
    0x00,
    ...huffman(0x00, 0x0a),
    ...huffman(0x10, 0x00),
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x7f,
    0x0f,
    0xff,
    0xd9,
  ]);
}

// A stored (uncompressed) zip with fixed 1980-01-01 timestamps.
function zip(entries: [string, string][]): Buffer {
  const DOS_DATE = 0x21;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entryName, text] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(text, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const OFFICE = {
  ".docx": {
    part: "word/document.xml",
    contentType: `${OFFICE_MAIN}.wordprocessingml.document.main+xml`,
    root: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  },
  ".xlsx": {
    part: "xl/workbook.xml",
    contentType: `${OFFICE_MAIN}.spreadsheetml.sheet.main+xml`,
    root: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  },
  ".pptx": {
    part: "ppt/presentation.xml",
    contentType: `${OFFICE_MAIN}.presentationml.presentation.main+xml`,
    root: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  },
} as const;

function office(extension: keyof typeof OFFICE): Buffer {
  const { part, contentType, root } = OFFICE[extension];
  return zip([
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/${part}" ContentType="${contentType}"/></Types>`,
    ],
    [
      "_rels/.rels",
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
        `Target="${part}"/></Relationships>`,
    ],
    [part, `${XML}${root}`],
  ]);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** Builds a blank-but-valid file whose type follows the name's extension. */
export function dummyFile(name: string): DummyFile {
  const extension = extensionOf(name);
  const mimeType = MIME[extension];
  if (!mimeType) throw new Error(`No dummy file type for ${name}`);
  const buffer =
    extension === ".pdf"
      ? pdf()
      : extension === ".png"
        ? png()
        : extension === ".jpg" || extension === ".jpeg"
          ? jpeg()
          : office(extension as keyof typeof OFFICE);
  return { name, mimeType, buffer };
}
