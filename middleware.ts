// 社内限定ゲート（Edge Middleware）。
// 有効な pf_gate クッキー（HMAC 署名）が無いアクセスは /gate.html へ誘導する。
// 例外: /gate.html（入力画面）・/api/gate（検証API）・favicon。
// クッキー署名は PF_GATE_SECRET、合言葉は /api/gate 側で PF_GATE_CODE と照合する。
import { next, rewrite } from "@vercel/edge";

export const config = {
  // gate.html / api/gate / favicon 以外の全パスを対象
  matcher: ["/((?!gate\\.html|api/gate|favicon\\.ico).*)"],
};

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

async function isValid(value: string | null, secret: string): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(value.slice(0, dot));
  const mac = value.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(req: Request) {
  const secret = (process.env.PF_GATE_SECRET || "").trim();
  // ゲート未設定（secret 無し）なら素通し（誤って全断しないためのフェイルオープン。設定後に有効化）
  if (!secret) return next();
  if (await isValid(readCookie(req, "pf_gate"), secret)) return next();
  return rewrite(new URL("/gate.html", req.url));
}
