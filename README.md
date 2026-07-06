# 提要 · AI Daily Digest

> 每天替你把 AI 世界读一遍，只留提要。

一份**每日自动出刊**的中文 AI 资讯精选：6 类信源抓取 → 去重 → 打分 → Top 10，每条配一句「为什么值得读」。报刊质感的排版，RSS 即可订阅，零服务器、零成本运行在 GitHub Actions + Pages 上。

**在线阅读**：<https://hannahlovegood.github.io/tiyao/>
**RSS 订阅**：<https://hannahlovegood.github.io/tiyao/feed.xml>

## 它怎么保证「含金量」

1. **信源本身先过筛**——不抓营销号，只抓 6 类一手/高信噪比源：
   - 官方发布：OpenAI / Anthropic / Google AI / DeepMind（Anthropic 走社区维护的 RSS 镜像）
   - 研究：Hugging Face Daily Papers（社区投票的论文榜，窗口 5 天覆盖周末空档）
   - 开源：GitHub Trending（AI 关键词过滤，按今日新增 star）
   - 社区：Hacker News（Algolia）、Lobste.rs（AI 标签）
   - 精选博客：Hugging Face Blog、Simon Willison
2. **单源配额**——每期每个信源最多 3 条，GitHub 再热也不能刷满一期，保证「官方 / 论文 / 开源 / 社区」的日报结构。
3. **跨源去重合并**——同一条新闻被多个社区顶上来会合并热度，「跨社区共识」本身就是含金量信号。
4. **打分规则可解释**——
   - 热度源：源内归一化（star / 赞 / upvote 量纲不同，各自源内拉平到 0–100）× 时效衰减（半衰期 48h）；
   - 官方/博客源没有投票数据：按**权威度基准分**（一线实验室 95 → 精选个人博客 78）× 更慢的时效衰减（72h），保证一手发布不被社区热帖淹没。
5. **每条一句「为什么值得读」**——配了 LLM key 时由模型写中文标题翻译 + 推荐理由；没有 key 自动降级为可解释的启发式理由（零成本仍每日出刊）。

## 本地跑

```bash
node tiyao.mjs                 # 零密钥：启发式理由 + 原文标题

# 可选：接任意 OpenAI 兼容 API（DeepSeek / Kimi / 智谱 / 通义 …），升级为 LLM 中文标题+理由
LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node tiyao.mjs

# 或 Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx node tiyao.mjs
```

产出：

- `index.html` — 今日刊（自包含单文件，双击可看）
- `archive/YYYY-MM-DD.html` — 每日存档（往期页）
- `feed.xml` — RSS 2.0 订阅源
- `digests/YYYY-MM-DD.md` — Markdown 日报

## 自动出刊

`.github/workflows/daily.yml`：每天 00:00 UTC（北京时间早八点）自动重跑并提交，GitHub Pages 随之更新。想用 LLM 版理由，在仓库 **Settings → Secrets and variables → Actions** 配：

| 名称 | 类型 | 说明 |
|---|---|---|
| `LLM_API_KEY` | Secret | OpenAI 兼容 API key |
| `LLM_BASE_URL` | Variable | 如 `https://api.deepseek.com` |
| `LLM_MODEL` | Variable | 如 `deepseek-chat` |

## License

MIT
