# HumanWire client integration

HumanWire matches strangers who are online and want to talk about a shared interest. This guide explains how an AI client can help start that match while keeping the human conversation separate from the model.

## 原理

1. **AI 帮忙找人。** 从用户当前的请求中提炼一到五个可以公开的兴趣关键词，例如 `桌游, 合作游戏`。用户也可以直接填写。没有主题时，走 `chat/casual` 闲聊频道。
2. **HumanWire 建立会话。** 关键词模式先在共用大厅发现候选客户端，然后在握手中比较双方的关键词。有至少一个相同才会建立一对一会话。连接成功表示对端客户端已接入，是否本人在场要看对方是否接话。
3. **聊天界面自己等消息。** 小窗和发起匹配的 MCP 服务共用一个会话。对端消息到达本地收件箱后，正在等待的浏览器请求会立即返回，界面可以显示消息。AI 这一轮已经结束，收信也能继续。正文和浏览器翻译都走小窗，模型只负责发起匹配、管理会话和看连接状态。
4. **宿主决定显示位置。** 当前通用入口是独立小窗。只支持标准 MCP 的宿主可以在当前一轮调用 `poll_messages` 等消息。支持独立界面的宿主可以适配对话内卡片，由卡片自己接收。原生对话框能否在 AI 空闲时插入新消息，取决于宿主提供的接口。

## Choose an integration route

| Host capabilities | Use | What happens when the model is idle |
| --- | --- | --- |
| Browser next to any AI client | Run `npm run chat` and open the printed local link. The user can paste interests suggested by any assistant. | The browser receives messages independently of the AI client. Keep the window and HumanWire process open. |
| Local MCP host that can launch a browser | Start the server with `--chat-window`. Use `start_matching` and `open_chat_window` on the same connection. | The window receives messages from the same session while the host keeps the MCP process alive. |
| Standard MCP tools only | Run the regular MCP server, then call `poll_messages` and `send_to_peer` in the current turn. | The server queues incoming messages. The model sees them when the host calls the tool. A call can wait up to 25 seconds. Returned text enters the host's tool context. |
| Host that supports an in-conversation app surface | Implement a host adapter for an embedded chat card. | The card can receive messages while the model is idle if the host keeps the view and its connection alive. This is an adapter design, not a feature shipped in this repository. |

## Match with public keywords

```json
{
  "name": "start_matching",
  "arguments": {
    "keywords": "board games, co-op games",
    "nickname": "North"
  }
}
```

The `keywords` parameter is a string of 1–5 short words or phrases separated by commas. The service normalizes Unicode width, case and whitespace. It compares full normalized terms, so the assistant can map aliases such as `cooperative games` to `co-op games` before calling the tool. Specify `channel` and omit `keywords` for exact-channel matching. For general chat with no interests specified, the default is `chat/casual`.

Use only terms the user is comfortable sharing with candidates. Keep private project names, contacts, conversation history, and full profiles out of the match request. Results depend on who is online and which peers can reach the same relay network. See the [matching manager](../src/p2p.js).

## Connect a client with a local MCP server

With Node.js 22 or newer, configure the host to run the local checkout:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/humanwire/src/index.js", "--chat-window"]
}
```

1. After the user asks to meet someone, call `start_matching` with their preferences.
2. When the user wants to chat, call `open_chat_window`. It opens a window for the existing matching session. The tool result does not contain the browser access token.
3. Use `get_status` for connection state. The window handles chat input, receive, local translation where available, and optional desktop unread notifications. Use `leave_chat` or the window's End button to leave.

The local browser connects to the same manager on loopback. It keeps one receive request open, with a wait of up to 20 seconds per request. The request returns when a message arrives. The browser opens a new request without asking the model to run. Use one active receiving window per session because the receiver drains a shared inbox. See the [MCP entry point](../src/index.js) and [local window server](../src/chat-window.js).

## Adapt to an embedded chat card

An adapter needs a host-provided UI component, its own receive loop, and a way to submit human text directly from the card. For a host that supports [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html), the card can use [app-only send and receive tools](https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html#tools-that-are-private-to-apps). Return only display state from model-visible tools. Do not pass chat text to the model via `ui/message` or `ui/update-model-context`.

Use the card's composer for Enter or an optional slash prefix. Handling the host's main input box requires a separate host extension. Render nickname and text as plain text, keep translations on the UI side, and clear or partition the transcript when the session ID changes. Before listing a host as compatible, test a reply with the model idle and check that message text stays out of its conversation context.
