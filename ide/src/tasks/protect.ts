// Output comparison and test protection. Must match tools/pytask.py, which builds the packages.
// All of this only deters: the page has to be able to read whatever it checks with.
import { unzlibSync } from "fflate";

export type Comparison = "exact" | "lines" | "tokens" | "float";

const WHITESPACE = /[ \t\r\n\f\v]+/;
const encoder = new TextEncoder();

export function normalize(mode: Comparison, text: string) {
  const unified = text.replace(/\r\n?/g, "\n");
  if (mode === "exact") return unified;
  if (mode === "lines") {
    return unified
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  }
  return unified.split(WHITESPACE).filter(Boolean).join(" ");
}

function tokensMatch(actual: string, expected: string, tolerance: number) {
  const a = actual.split(" ");
  const b = expected.split(" ");
  if (a.length !== b.length) return false;
  return a.every((token, i) => {
    if (token === b[i]) return true;
    const difference = Math.abs(Number(token) - Number(b[i]));
    return token !== "" && b[i] !== "" && difference <= tolerance;
  });
}

export function outputsMatch(mode: Comparison, actual: string, expected: string, tolerance = 0) {
  const a = normalize(mode, actual);
  const b = normalize(mode, expected);
  return mode === "float" ? tokensMatch(a, b, tolerance) : a === b;
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function outputHash(taskId: string, position: string, text: string) {
  const digest = await sha256(`${taskId}\n${position}\n${text}`);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function unseal<T>(taskId: string, groupIndex: number, sealed: string): Promise<T> {
  const data = decodeBase64(sealed);
  const digest = await sha256(`pytask:${taskId}:${groupIndex}`);
  let state = (new DataView(digest.buffer).getUint32(0) | 1) >>> 0;
  for (let i = 0; i < data.length; i++) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    data[i] ^= state & 255;
  }
  return JSON.parse(new TextDecoder().decode(unzlibSync(data)));
}
