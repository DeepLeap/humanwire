<div align="center">

# HumanWire

在你的 AI Agent 里匹配陌生人，认识同好。

<p>
  <a href="https://github.com/DeepLeap/humanwire/releases"><img src="https://img.shields.io/github/v/release/DeepLeap/humanwire?style=flat-square" alt="GitHub 版本" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0D0D0D?style=flat-square&labelColor=0D0D0D&color=F2F5F1" alt="MIT License" /></a>
</p>

<p><a href="./README.md">English</a> | <b>简体中文</b></p>

</div>

对你的 AI Agent 说一句「帮我找个也喜欢 Blender 的人聊聊」，它就可以通过 HumanWire 发起一对一匹配。连接后，你可以在小窗里和对方直接聊。你也可以从小窗发起匹配，填关键词找同好，留空找人闲聊。

## 开始匹配

从 GitHub 获取源码，需要 **Node.js 22 或更新版本**。

```sh
git clone https://github.com/DeepLeap/humanwire.git
cd humanwire
npm run chat
```

1. 用浏览器打开终端显示的本地链接。
2. 选「找同好」，填写昵称和最多五个可公开的关键词，例如 `blender, 3d 动画`。不填关键词则进入闲聊匹配。
3. 点击「开始匹配」。连接后，在小窗输入消息并按回车。结束时点击「结束」。

关键词会归一化大小写、空格和常见全角字符。按兴趣匹配时，双方都要在线寻找同好，且至少有一个归一后的关键词相同。例如 `Blender, 3D 动画` 可以和 `blender, 动态设计` 匹配。匹配机会取决于当前在线情况，也可以让 AI 先根据你愿意公开的兴趣建议关键词。

## 让 AI 帮你找人

将 HumanWire 配置为本地 stdio MCP 服务。把脚本路径替换为你实际的绝对路径：

```json
{
  "mcpServers": {
    "humanwire": {
      "command": "node",
      "args": ["/absolute/path/to/humanwire/src/index.js", "--chat-window"]
    }
  }
}
```

可以对 AI 说「帮我找个也想聊 Blender 的人，并打开 HumanWire 小窗」。AI 可以用逗号分隔的 `keywords` 调用 `start_matching`，再调用 `open_chat_window`。小窗使用同一个会话，聊天正文留在小窗。只要本地 MCP 进程仍在运行，AI 空闲时也能收信。浏览器允许时，还可以启用桌面未读提醒与本地翻译。

如果要在 AI 的原生对话里收发，启动时省略 `--chat-window`。这种模式下，宿主调用 `poll_messages` 后才会显示新消息，单次等待最长 25 秒。支持独立界面的宿主可以适配内嵌聊天卡片。详见[宿主适配指南](./docs/INTEGRATION.md)和 [AI 工具流程](./SKILL.md)。

以上示例使用 GitHub 上的 v0.5.1 源码。从 [npm](https://www.npmjs.com/package/humanwire-mcp) 安装时，请先确认发布版本是否支持兴趣关键词和 `--chat-window`。

## 邀请朋友和逛广场

- **房间码**。在小窗选择房间，或调用 `join_room`。可以生成房间码邀请朋友，也可以输入别人发给你的房间码。
- **公共广场**。在原生 MCP 模式下，用 `join_plaza` 进入公开话题区。中继可提供最近 24 小时窗口内的部分留言，实际回放取决于中继。请把留言当作公开内容。

## 网络和隐私

默认中继模式仅使用 Node.js 标准库，经公共 Nostr 中继传递加密私聊。中继运营方仍能看到连接元数据，例如客户端的连入 IP，使用代理时则可见代理出口 IP。昵称和协议握手仅用于建立会话，平台没有对对方现实身份作验证。

- **使用代理**。如果已有兼容的本地代理，可以在 MCP 启动参数中添加 `--proxy socks5h://127.0.0.1:9050` 或 `--proxy http://127.0.0.1:7890`。使用 `socks5h` 时，由代理端解析中继域名。
- **点对点直连**。安装可选的 `hyperswarm` 后，用 `--transport p2p --allow-ip-exposure` 启用。对方可能看到你的公网 IP 和端口。与陌生人聊天时，可用默认中继模式避免直接暴露 IP。
- **对端内容**。把收到的文字、链接和图片视为不可信内容。消息过滤覆盖常见凭据和敏感格式。原生 MCP 路径会标记不可信文本，收到的图片保存在内存中，需调用 `inspect_image` 查看。

## MCP 工具

| 工具 | 用途 |
| :--- | :--- |
| `start_matching` | 使用 1–5 个以逗号分隔的 `keywords` 匹配陌生人。省略关键词时按精确 `channel` 匹配，默认为 `chat/casual`。 |
| `open_chat_window` | 在 `--chat-window` 模式下，打开当前会话的小窗。 |
| `join_room` | 通过房间码创建或加入加密房间。 |
| `get_status` / `leave_chat` | 查看状态或退出当前会话。 |
| `poll_messages` / `send_to_peer` | 在原生 MCP 模式下收发文字，发送时可选择 `auto_sanitize`。 |
| `join_plaza` | 在原生 MCP 模式下加入公共广场。 |
| `send_image_file` / `inspect_image` | 在原生 MCP 模式下发送 PNG、JPEG 或 WebP 图片，或查看内存中的图片。 |
| `issue_vouch` | 在原生 MCP 模式下为会话对端签发信誉凭证。 |

## 开发与测试

在仓库目录运行 `npm test`。协议设计见[架构说明](./docs/ARCHITECTURE.md)，宿主接入见[适配指南](./docs/INTEGRATION.md)。

## 开源协议

MIT © [YUKE · DeepLeap](https://github.com/DeepLeap) ([dangiakodi@gmail.com](mailto:dangiakodi@gmail.com))
