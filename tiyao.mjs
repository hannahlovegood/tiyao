#!/usr/bin/env node
/**
 * 提要 · AI Daily Digest — 每天替你把 AI 世界读一遍，只留提要。
 * ------------------------------------------------------------------
 * 管道（复用信息雷达验证过的模式，内容全换成 AI 专属源）：
 *   抓取 6 类源 → 归一化 → 去重 → 打分（热度源内归一化 / 官方按权威度）× 时效
 *   → Top 10 → 中文标题 + 一句「为什么值得读」（LLM 可选，降级启发式）
 *   → 生成 index.html（今日刊）+ archive/日期.html（存档）+ feed.xml（RSS 订阅）+ digests/日期.md
 *
 * 跑法：
 *   node tiyao.mjs                       # 零密钥，启发式理由 + 原文标题
 *   LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node tiyao.mjs
 *   ANTHROPIC_API_KEY=sk-ant-xxx node tiyao.mjs
 * ------------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";

// ── 配置 ────────────────────────────────────────────────────────────
const SITE_NAME = "提要";
const SITE_TAG = "AI DAILY DIGEST";
const SITE_URL = "https://hannahlovegood.github.io/tiyao/"; // 发车时如换仓库名，改这一处
const REPO_URL = "https://github.com/hannahlovegood/tiyao";
const TOP_N = 10;
const PER_SOURCE = 15;
const RECENCY_HALFLIFE_H = 48; // 热度源的时效半衰期
const OFFICIAL_HALFLIFE_H = 72; // 官方发布衰减更慢：两天前的官方发布仍有含金量
const COMMENT_WEIGHT = 2;
const MAX_AGE_D = 3; // 只看 3 天内
const MAX_PAPER_AGE_D = 5; // 论文榜周末不出刊，窗口放宽到 5 天
const SOURCE_CAP = 3; // 每期单一信源最多 3 条，保证结构多样
const UA = { "User-Agent": "tiyao-ai-digest/1.0 (daily digest generator)" };

// ── 相关性闸门（泛技术源用它过滤；AI 专属源本身已干净）──────────────
const AI_RE =
  /\b(ai|a\.i\.|llm|llms|gpt|chatgpt|claude|anthropic|openai|gemini|grok|llama|mistral|qwen|deepseek|kimi|agent|agentic|machine\s*learning|neural|deep\s*learning|transformer|diffusion|rag|embedding|chatbot|copilot|hugging\s*face|inference|fine[- ]?tun|prompt|foundation\s*model|multimodal|gpu|cuda|pytorch|tensor|open\s*weights?|benchmark)\b/i;
const looksAI = (t = "") => AI_RE.test(t);

// ── 带超时的 fetch ──────────────────────────────────────────────────
async function getText(url, ms = 20000, headers = UA) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}
const getJSON = async (url, ms, headers) => JSON.parse(await getText(url, ms, headers));

// ── 通用实体解码 / RSS·Atom 极简解析（零依赖）───────────────────────
function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const items = [];
  for (const b of blocks) {
    const pick = (tag) =>
      b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? "";
    const title = decodeEntities(pick("title")).replace(/<[^>]+>/g, "").trim();
    // Atom 的 link 是自闭合 href；RSS 的 link 是文本内容
    let link =
      b.match(/<link[^>]*?rel="alternate"[^>]*?href="([^"]+)"/i)?.[1] ??
      b.match(/<link[^>]*?href="([^"]+)"/i)?.[1] ?? "";
    if (!link) link = decodeEntities(pick("link"));
    const date = pick("pubDate") || pick("published") || pick("updated") || pick("dc:date");
    if (title && link) items.push({ title, link: decodeEntities(link).trim(), date });
  }
  return items;
}
const freshEnough = (iso, days = MAX_AGE_D) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t < days * 864e5;
};

// ── 源 1：官方 / 精选博客（RSS·Atom，无热度 → 按权威度进榜）──────────
// auth = 权威度基准分（0–100）：一线实验室官方 > 机构博客 > 精选个人博客
const FEEDS = [
  { name: "OpenAI",        kind: "官方", auth: 95, url: "https://openai.com/news/rss.xml" },
  // Anthropic 官方无 RSS，用社区维护的镜像 feed（Olshansk/rss-feeds，每日更新）
  { name: "Anthropic",     kind: "官方", auth: 95, url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml" },
  { name: "Google AI",     kind: "官方", auth: 90, url: "https://blog.google/technology/ai/rss/" },
  { name: "DeepMind",      kind: "官方", auth: 90, url: "https://deepmind.google/blog/rss.xml" },
  { name: "Hugging Face",  kind: "博客", auth: 82, url: "https://huggingface.co/blog/feed.xml" },
  { name: "Simon Willison", kind: "博客", auth: 78, url: "https://simonwillison.net/atom/everything/", filter: true },
];
async function fetchFeeds() {
  const out = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const items = parseFeed(await getText(f.url));
        for (const it of items) {
          if (!freshEnough(it.date)) continue;
          if (f.filter && !looksAI(it.title)) continue;
          out.push({
            source: f.name, kind: f.kind, auth: f.auth,
            title: it.title, url: it.link,
            points: 0, comments: 0, createdAt: new Date(it.date).toISOString(), note: "",
          });
        }
      } catch (e) { console.error(`  [${f.name}] 失败: ${e.message}`); }
    })
  );
  return out;
}

// ── 源 2：Hugging Face 论文榜（社区投票的每日论文精选）───────────────
async function fetchHFPapers() {
  try {
    const arr = await getJSON("https://huggingface.co/api/daily_papers?limit=25");
    return (arr ?? [])
      .map((p) => {
        const paper = p.paper ?? p;
        if (!paper?.title || !paper?.id) return null;
        return {
          source: "HF Papers", kind: "论文",
          title: String(paper.title).replace(/\s+/g, " ").trim(),
          url: `https://huggingface.co/papers/${paper.id}`,
          points: paper.upvotes ?? 0, comments: p.numComments ?? 0,
          createdAt: p.publishedAt ?? paper.publishedAt ?? new Date().toISOString(),
          note: "",
        };
      })
      .filter(Boolean)
      .filter((it) => freshEnough(it.createdAt, MAX_PAPER_AGE_D))
      .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
  } catch (e) { console.error(`  [HF Papers] 失败: ${e.message}`); return []; }
}

// ── 源 3：Hacker News（Algolia 关键词搜索，同信息雷达）───────────────
async function fetchHN() {
  const since = Math.floor((Date.now() - MAX_AGE_D * 864e5) / 1000);
  const queries = ["AI", "LLM", "Claude", "OpenAI", "Anthropic", "Gemini", "open source model", "agent"];
  const seen = new Map();
  await Promise.all(
    queries.map(async (q) => {
      try {
        const data = await getJSON(
          `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(q)}&numericFilters=created_at_i>${since}&hitsPerPage=20`
        );
        for (const h of data.hits ?? []) {
          if (!h.title || seen.has(h.objectID)) continue;
          seen.set(h.objectID, {
            source: "Hacker News", kind: "社区", title: h.title,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            points: h.points ?? 0, comments: h.num_comments ?? 0,
            createdAt: h.created_at, note: "",
          });
        }
      } catch (e) { console.error(`  [HN] "${q}" 失败: ${e.message}`); }
    })
  );
  return [...seen.values()].filter((it) => looksAI(it.title))
    .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
}

// ── 源 4：GitHub Trending（今日新增 star，AI 关键词过滤）─────────────
async function fetchGitHubTrending() {
  try {
    const html = await getText("https://github.com/trending?since=daily", 15000, {
      "User-Agent": "Mozilla/5.0 (compatible; tiyao/1.0)", Accept: "text/html",
    });
    const blocks = html.match(/<article[^>]*class="[^"]*Box-row[^"]*"[\s\S]*?(?=<article[^>]*class="[^"]*Box-row[^"]*"|$)/g) ?? [];
    const out = [];
    for (const b of blocks) {
      const name = b.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="\/([^/"]+\/[^/"]+)"/)?.[1]?.trim();
      if (!name) continue;
      const desc = (b.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "")
        .replace(/<[^>]+>/g, "").trim();
      const todayStars = parseInt((b.match(/([\d,]+)\s+stars?\s+today/i)?.[1] ?? "0").replace(/,/g, ""), 10);
      out.push({
        source: "GitHub", kind: "开源", title: name, url: `https://github.com/${name}`,
        points: todayStars, comments: 0,
        createdAt: new Date().toISOString(), note: decodeEntities(desc),
      });
    }
    return out.filter((it) => looksAI(it.title + " " + it.note))
      .sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
  } catch (e) { console.error(`  [GitHub] 失败: ${e.message}`); return []; }
}

// ── 源 5：Lobste.rs（AI 标签，源头已干净；Reddit 已被 IP 层封禁弃用）──
async function fetchLobsters() {
  try {
    const arr = await getJSON("https://lobste.rs/t/ai.json");
    return (arr ?? []).filter((s) => s.title && freshEnough(s.created_at)).map((s) => ({
      source: "Lobste.rs", kind: "社区", title: decodeEntities(s.title),
      url: s.url || s.short_id_url,
      points: s.score ?? 0, comments: s.comment_count ?? 0,
      createdAt: s.created_at, note: "",
    })).sort((a, b) => b.points - a.points).slice(0, PER_SOURCE);
  } catch (e) { console.error(`  [Lobste.rs] 失败: ${e.message}`); return []; }
}

// ── 去重：URL 归一化 + 跨源合并 ─────────────────────────────────────
function canonical(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
  } catch { return url; }
}
function dedupe(items) {
  const map = new Map();
  let merged = 0;
  for (const it of items) {
    const key = canonical(it.url);
    if (map.has(key)) {
      const p = map.get(key);
      p.points += it.points; p.comments += it.comments;
      p.auth = Math.max(p.auth ?? 0, it.auth ?? 0);
      if (!p.sources.includes(it.source)) p.sources.push(it.source);
      if (!p.note && it.note) p.note = it.note;
      merged++;
    } else map.set(key, { ...it, sources: [it.source] });
  }
  return { items: [...map.values()], merged };
}

// ── 打分 ────────────────────────────────────────────────────────────
// 热度源：源内归一化(0–100) × 时效 —— star/赞/upvote 量纲不同，各自源内拉平再比。
// 官方/博客源：无投票数据 → 权威度基准分 × 时效（半衰期更长），保证一手发布不被淹没。
function score(items) {
  const rawHeat = (it) => it.points + COMMENT_WEIGHT * it.comments;
  const groups = {};
  for (const it of items) {
    if (it.auth) continue;
    (groups[it.sources[0]] ??= []).push(rawHeat(it));
  }
  const bounds = {};
  for (const [g, arr] of Object.entries(groups)) bounds[g] = { min: Math.min(...arr), max: Math.max(...arr) };

  const now = Date.now();
  return items.map((it) => {
    const ageH = Math.max(0, (now - new Date(it.createdAt).getTime()) / 3.6e6);
    let normHeat, recency;
    if (it.auth) {
      normHeat = it.auth;
      recency = Math.pow(0.5, ageH / OFFICIAL_HALFLIFE_H);
    } else {
      const { min, max } = bounds[it.sources[0]];
      const raw = rawHeat(it);
      normHeat = max === min ? 60 : (100 * (raw - min)) / (max - min);
      recency = Math.pow(0.5, ageH / RECENCY_HALFLIFE_H);
    }
    return { ...it, raw: rawHeat(it), normHeat, ageH, recency, score: normHeat * recency };
  }).sort((a, b) => b.score - a.score);
}

// ── 中文标题 + 推荐理由：优先 LLM，失败/无 key 自动降级启发式 ────────
function heuristicReason(it) {
  if (it.auth && it.kind === "官方") return `${it.sources[0]} 官方发布，一手信息，${it.ageH < 24 ? "今天刚出" : "仍在时效内"}。`;
  if (it.auth) return `${it.sources[0]} 出品，长期高信噪比的信源。`;
  if (it.sources.length > 1) return `被 ${it.sources.join(" 与 ")} 同时顶上来，跨社区共识强。`;
  if (it.kind === "论文") return `HuggingFace 论文榜 ${it.points} 票，今日研究者最关注的工作之一。`;
  if (it.kind === "开源") return `GitHub 今日新增 ${it.points} 星，正在起势的开源项目。`;
  if (it.comments > it.points) return `讨论热度超过点赞（${it.comments} 条评论），争议或信息密度都在评论区。`;
  if (it.ageH < 12) return `发布不到 ${Math.max(1, Math.round(it.ageH))} 小时就冲进榜单，时效性强。`;
  return `${it.sources[0]} 当日高热（${it.points} 赞 / ${it.comments} 评论），社区认可度高。`;
}

async function enrich(top) {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const fallback = () => {
    for (const it of top) { it.zh = ""; it.reason = heuristicReason(it); }
  };
  if (!(baseUrl && apiKey) && !anthropicKey) {
    fallback();
    return "启发式（未配置 LLM key）";
  }
  const list = top.map((it, i) =>
    `${i + 1}. [${it.kind}·${it.sources.join("+")}] ${it.title}${it.note ? " — " + it.note.slice(0, 120) : ""}`
  ).join("\n");
  const prompt =
    `你是中文 AI 资讯主编，眼光挑剔、文字克制。下面是今日 Top ${top.length} 条 AI 资讯。` +
    `请为每条给出：zh = 信达雅的中文标题（不超过 28 字，专有名词保留英文），` +
    `why = 一句不超过 36 字的「为什么值得读」，说清它对从业者/关注者的实际含金量，不要空话。` +
    `只输出一个 JSON 数组，元素为 {"zh":"…","why":"…"}，共 ${top.length} 个，不要任何多余文字。\n\n${list}`;
  try {
    let text;
    if (baseUrl && apiKey) {
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`.replace("/v1/v1/", "/v1/"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || "deepseek-chat",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
        }),
      });
      if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
      text = (await r.json()).choices?.[0]?.message?.content ?? "";
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
      text = (await r.json()).content?.[0]?.text ?? "";
    }
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    if (!Array.isArray(arr) || arr.length < top.length) throw new Error("LLM 返回格式异常");
    top.forEach((it, i) => {
      it.zh = String(arr[i]?.zh ?? "").trim();
      it.reason = String(arr[i]?.why ?? "").trim() || heuristicReason(it);
    });
    return "LLM";
  } catch (e) {
    console.error(`  [LLM] 失败，降级启发式：${e.message}`);
    fallback();
    return `启发式（LLM 失败：${e.message}）`;
  }
}

// ── 日期工具（刊期以北京时间为准）───────────────────────────────────
function cstToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
function zhDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const week = "日一二三四五六"[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y} 年 ${m} 月 ${d} 日 · 星期${week}`;
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`🗞  ${SITE_NAME} · AI Daily Digest 启动 …（6 类源，零密钥可跑）\n`);

  const [feeds, papers, hn, gh, lob] = await Promise.all([
    fetchFeeds(), fetchHFPapers(), fetchHN(), fetchGitHubTrending(), fetchLobsters(),
  ]);
  const raw = [...feeds, ...papers, ...hn, ...gh, ...lob];
  console.log(
    `① 抓取：官方/博客 ${feeds.length} + HF论文 ${papers.length} + HN ${hn.length} + GitHub ${gh.length} + Lobste.rs ${lob.length} = ${raw.length} 条`
  );

  const { items, merged } = dedupe(raw);
  console.log(`② 去重：${raw.length} → ${items.length} 条（合并 ${merged} 组跨源/重复）`);

  const ranked = score(items);
  console.log(`③ 打分：热度源内归一化 / 官方按权威度 × 时效，候选池 ${ranked.length} 条`);

  // 单源配额：分数从高到低取，每个主信源最多 SOURCE_CAP 条——
  // 否则 GitHub Trending 这类高产源会刷满一期，失去「一份日报」的结构感。
  const top = [];
  const used = {};
  for (const it of ranked) {
    const g = it.sources[0];
    if ((used[g] ?? 0) >= SOURCE_CAP) continue;
    used[g] = (used[g] ?? 0) + 1;
    top.push(it);
    if (top.length >= TOP_N) break;
  }
  const via = await enrich(top);
  console.log(`④ 中文标题与理由：${via}\n`);

  top.forEach((it, i) => {
    console.log(`${i + 1}. [${it.kind}·${it.sources.join("+")}] ${it.zh || it.title}`);
    console.log(`   ${it.url}`);
    console.log(`   💡 ${it.reason}\n`);
  });

  // 产出
  const date = cstToday();
  const dir = import.meta.dirname;
  fs.mkdirSync(path.join(dir, "digests"), { recursive: true });
  fs.mkdirSync(path.join(dir, "archive"), { recursive: true });

  const pastIssues = fs.readdirSync(path.join(dir, "archive"))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map((f) => f.slice(0, 10)).filter((d) => d !== date).sort().reverse();
  const issueNo = pastIssues.length + 1;
  const stats = { raw: raw.length, dedup: items.length, merged, via, sources: new Set(raw.map((r) => r.source)).size };

  const html = renderHTML({ date, issueNo, stats, top, all: ranked, pastIssues });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf-8");
  fs.writeFileSync(path.join(dir, "archive", `${date}.html`), html, "utf-8");
  fs.writeFileSync(path.join(dir, "digests", `${date}.md`), renderMarkdown(date, issueNo, stats, top), "utf-8");
  fs.writeFileSync(path.join(dir, "feed.xml"), renderRSS(date, top), "utf-8");

  console.log(`📝 digests/${date}.md · 🌐 index.html + archive/${date}.html · 📡 feed.xml`);
  console.log(`⏱  第 ${issueNo} 期 · 全程 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── 渲染：Markdown 日报 ─────────────────────────────────────────────
function renderMarkdown(date, issueNo, s, top) {
  const L = [`# ${SITE_NAME} · 第 ${issueNo} 期 · ${date}\n`];
  L.push(`> ${s.sources} 个信源抓取 ${s.raw} 条 → 去重 ${s.dedup} 条 → 打分 → Top ${top.length}｜标题与理由：${s.via}\n`);
  top.forEach((it, i) => {
    L.push(`## ${i + 1}. ${it.zh || it.title}`);
    if (it.zh) L.push(`*${it.title}*`);
    L.push(`- 🔗 ${it.url}`);
    L.push(`- 📡 ${it.kind} · ${it.sources.join(" + ")}　💡 ${it.reason}\n`);
  });
  L.push(`---\n*${SITE_NAME} · ${SITE_URL}*`);
  return L.join("\n");
}

// ── 渲染：RSS 2.0（订阅入口）────────────────────────────────────────
function xesc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderRSS(date, top) {
  const pub = new Date().toUTCString();
  const items = top.map((it) => `  <item>
    <title>${xesc(it.zh ? `${it.zh}` : it.title)}</title>
    <link>${xesc(it.url)}</link>
    <guid isPermaLink="false">${xesc(canonical(it.url))}-${date}</guid>
    <pubDate>${pub}</pubDate>
    <description>${xesc(`${it.reason}（${it.kind} · ${it.sources.join(" + ")}${it.zh ? " · 原题 " + it.title : ""}）`)}</description>
  </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${SITE_NAME} · ${SITE_TAG}</title>
  <link>${SITE_URL}</link>
  <description>每天替你把 AI 世界读一遍，只留提要。每日 Top ${TOP_N}，每条一句「为什么值得读」。</description>
  <language>zh-cn</language>
  <lastBuildDate>${pub}</lastBuildDate>
${items}
</channel>
</rss>`;
}

// ── 渲染：报刊质感网页（服务端静态渲染，零外部依赖）─────────────────
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function renderHTML({ date, issueNo, stats, top, all, pastIssues }) {
  const [lead, ...rest] = top;
  const itemHTML = (it, i) => `
<article class="item">
  <div class="no">${String(i + 2).padStart(2, "0")}</div>
  <div class="body">
    <div class="kind">${esc(it.kind)} · ${esc(it.sources.join(" + "))}</div>
    <h3><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.zh || it.title)}</a></h3>
    ${it.zh ? `<div class="orig">${esc(it.title)}</div>` : ""}
    <p class="why">${esc(it.reason)}</p>
  </div>
</article>`;

  const leadHTML = lead ? `
<article class="lead">
  <div class="kind">今日头条 · ${esc(lead.kind)} · ${esc(lead.sources.join(" + "))}</div>
  <h2><a href="${esc(lead.url)}" target="_blank" rel="noopener noreferrer">${esc(lead.zh || lead.title)}</a></h2>
  ${lead.zh ? `<div class="orig">${esc(lead.title)}</div>` : ""}
  <p class="why">${esc(lead.reason)}</p>
</article>` : `<p class="why">今日抓取异常，暂无内容——明早八点自动重试。</p>`;

  const poolHTML = all.slice(0, 60).map((it, i) =>
    `<div class="row"><span>${String(i + 1).padStart(2, "0")}</span> <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a> <em>${esc(it.kind)} · ${it.score.toFixed(0)} 分</em></div>`
  ).join("\n");

  const pastHTML = pastIssues.slice(0, 30).map(
    (d, idx) => `<a href="archive/${d}.html">第 ${pastIssues.length - idx} 期 · ${d}</a>`
  ).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SITE_NAME} · 第 ${issueNo} 期 · ${date}</title>
<meta name="description" content="每天替你把 AI 世界读一遍，只留提要。每日 Top ${TOP_N} AI 资讯，每条一句「为什么值得读」。">
<meta property="og:title" content="${SITE_NAME} · ${SITE_TAG}">
<meta property="og:description" content="每天替你把 AI 世界读一遍，只留提要。">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="feed.xml">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23161412'/%3E%3Ctext x='50' y='72' font-size='62' text-anchor='middle' fill='%23c9a962' font-family='serif'%3E%E6%8F%90%3C/text%3E%3C/svg%3E">
<style>
:root{
  --paper:#f7f3ec; --ink:#1c1a17; --ink2:#57524a; --mut:#8d867b;
  --gold:#8f6f2e; --line:#e2dbce; --line2:#cfc6b4;
}
@media (prefers-color-scheme: dark){
  :root{--paper:#161412; --ink:#e8e2d6; --ink2:#b0a897; --mut:#7d7669; --gold:#c9a962; --line:#2b2823; --line2:#3d382f;}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font:16px/1.75 Georgia,"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","SimSun",serif;
}
a{color:inherit; text-decoration:none}
.wrap{max-width:720px; margin:0 auto; padding:0 22px 72px}

/* ── 刊头 ── */
header{text-align:center; padding:52px 0 0}
.masthead{font-size:56px; line-height:1.1; letter-spacing:.18em; margin:0; font-weight:700; text-indent:.18em}
.tagline{font-size:11px; letter-spacing:.42em; text-indent:.42em; color:var(--gold); margin:10px 0 0; text-transform:uppercase}
.rule{border:0; border-top:1px solid var(--ink); margin:26px 0 0; position:relative}
.rule+.rule{border-top:1px solid var(--line2); margin-top:3px}
.issue{display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; font-size:12.5px; color:var(--ink2); padding:10px 0; letter-spacing:.06em}
.issue b{color:var(--ink); font-weight:400}
.motto{font-size:14px; color:var(--ink2); margin:34px 0 0; letter-spacing:.12em}

/* ── 头条 ── */
.lead{margin:44px 0 8px; padding-bottom:36px; border-bottom:1px solid var(--line)}
.kind{font-size:11px; letter-spacing:.28em; color:var(--gold); margin-bottom:12px}
.lead h2{font-size:30px; line-height:1.45; margin:0 0 10px; font-weight:700}
.lead h2 a:hover,.item h3 a:hover{border-bottom:1px solid var(--gold)}
.orig{font-size:13px; color:var(--mut); font-style:italic; margin-bottom:10px; overflow-wrap:anywhere}
.why{font-size:15px; color:var(--ink2); margin:8px 0 0}
.why::before{content:"── "; color:var(--gold)}

/* ── 条目 ── */
.item{display:flex; gap:20px; padding:30px 0; border-bottom:1px solid var(--line)}
.no{font-size:26px; color:var(--line2); font-style:italic; min-width:44px; line-height:1.3}
.item h3{font-size:19.5px; line-height:1.5; margin:0 0 6px; font-weight:700}
.item .why{font-size:14px}
.item .kind{margin-bottom:8px}

/* ── 订阅 ── */
.subscribe{margin:56px 0 0; padding:34px 30px; border:1px solid var(--line2); text-align:center}
.subscribe h4{margin:0 0 8px; font-size:17px; letter-spacing:.2em}
.subscribe p{margin:0 0 18px; font-size:13.5px; color:var(--ink2)}
.rss{display:inline-block; border:1px solid var(--gold); color:var(--gold); padding:9px 26px; font-size:13px; letter-spacing:.18em; cursor:pointer; background:none; font-family:inherit}
.rss:hover{background:var(--gold); color:var(--paper)}
.hint{font-size:12px; color:var(--mut); margin-top:12px; overflow-wrap:anywhere}

/* ── 候选池 / 往期 ── */
details{margin-top:48px}
summary{cursor:pointer; font-size:13px; color:var(--mut); letter-spacing:.1em}
.row{padding:7px 0; border-bottom:1px solid var(--line); font-size:13.5px; overflow-wrap:anywhere}
.row span{color:var(--line2); font-style:italic; margin-right:6px}
.row em{color:var(--mut); font-size:12px; font-style:normal; margin-left:6px}
.row a:hover{color:var(--gold)}
.past{display:flex; flex-direction:column; gap:6px; padding-top:10px; font-size:13.5px}
.past a:hover{color:var(--gold)}

footer{margin-top:64px; padding-top:18px; border-top:1px solid var(--ink); font-size:12px; color:var(--mut); display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; letter-spacing:.05em}
footer a{border-bottom:1px solid var(--line2)}
footer a:hover{color:var(--gold)}

@media (max-width:520px){
  .masthead{font-size:42px}
  .lead h2{font-size:24px}
  .item{gap:14px}
  .no{min-width:34px; font-size:21px}
}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1 class="masthead">${SITE_NAME}</h1>
  <p class="tagline">${SITE_TAG}</p>
  <hr class="rule"><hr class="rule">
  <div class="issue">
    <span>第 <b>${issueNo}</b> 期</span>
    <span>${zhDate(date)}</span>
    <span>${stats.sources} 源 ${stats.raw} 条 → 精选 <b>${top.length}</b></span>
  </div>
  <p class="motto">每天替你把 AI 世界读一遍，只留提要。</p>
</header>

<main>
${leadHTML}
${rest.map(itemHTML).join("\n")}

<section class="subscribe">
  <h4>订　阅</h4>
  <p>每天早晨八点（北京时间）自动出刊。用任意 RSS 阅读器（Follow、Feedly、NetNewsWire）即可订阅。</p>
  <button class="rss" id="rss-btn" type="button">复制 RSS 订阅链接</button>
  <div class="hint" id="rss-hint">feed.xml</div>
</section>

<details>
  <summary>完整候选池（${all.length} 条，按分数排序，展示前 60）</summary>
  ${poolHTML}
</details>

${pastIssues.length ? `<details open>
  <summary>往期（${pastIssues.length} 期）</summary>
  <div class="past">${pastHTML}</div>
</details>` : ""}
</main>

<footer>
  <span>${SITE_NAME} · 抓取 → 去重 → 打分 → 精选，每日自动出刊</span>
  <span><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">源码</a> · <a href="feed.xml">RSS</a></span>
</footer>

</div>
<script>
(function(){
  var btn=document.getElementById('rss-btn'),hint=document.getElementById('rss-hint');
  var url=new URL('feed.xml',location.href).href;
  hint.textContent=url;
  btn.addEventListener('click',function(){
    function ok(){btn.textContent='已复制 ✓';setTimeout(function(){btn.textContent='复制 RSS 订阅链接'},1600)}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).then(ok,function(){fallback()})}
    else{fallback()}
    function fallback(){
      try{var ta=document.createElement('textarea');ta.value=url;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);ok()}
      catch(e){hint.textContent='请手动复制：'+url}
    }
  });
})();
</script>
</body>
</html>`;
}

main().catch((e) => { console.error("❌ 运行失败：", e); process.exit(1); });
