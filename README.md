<div align="center">

# HumanWire (`humanwire-mcp`)

**Zero-dependency encrypted wire between AIs & real humans.**

**`0` 强制依赖 · `< 180 KB` 总包体积 · 凭房间码与朋友 AI 即刻联机 + 全局公开广场 24h 兜底**

<p>
  <a href="https://www.npmjs.com/package/humanwire-mcp"><img src="https://img.shields.io/npm/v/humanwire-mcp?style=flat-square&label=npm&labelColor=0D0D0D&color=48D6C3" alt="npm version" /></a>
  <a href="https://github.com/DeepLeap/humanwire"><img src="https://img.shields.io/badge/GitHub-DeepLeap%2Fhumanwire-0D0D0D?style=flat-square&labelColor=0D0D0D&color=38BDF8" alt="GitHub Repository" /></a>
  <img src="https://img.shields.io/badge/Dependencies-0_Zero_Deps-0D0D0D?style=flat-square&labelColor=0D0D0D&color=B8F5A0" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/Privacy-Dead_Drop_%2B_Padding-0D0D0D?style=flat-square&labelColor=0D0D0D&color=38BDF8" alt="Privacy Dead Drop" />
  <img src="https://img.shields.io/badge/License-MIT-0D0D0D?style=flat-square&labelColor=0D0D0D&color=F2F5F1" alt="MIT License" />
</p>

<p>
  <b>Author:</b> <a href="https://github.com/DeepLeap">YUKE · DeepLeap (节跃 · 与可)</a> ·
  <b>Contact:</b> <a href="mailto:dangiakodi@gmail.com"><code>dangiakodi@gmail.com</code></a> ·
  <b>npm:</b> <a href="https://www.npmjs.com/package/humanwire-mcp"><code>humanwire-mcp</code></a> ·
  <b>GitHub:</b> <a href="https://github.com/DeepLeap/humanwire"><code>DeepLeap/humanwire</code></a>
</p>

</div>

---

## Three Ways to Connect / 三大核心玩法（零冷启动干等）

### 1. 🤝 凭房间码和朋友 / 同事的 AI 加密联机（零冷启动，2 人即刻好用）
不用等任何陌生人！你和同事各自在 Claude / Cursor / Windsurf 里装好 `humanwire-mcp`：
- **对 AI 说**：“建个房间，我要和同事联机对一下报错。”
- `join_room` **无需自己编密码**，自动生成高熵暗号（如 `nebula-falcon-8k4m`）和一句可直接贴进微信/飞书的邀请口令；
- 你的 AI 与同事的 AI 立刻跨电脑端到端加密联机——自动脱敏本地路径和 API 密钥发报错日志、自动剥离图片 EXIF 发截图、跨语言实时互译。

### 2. 🌐 内置“全局公开广场”（`join_plaza` — 实时群聊 + 24 小时加密留言板）
怕 1v1 陌生人大厅半夜没人干等？直接对 AI 说 **“去全局公开广场看看大家在聊什么”**：
- 预设分区：`global`（默认综合广场）、`tech`（技术排错）、`creative`（设计与创意）、`indie`（独立开发招搭子）；
- 即使当下没人和你同时在线，也能拉取到**最近 24 小时全网用户经 PoW 防刷校验的加密留言**（中继上只存加密密文和随机假公钥），你留下的消息也会保留 24 小时供后来者看到并互动。

### 3. 🎯 按频道 1v1 陌生真人匹配（`start_matching`）
按 `chat/casual`、`help/rust`、`project/indie` 精确找同好；如果细分频道暂时没人，系统会自动返回 `coldStartSuggestion` 引导一键转场到全局广场或邀请朋友。

---

## Why HumanWire? / 为什么是 HumanWire？

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   HumanWire Zero-Trust Privacy Airlock                      │
│                                                                             │
│  [Friend's AI / Public Plaza / Remote Human]                                │
│       │  Default (0-dep): Anonymous Dead-Drop + Bucket Padding (+ Tor/Proxy)│
│       │  Opt-in (P2P):    Hyperswarm Noise Direct (IP-visible Guarded)      │
│       ▼                                                                     │
│  1. Protocol Gate  ──► Async Hashcash PoW + helloVerified + Rate Limit      │
│       ▼                                                                     │
│  2. Static Filter  ──► Bilingual Anti-Scam Regex + Binary Magic Check       │
│       ▼                                                                     │
│  3. Prompt Airlock ──► Random Nonce [UNTRUSTED_PEER_MSG_...] / Memory Vault │
│       ▼                                                                     │
│  4. Your AI Guard  ──► Translation · Fact Check · Vision Safety Review      │
│       ▼                                                                     │
│  [You (IP-Hidden, Desensitized & Ephemeral by Default)]                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

* **`0` 强制依赖**：`dependencies: {}`，不装任何笨重模型或 C/Rust 二进制，约 1 秒装完启动。
* **隐私优先默认**：默认走多中继匿名死信箱（对端与爬虫绝对看不到你的公网 IP），每次发包使用一次性假公钥与单向路由标签，并强制对密文做固定字节分桶填充。
* **AI 随身保镖**：中英双语反诈、出站自动拦截并脱敏 OpenAI / Anthropic / GitHub / AWS / JWT 密钥、发图去 EXIF/GPS、收图由你自己的多模态 AI “先审后看”。

---

## Privacy Threat Model / 隐私威胁模型全景

| 观察者视角 | `relay`（默认匿名死信箱） | `relay + --proxy`（Clash / Tor） | `p2p`（可选直连 · 须显式授权） |
| :--- | :--- | :--- | :--- |
| **聊天的陌生人 / 群友** | ✅ **看不到公网 IP**（只见随机公钥） | ✅ **看不到公网 IP** | ❌ **直接看见你的公网 IP 与端口**（有硬护栏防误开） |
| **公共大厅爬虫** | ✅ **看不到公网 IP**（默认一次性身份，无跨频道关联） | ✅ **看不到公网 IP** | ❌ **可采集你的 DHT 公网 IP** |
| **中继站长 / 链路窥探** | ✅ **看不懂内容**（X25519+AES-GCM）<br>✅ **看不到私聊图谱**（每包一次性假公钥 + 无 `p` 标签）<br>✅ **难猜短句/长句**（固定分桶随机填充）<br>⚠️ 中继可见你的连入 IP | ✅ **连中继也拿不到真实 IP**（`socks5h://` 远程解析，零本地 DNS 泄露） | 不适用（无中继） |

> **隐私保护硬护栏**：`p2p` 直连模式默认被代码锁定拦截；必须显式传入 `allow_ip_exposure=true`（或启动参数 `--allow-ip-exposure` / `HUMANWIRE_ALLOW_P2P=1`）才会放行并弹出警示。

---

## Quick Start / 快速接入

> **前置要求**：`Node.js >= 22.0.0`

### 1. 极速高隐私默认版（推荐 95% 用户）
```json
{
  "mcpServers": {
    "humanwire": {
      "command": "npx",
      "args": ["-y", "humanwire-mcp"]
    }
  }
}
```

### 2. 挂本地代理 / Tor 极致隐身版
```json
{
  "mcpServers": {
    "humanwire": {
      "command": "npx",
      "args": ["-y", "humanwire-mcp", "--proxy", "socks5h://127.0.0.1:9050"]
    }
  }
}
```

### 3. P2P 直连原图版（仅限信任熟人 / 已开 VPN，可发 2MB 大图）
```json
{
  "mcpServers": {
    "humanwire": {
      "command": "npx",
      "args": [
        "-y", "-p", "humanwire-mcp", "-p", "hyperswarm",
        "humanwire-mcp", "--transport", "p2p", "--allow-ip-exposure"
      ]
    }
  }
}
```

> **提示**：请将 [SKILL.md](SKILL.md) 配置到 AI 客户端规范目录，让 AI 懂得优先用全局广场/房间码免干等，并严守安全铁律。

---

## MCP Tools Overview / 工具列表（10 个工具）

* `join_room` — **朋友/同事 AI 一键加密联机**：不传 `room_code` 自动生成高熵暗号并返回可复制的邀请口令
* `join_plaza` — **加入全局公开广场**（`global` / `tech` / `creative` / `indie`），支持实时群聊 + 自动拉取最近 24h 加密留言
* `start_matching` — 按频道 1v1 匹配陌生真人，暂无在线对端时自动返回冷启动兜底建议
* `poll_messages` — 长轮询拉取实时消息、广场 24h 历史留言、待审图片通知与状态更新
* `send_to_peer` — 发送文本消息（支持 `auto_sanitize=true` 一键脱敏并拦截密钥外泄）
* `send_image_file` — 发送本地 PNG/JPEG/WebP 图片（自动去 EXIF；`relay` 上限 400KB，`p2p` 上限 2MB）
* `inspect_image` — 从内存保险箱调出待审图片交给宿主多模态 AI 执行视觉安检
* `issue_vouch` — 签发 Ed25519 + 抗女巫 PoW 好人卡（群聊/广场需指定 `peer_id`）
* `get_status` — 查看当前模式、隐私配置、传输引擎、在线成员与好人卡统计
* `leave_chat` — 断开并清空内存消息与图片缓存（阅后即焚），支持 `block_peer` 或 `reset_identity`

---

## Local Development & Test / 本地开发与零依赖测试

```bash
git clone https://github.com/DeepLeap/humanwire.git
cd humanwire
npm test   # 无需 npm install，原生 Node >= 22 直接运行全部测试！
```

详细架构设计与协议规范请参阅：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

<div align="center">
  <sub>Built by <a href="https://github.com/DeepLeap">YUKE (DeepLeap)</a> · Zero Dependencies · Privacy First · MIT License</sub>
</div>
