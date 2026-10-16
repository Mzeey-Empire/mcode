import { describe, expect, it } from "vitest";
import { ActionPortDetector } from "../action-port-detector.js";

describe("ActionPortDetector", () => {
  it("normalizes wildcard URLs and deduplicates by printed host and port", () => {
    const detector = new ActionPortDetector();
    expect(detector.write(Buffer.from("http://0.0.0.0:5173/app\nhttps://[::]:8443/\nhttp://LOCALHOST:3000/\n"))).toEqual([
      { host: "0.0.0.0", port: 5173, url: "http://localhost:5173/app" },
      { host: "::", port: 8443, url: "https://localhost:8443/" },
      { host: "localhost", port: 3000, url: "http://localhost:3000/" },
    ]);
    expect(detector.write(Buffer.from("http://localhost:3000/other\nhttp://0.0.0.0:5173/\n"))).toEqual([]);
  });

  it("ignores LAN, public, implicit and invalid ports", () => {
    const detector = new ActionPortDetector();
    expect(detector.write(Buffer.from([
      "http://192.168.1.2:5173/", "http://example.com:5173/", "https://bun.sh/docs",
      "http://localhost/", "http://[::1]/", "http://localhost:0/", "http://localhost:65536/",
      "http://localhost:123abc/", "ftp://localhost:5173/",
    ].join("\n")))).toEqual([]);
  });

  it("detects a URL across chunks and split ANSI sequences", () => {
    const detector = new ActionPortDetector();
    expect(detector.write(Buffer.from("http://local"))).toEqual([]);
    expect(detector.write(Buffer.from("host:\x1b[1"))).toEqual([]);
    expect(detector.write(Buffer.from("m5173\x1b[22m/\n"))).toEqual([
      { host: "localhost", port: 5173, url: "http://localhost:5173/" },
    ]);
  });

  it("collects only eight unique candidates", () => {
    const detector = new ActionPortDetector();
    const output = Array.from({ length: 10 }, (_, index) => `http://localhost:${3000 + index}/`).join("\n");
    expect(detector.write(Buffer.from(output)).map((candidate) => candidate.port)).toEqual([3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007]);
    expect(detector.write(Buffer.from("\nhttp://localhost:9000/"))).toEqual([]);
  });

  it("stops at the byte budget, even within one oversized chunk", () => {
    const detector = new ActionPortDetector();
    const prefix = Buffer.from("http://localhost:3000/\n");
    const padding = Buffer.alloc(1_048_576 - prefix.length, 10);
    expect(detector.write(Buffer.concat([prefix, padding, Buffer.from("http://localhost:4000/\n")])).map((candidate) => candidate.port)).toEqual([3000]);
    expect(detector.write(Buffer.from("http://localhost:5000/\n"))).toEqual([]);
  });

  it("stops scanning when a candidate is confirmed", () => {
    const detector = new ActionPortDetector();
    detector.write(Buffer.from("http://localhost:3000/\n"));
    detector.confirm();
    expect(detector.write(Buffer.from("http://localhost:4000/\n"))).toEqual([]);
  });
});
