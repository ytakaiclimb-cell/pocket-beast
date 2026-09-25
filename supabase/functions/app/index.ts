// アプリの配信。
//
// Supabase Storage は公開URLで配ると Content-Type を text/plain にし、
// さらに `default-src 'none'; sandbox` の CSP を付けるので、
// HTML アプリとしては動かない。
// そこで Storage を「置き場所」としてだけ使い、配信はこの関数が行う。
//
// verify_jwt は false。誰でも開ける公開ページなので、これが正しい。

const REF = Deno.env.get("SUPABASE_URL") ?? "";
const ORIGIN = REF + "/storage/v1/object/public/app/";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

// 配ってよいファイルだけを通す（Storage の中身を何でも覗かせない）
const ALLOW = new Set([
  "index.html",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
]);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // 実行環境によって pathname が /app だったり /functions/v1/app だったりするので、
  // 関数名 "app" より後ろをファイル名として取る。
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("app");
  const after = i >= 0 ? parts.slice(i + 1).join("/") : "";
  const file = after === "" ? "index.html" : decodeURIComponent(after);

  if (!ALLOW.has(file)) {
    return new Response("not found: " + url.pathname, {
      status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const res = await fetch(ORIGIN + file, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) {
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const ext = file.split(".").pop() ?? "txt";
  const body = await res.arrayBuffer();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      // HTML は短め、画像は長めにキャッシュ
      "Cache-Control": ext === "html" ? "public, max-age=60" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
