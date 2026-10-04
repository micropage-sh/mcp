import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_ASSET_BYTES,
  assertContentMatchesExtension,
  buildUploadForm,
  hasSvgRoot,
  isPrivateAddress,
  loadAssetSource,
  uploadAsset,
  urlHostLookup,
  validateAssetFilename,
  type HostLookup,
} from "../src/client/assets.js";
import { MicropageError } from "../src/client/errors.js";
import { createFakeFetch, makeHttp, type RecordedCall } from "./helpers/fake-fetch.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const listing = (files: object[], total_bytes = 0, space_available_mb = 100) => ({ body: { files, total_bytes, space_available_mb } });
const path = (c: RecordedCall): string => new URL(c.url).pathname;

async function expectCode(p: Promise<unknown> | (() => unknown), code: string, message?: RegExp): Promise<MicropageError> {
  let err: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(MicropageError);
  expect((err as MicropageError).code).toBe(code);
  if (message) expect((err as MicropageError).message).toMatch(message);
  return err as MicropageError;
}

describe("validateAssetFilename", () => {
  it("accepts every CLI mime extension, case-insensitively", () => {
    for (const n of ["a.png", "a.jpg", "a.JPEG", "a.gif", "a.webp", "favicon.ico", "logo.svg"]) {
      expect(validateAssetFilename(` ${n} `)).toBe(n);
    }
  });

  it("rejects path separators, dot names and control characters", async () => {
    await expectCode(() => validateAssetFilename("img/a.png"), "INVALID_FILENAME", /path separator/);
    await expectCode(() => validateAssetFilename("..\\a.png"), "INVALID_FILENAME", /path separator/);
    await expectCode(() => validateAssetFilename(".."), "INVALID_FILENAME");
    await expectCode(() => validateAssetFilename("a\n.png"), "INVALID_FILENAME", /control/);
  });

  it("rejects other extensions and names it accepts", async () => {
    await expectCode(() => validateAssetFilename("doc.pdf"), "UNSUPPORTED_FILE_TYPE", /\.png, \.jpg.*\.svg/);
    await expectCode(() => validateAssetFilename("noext"), "UNSUPPORTED_FILE_TYPE");
    await expectCode(() => validateAssetFilename(".png"), "UNSUPPORTED_FILE_TYPE");
  });
});

describe("assertContentMatchesExtension", () => {
  it("accepts matching magic bytes and svg text", () => {
    assertContentMatchesExtension("a.png", PNG);
    assertContentMatchesExtension("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assertContentMatchesExtension("a.gif", Buffer.from("GIF89a...."));
    assertContentMatchesExtension("a.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
    assertContentMatchesExtension("a.ico", Buffer.from([0, 0, 1, 0, 1]));
    assertContentMatchesExtension("a.svg", Buffer.from('﻿<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  });

  it("rejects content that is not the claimed image type", async () => {
    await expectCode(() => assertContentMatchesExtension("key.png", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----")), "INVALID_ASSET", /not a valid PNG/);
    await expectCode(() => assertContentMatchesExtension("a.svg", Buffer.from("hello")), "INVALID_ASSET");
    await expectCode(() => assertContentMatchesExtension("a.png", Buffer.alloc(0)), "INVALID_ASSET", /empty/);
  });
});

describe("SVG root check", () => {
  it("accepts a plain svg, and one after an xml declaration, comments and an svg doctype", () => {
    expect(hasSvgRoot('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toBe(true);
    expect(hasSvgRoot("\n  <svg>\n</svg>")).toBe(true);
    expect(
      hasSvgRoot(
        '\uFEFF<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Generator: Inkscape -->\n' +
          '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
          "<!-- a second comment -->\n<svg width=\"10\" height=\"10\"/>",
      ),
    ).toBe(true);
    assertContentMatchesExtension("a.svg", Buffer.from('<?xml version="1.0"?><!--c--><!DOCTYPE svg><svg/>'));
  });

  it("rejects an HTML page with an inline svg", async () => {
    const html = '<!DOCTYPE html>\n<html><body><svg viewBox="0 0 1 1"></svg><script>alert(1)</script></body></html>';
    expect(hasSvgRoot(html)).toBe(false);
    expect(hasSvgRoot('<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>')).toBe(false);
    await expectCode(() => assertContentMatchesExtension("icon.svg", Buffer.from(html)), "INVALID_ASSET", /not a valid SVG/);
  });

  it("rejects an XML config that only mentions <svg> in a comment", () => {
    expect(hasSvgRoot('<?xml version="1.0"?>\n<!-- <svg> -->\n<config><secret>hunter2</secret></config>')).toBe(false);
    expect(hasSvgRoot("<!-- <svg> --><settings/>")).toBe(false);
  });

  it("rejects a non-svg root after an xml declaration, and other prologs", () => {
    expect(hasSvgRoot('<?xml version="1.0"?><plist version="1.0"><dict/></plist>')).toBe(false);
    expect(hasSvgRoot('<?xml version="1.0"?><svgx/>')).toBe(false);
    expect(hasSvgRoot('<!DOCTYPE html><svg/>')).toBe(false);
    expect(hasSvgRoot('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBe(false);
    expect(hasSvgRoot('<?xml-stylesheet href="a.css"?><svg/>')).toBe(false);
    expect(hasSvgRoot("<!-- never closed <svg/>")).toBe(false);
    expect(hasSvgRoot("svg")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("refuses loopback, RFC1918, link-local, CGNAT, this-network, multicast and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.1.1.1", "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses ::1, ::, link-local fe80::/10, ULA fc00::/7, multicast and IPv4-mapped forms of private IPv4", () => {
    for (const ip of [
      "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:10.0.0.1", "::127.0.0.1",
      "fe80::1%eth0",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::6810:84e5", "::ffff:93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats anything that is not an IP as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

/** Resolves every name to a public address, so no real DNS query is made. */
const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const realLookup = urlHostLookup.current;

describe("loadAssetSource", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "micropage-mcp-assets-"));
    urlHostLookup.current = publicLookup;
  });
  afterEach(async () => {
    urlHostLookup.current = realLookup;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads an absolute path", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, PNG);
    expect(await loadAssetSource({ path: p })).toEqual(PNG);
  });

  it("rejects a relative path, a missing file, a directory and an oversized file", async () => {
    await expectCode(loadAssetSource({ path: "a.png" }), "INVALID_SOURCE", /relative/);
    await expectCode(loadAssetSource({ path: join(dir, "missing.png") }), "INVALID_SOURCE", /ENOENT/);
    await expectCode(loadAssetSource({ path: dir }), "INVALID_SOURCE", /not a regular file/);
    const big = join(dir, "big.png");
    await writeFile(big, Buffer.alloc(101));
    await expectCode(loadAssetSource({ path: big }, { maxBytes: 100 }), "ASSET_TOO_LARGE", /limit/);
  });

  it("decodes base64 and data: URLs, and enforces the cap before decoding", async () => {
    expect(await loadAssetSource({ base64: PNG.toString("base64") })).toEqual(PNG);
    expect(await loadAssetSource({ base64: `data:image/png;base64,${PNG.toString("base64")}` })).toEqual(PNG);
    await expectCode(loadAssetSource({ base64: "not base64!" }), "INVALID_SOURCE");
    await expectCode(loadAssetSource({ base64: Buffer.alloc(200).toString("base64") }, { maxBytes: 100 }), "ASSET_TOO_LARGE");
  });

  it("has a 10 MB default cap", async () => {
    expect(MAX_ASSET_BYTES).toBe(10 * 1024 * 1024);
    const b64 = Buffer.alloc(MAX_ASSET_BYTES + 3).toString("base64");
    await expectCode(loadAssetSource({ base64: b64 }), "ASSET_TOO_LARGE", /10\.0 MB/);
  });

  it("fetches an https URL without micropage credentials", async () => {
    const fake = createFakeFetch({ body: PNG.toString("latin1"), headers: { "content-type": "image/png" } });
    const fakeFetch = async (input: string, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      // Re-wrap with binary-safe bytes; the harness serializes bodies as strings.
      return new Response(PNG, { status: res.status, headers: res.headers });
    };
    expect(await loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: fakeFetch })).toEqual(PNG);
    expect(fake.calls[0]!.url).toBe("https://img.example.com/a.png");
    expect(fake.calls[0]!.headers.authorization).toBeUndefined();
    expect(fake.calls[0]!.headers.apikey).toBeUndefined();
  });

  const pngResponse = () => new Response(PNG, { headers: { "content-type": "image/png" } });

  it("refuses hosts that resolve to private, local or reserved addresses, without fetching", async () => {
    const cases: Array<[string, string]> = [
      ["loopback", "127.0.0.1"],
      ["RFC1918", "10.0.0.5"],
      ["RFC1918 172.16/12", "172.20.1.1"],
      ["RFC1918 192.168/16", "192.168.0.10"],
      ["link-local / cloud metadata", "169.254.169.254"],
      ["CGNAT", "100.100.1.1"],
      ["this network", "0.0.0.0"],
      ["multicast", "224.0.0.251"],
      ["IPv6 loopback", "::1"],
      ["IPv6 link-local", "fe80::abcd"],
      ["IPv6 ULA", "fd00::1"],
      ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ];
    for (const [label, address] of cases) {
      let fetched = 0;
      const lookup: HostLookup = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
      const fetchImpl = async () => {
        fetched++;
        return pngResponse();
      };
      await expectCode(loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: fetchImpl, lookup }), "INVALID_SOURCE", /private, local or reserved/);
      expect(fetched, label).toBe(0);
    }
  });

  it("refuses when any one of several resolved addresses is private", async () => {
    const lookup: HostLookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expectCode(loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: async () => pngResponse(), lookup }), "INVALID_SOURCE");
  });

  it("refuses private IP-literal hosts without resolving them", async () => {
    const lookup: HostLookup = async () => {
      throw new Error("must not resolve IP literals");
    };
    for (const url of ["https://127.0.0.1/a.png", "https://[::1]/a.png", "https://[::ffff:169.254.169.254]/a.png", "https://2130706433/a.png", "https://10.1.1.1:8443/a.png"]) {
      await expectCode(loadAssetSource({ url }, { fetch: async () => pngResponse(), lookup }), "INVALID_SOURCE", /private, local or reserved/);
    }
  });

  it("follows redirects by hand, checking every hop, and refuses a redirect to a private host", async () => {
    const seen: string[] = [];
    const hops: Record<string, Response> = {
      "https://img.example.com/a.png": new Response(null, { status: 302, headers: { location: "https://cdn.example.net/b.png" } }),
      "https://cdn.example.net/b.png": new Response(null, { status: 301, headers: { location: "https://internal.example.net/c.png" } }),
    };
    const fetchImpl = async (input: string, init?: RequestInit) => {
      seen.push(input);
      expect(init?.redirect).toBe("manual");
      return hops[input] ?? pngResponse();
    };
    const lookup: HostLookup = async (host) =>
      host === "internal.example.net" ? [{ address: "192.168.1.20", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
    await expectCode(loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: fetchImpl, lookup }), "INVALID_SOURCE", /192\.168\.1\.20/);
    expect(seen).toEqual(["https://img.example.com/a.png", "https://cdn.example.net/b.png"]);
  });

  it("follows a relative redirect to a public host", async () => {
    const fetchImpl = async (input: string) =>
      input === "https://img.example.com/a.png" ? new Response(null, { status: 307, headers: { location: "/real.png" } }) : pngResponse();
    expect(await loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: fetchImpl, lookup: publicLookup })).toEqual(PNG);
  });

  it("refuses a redirect to plain http and more than 5 redirects", async () => {
    const toHttp = async () => new Response(null, { status: 302, headers: { location: "http://img.example.com/a.png" } });
    await expectCode(loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: toHttp }), "INVALID_SOURCE", /non-https/);
    let n = 0;
    const loop = async () => new Response(null, { status: 302, headers: { location: `https://img.example.com/${++n}.png` } });
    await expectCode(loadAssetSource({ url: "https://img.example.com/a.png" }, { fetch: loop }), "INVALID_SOURCE", /more than 5/);
    expect(n).toBe(6);
  });

  it("refuses non-https URLs without fetching", async () => {
    const fake = createFakeFetch();
    await expectCode(loadAssetSource({ url: "http://img.example.com/a.png" }, { fetch: fake.fetch }), "INVALID_SOURCE", /https/);
    await expectCode(loadAssetSource({ url: "file:///etc/passwd" }, { fetch: fake.fetch }), "INVALID_SOURCE");
    expect(fake.calls).toHaveLength(0);
  });

  it("enforces the cap from Content-Length and while streaming", async () => {
    const declared = async () => new Response(Buffer.alloc(10), { headers: { "content-length": "5000" } });
    await expectCode(loadAssetSource({ url: "https://x.test/a.png" }, { fetch: declared, maxBytes: 100 }), "ASSET_TOO_LARGE");
    const chunked = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(40));
            c.close();
          },
        }),
      );
    await expectCode(loadAssetSource({ url: "https://x.test/a.png" }, { fetch: chunked, maxBytes: 100 }), "ASSET_TOO_LARGE");
  });

  it("reports HTTP errors and timeouts from the image host", async () => {
    await expectCode(loadAssetSource({ url: "https://x.test/a.png" }, { fetch: async () => new Response("no", { status: 404 }) }), "HTTP", /404/);
    const hang = (_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expectCode(loadAssetSource({ url: "https://x.test/a.png" }, { fetch: hang, timeoutMs: 20 }), "TIMEOUT", /timed out/);
  });
});

describe("buildUploadForm", () => {
  it("matches the CLI's multipart fields: file (named, typed), project_id, content_hash", async () => {
    const form = buildUploadForm(7, "logo.svg", Buffer.from("<svg></svg>"), "ab".repeat(32));
    expect([...form.keys()]).toEqual(["file", "project_id", "content_hash"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("logo.svg");
    expect(file.type).toBe("image/svg+xml");
    expect(await file.text()).toBe("<svg></svg>");
    expect(form.get("project_id")).toBe("7");
    expect(form.get("content_hash")).toBe("ab".repeat(32));
  });
});

describe("uploadAsset dedupe (CLI uploadAssetsWithToken)", () => {
  it("skips the upload when name and SHA-256 match", async () => {
    const fake = createFakeFetch(
      listing([{ id: "f1", filename: "a.png", content_hash: sha(PNG), size_bytes: PNG.length, mime_type: "image/png" }]),
      { body: { url: "https://files.test/projects/7/u1.png" } },
    );
    const res = await uploadAsset(makeHttp(fake), 7, "a.png", PNG);
    expect(res).toMatchObject({ deduped: true, replaced: false, url: "https://files.test/projects/7/u1.png", file: { id: "f1" } });
    expect(fake.calls.map((c) => `${c.method} ${path(c)}`)).toEqual(["GET /functions/v1/list-files", "GET /functions/v1/get-file-url"]);
    expect(new URL(fake.calls[0]!.url).searchParams.get("project_id")).toBe("7");
    expect(new URL(fake.calls[1]!.url).searchParams.get("file_id")).toBe("f1");
  });

  it("deletes then re-uploads with content_hash when the hash changed", async () => {
    const fake = createFakeFetch(
      listing([{ id: "f1", filename: "a.png", content_hash: sha(PNG), size_bytes: PNG.length }], PNG.length),
      { body: { success: true } },
      { body: { success: true, file: { id: "f2", filename: "a.png", size_bytes: PNG2.length, mime_type: "image/png" } } },
      { body: { url: "https://files.test/u2.png" } },
    );
    const res = await uploadAsset(makeHttp(fake), 7, "a.png", PNG2);
    expect(res).toMatchObject({ deduped: false, replaced: true, url: "https://files.test/u2.png", content_hash: sha(PNG2) });
    expect(fake.calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      "GET /functions/v1/list-files",
      "POST /functions/v1/delete-file",
      "POST /functions/v1/upload-file",
      "GET /functions/v1/get-file-url",
    ]);
    expect(fake.calls[1]!.body).toEqual({ file_id: "f1" });
    const form = fake.calls[2]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("content_hash")).toBe(sha(PNG2));
    expect(form.get("project_id")).toBe("7");
    expect((form.get("file") as File).name).toBe("a.png");
    // multipart: fetch sets the boundary, so no JSON content type may be forced.
    expect(fake.calls[2]!.headers["content-type"]).toBeUndefined();
    expect(fake.calls[2]!.headers.authorization).toBe("Bearer token-1");
  });

  it("treats a NULL server hash as changed", async () => {
    const fake = createFakeFetch(
      listing([{ id: "f0", filename: "a.png", content_hash: null, size_bytes: 3 }], 3),
      { body: { success: true } },
      { body: { file: { id: "f3", filename: "a.png" } } },
      { body: { url: "https://files.test/u3.png" } },
    );
    const res = await uploadAsset(makeHttp(fake), 7, "a.png", PNG);
    expect(res).toMatchObject({ deduped: false, replaced: true });
    expect(fake.calls[1]!.body).toEqual({ file_id: "f0" });
  });

  it("uploads without deleting when the name is new", async () => {
    const fake = createFakeFetch(
      listing([{ id: "f1", filename: "other.png", content_hash: sha(PNG) }]),
      { body: { file: { id: "f4", filename: "a.png" } } },
      { body: { url: "https://files.test/u4.png" } },
    );
    const res = await uploadAsset(makeHttp(fake), 7, "a.png", PNG);
    expect(res).toMatchObject({ deduped: false, replaced: false });
    expect(fake.calls.map(path)).toEqual(["/functions/v1/list-files", "/functions/v1/upload-file", "/functions/v1/get-file-url"]);
  });

  it("fails without uploading when list-files fails", async () => {
    const fake = createFakeFetch({ status: 500, body: { error: "boom" } });
    await expectCode(uploadAsset(makeHttp(fake), 7, "a.png", PNG), "HTTP", /boom/);
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses before deleting anything when the plan quota would be exceeded", async () => {
    const MB = 1024 * 1024;
    const fake = createFakeFetch(listing([{ id: "f1", filename: "a.png", content_hash: null, size_bytes: 1 }], 100 * MB, 100));
    const err = await expectCode(uploadAsset(makeHttp(fake), 7, "a.png", PNG), "QUOTA_EXCEEDED", /100\.0 MB of its 100 MB plan limit/);
    expect(err.message).toMatch(/micropage\.sh\/pricing/);
    expect(fake.calls).toHaveLength(1);
  });

  it("surfaces upload-file's 413 with the plan limit", async () => {
    const MB = 1024 * 1024;
    const fake = createFakeFetch(listing([]), {
      status: 413,
      body: { error: "Storage quota exceeded", current_usage: 99 * MB, max_bytes: 100 * MB, file_size: 2 * MB },
    });
    await expectCode(uploadAsset(makeHttp(fake), 7, "a.png", PNG), "QUOTA_EXCEEDED", /99\.0 MB of its 100\.0 MB plan limit and the file is 2\.00 MB/);
  });

  it("says the old file is gone when the re-upload fails after the delete", async () => {
    const fake = createFakeFetch(
      listing([{ id: "f1", filename: "a.png", content_hash: null, size_bytes: 3 }], 3),
      { body: { success: true } },
      { status: 500, body: { error: "R2 down" } },
    );
    await expectCode(uploadAsset(makeHttp(fake), 7, "a.png", PNG), "HTTP", /R2 down[\s\S]*already been deleted/);
  });
});
