<div align="center">

# HumanWire

Ask your AI agent to match you with someone new.

<p>
  <a href="https://github.com/DeepLeap/humanwire/releases"><img src="https://img.shields.io/github/v/release/DeepLeap/humanwire?style=flat-square" alt="GitHub release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0D0D0D?style=flat-square&labelColor=0D0D0D&color=F2F5F1" alt="MIT License" /></a>
</p>

<p><b>English</b> | <a href="./README.zh-CN.md">简体中文</a></p>

</div>

Tell your AI agent, “Find someone else who’s into Blender.” With HumanWire, a compatible MCP client can start a one-on-one match with someone online who shares your interests. Once connected, chat directly with the other person in the local window. You can also start a match from the window, with shared-interest keywords or with no keywords for casual chat.

## Find a match

Use the GitHub source for this quick start. It requires **Node.js 22 or later**.

```sh
git clone https://github.com/DeepLeap/humanwire.git
cd humanwire
npm run chat
```

1. Open the local link printed in your terminal.
2. Enter a nickname and up to five public keywords, such as `blender, 3d animation`. Leave keywords blank for casual chat.
3. Click **开始匹配** (start matching). When you connect, type in the chat window and press Enter. Click **结束** (end) to leave.

HumanWire normalizes case, spacing, and common full-width characters. In keyword mode, both sides must be searching and have at least one normalized keyword in common. For example, `Blender, 3D animation` can match `blender, motion design`. Matching uses keyword overlap; availability depends on other people being online. You can ask an AI to suggest keywords from your public interests before you search.

## Start a match from your AI client

Configure HumanWire as a local stdio MCP server. Replace the script path with the absolute path from your checkout:

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

Ask your AI to find someone who wants to talk about a topic and open the HumanWire window. It can call `start_matching` with a comma-separated `keywords` string, then `open_chat_window`. The window uses the same session and keeps message text out of the model context. It can receive replies while the AI is idle as long as the local MCP process stays running. Desktop unread notifications and on-device translation depend on browser support and permissions.

To use the host's native AI transcript, omit `--chat-window`. In that mode, the host calls `poll_messages` to fetch new messages, waiting up to 25 seconds per call. Replies arrive in the transcript when the host calls the tool. An inline chat card is an integration option for hosts with independent UI support. See the [host integration guide](./docs/INTEGRATION.md) and [agent workflow](./SKILL.md).

These examples use the GitHub source for v0.5.1. Check the version on [npm](https://www.npmjs.com/package/humanwire-mcp) before using keyword matching or `--chat-window` with a registry install.

## Invite a friend or visit the plaza

- **Room code**. Choose the room option in the chat window or call `join_room` through MCP. Create a code to share with a friend, or enter a code someone sent you.
- **Public plaza**. In native MCP mode, `join_plaza` opens a public topic board. Nostr relays can supply recent posts within a 24-hour window, subject to relay availability. Treat posts as public.

## Network and privacy

HumanWire uses the Node.js standard library for its default relay mode. Private chats are encrypted over public Nostr relays. Relay operators can still see connection metadata, including the incoming IP address, or the proxy exit IP if you connect through a proxy. A nickname and handshake establish a connection, with no real-world identity verification.

- **Proxy**. Add `--proxy socks5h://127.0.0.1:9050` or `--proxy http://127.0.0.1:7890` to the MCP launch arguments if you have a compatible local proxy. `socks5h` resolves relay hostnames remotely.
- **Direct P2P**. With the optional `hyperswarm` dependency available, `--transport p2p --allow-ip-exposure` enables direct connections. Peers may see your public IP and port. Keep the default relay mode if you prefer to avoid direct IP exposure to strangers.
- **Peer content**. Treat incoming text, links, and images as untrusted. Text filters cover common credentials and sensitive patterns. The native MCP path labels incoming text as untrusted. In that mode, incoming images stay in memory until requested through `inspect_image`.

## MCP tools

| Tool | What it does |
| :--- | :--- |
| `start_matching` | Start stranger matchmaking with 1–5 comma-separated `keywords`. If omitted, the server matches by exact `channel`, which defaults to `chat/casual`. |
| `open_chat_window` | Open the window for the active session in `--chat-window` mode. |
| `join_room` | Create or join an encrypted room using a shared room code. |
| `get_status` / `leave_chat` | Check status or leave the active session. |
| `poll_messages` / `send_to_peer` | Fetch and send text in native MCP mode. Sending supports optional `auto_sanitize`. |
| `join_plaza` | Join the public plaza in native MCP mode. |
| `send_image_file` / `inspect_image` | Send PNG, JPEG, or WebP, or inspect an image held in memory, in native MCP mode. |
| `issue_vouch` | Give a peer a signed vouch in native MCP mode. |

## Development

Run `npm test` in the repository. See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for implementation details and [INTEGRATION.md](./docs/INTEGRATION.md) for host adaptation.

## License

MIT © [YUKE · DeepLeap](https://github.com/DeepLeap) ([dangiakodi@gmail.com](mailto:dangiakodi@gmail.com))
